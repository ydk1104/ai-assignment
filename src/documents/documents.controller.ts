import {
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  Headers,
  HttpException,
  HttpStatus,
  Logger,
  Post,
  Res,
  ServiceUnavailableException,
  UnprocessableEntityException,
} from "@nestjs/common";
import type { Response } from "express";
import { createHash, randomUUID } from "crypto";
import { parseSeed } from "../common/random";
import {
  INSUFFICIENT_CREDIT_MESSAGE,
  InsufficientCreditError,
} from "../credits/credit-math";
import { CreditService } from "../credits/credit.service";
import { CreateDocumentDto } from "./create-document.dto";
import {
  TOKEN_CREATE_FAIL,
  isHeldLockInFlight,
  lockValueOf,
} from "./document-job";
import { DocumentQueueService } from "./document-queue.service";
import { IdempotencyLockService } from "./idempotency-lock.service";
import { parseLastEventId } from "./token-count";
import { StoredResult, TokenLedgerService } from "./token-ledger.service";

const KEEPALIVE_MS = 15_000; // 조용한 동안 nginx/프록시가 연결을 끊지 않도록 보내는 주석 라인 간격
const STALL_TIMEOUT_MS = 30_000; // 워커가 시작한 뒤 이 시간 동안 진행 소식이 없으면 중단된 것으로 본다
const PAGE_SIZE = 1000; // DB에서 저장된 토큰을 읽을 때 한 번에 가져오는 개수

const DIFFERENT_BODY_MESSAGE =
  "Idempotency-Key was already used with a different request body";

/**
 * 토큰 하나를 SSE 이벤트 하나로 보낸다.
 *  id    : 토큰 번호(1부터). 재연결 시 Last-Event-ID 로 돌아오고, 그 다음 번호부터 이어서 보낸다
 *  tokens: 지금까지 보낸 누적 개수 (= 토큰 번호)
 *  token : 이 토큰의 내용
 */
const tokenEvent = (index: number, token: string) =>
  `id: ${index}\ndata: ${JSON.stringify({ tokens: index, token })}\n\n`;
/** cancelled: 취소로 끝난 경우 true (그때까지 만든 tokens개만 확정됨) */
const doneEvent = (tokens: number, cancelled: boolean) =>
  `id: ${tokens}\nevent: done\ndata: ${JSON.stringify({ tokens, cancelled })}\n\n`;
const errorEvent = (error: string, tokens: number) =>
  `event: error\ndata: ${JSON.stringify({ error, tokens })}\n\n`;

@Controller("create_document")
export class DocumentsController {
  private readonly logger = new Logger(DocumentsController.name);

  // RANDOM_SEED가 있으면 고정 seed, 없으면 요청마다 시간 기반. 잘못된 값이면 서버 시작 시 바로 에러
  private readonly fixedSeed = parseSeed(process.env.RANDOM_SEED);

  constructor(
    private readonly ledger: TokenLedgerService,
    private readonly locks: IdempotencyLockService,
    private readonly queue: DocumentQueueService,
    private readonly credits: CreditService,
  ) {}

  @Post()
  async create(
    @Body() dto: CreateDocumentDto,
    @Headers("idempotency-key") idempotencyKey: string | undefined,
    @Headers("last-event-id") lastEventId: string | undefined,
    @Res() res: Response,
  ) {
    const key = idempotencyKey?.trim();
    if (!key || key.length > 255) {
      throw new BadRequestException(
        "Idempotency-Key header is required (max 255 chars)",
      );
    }
    const requestHash = createHash("sha256")
      .update(JSON.stringify([dto.prompt, dto.maxTokens]))
      .digest("hex");

    // 1) 이미 끝난 요청이면 DB에 저장된 결과를 다시 보내준다 (Last-Event-ID 다음 토큰부터)
    const stored = await this.ledger.find(dto.userId, key);
    if (stored) return this.replay(res, stored, requestHash, lastEventId);

    // 2) 생성 중이라는 메모를 Redis에 남긴다. 이미 있으면 "처리중입니다."
    const jobId = randomUUID();
    const lockValue = lockValueOf(jobId, requestHash);
    await this.acquireOrReject(res, dto.userId, key, lockValue, requestHash);

    let live: { cancel: () => void; done: Promise<void> } | undefined;
    try {
      // 3) 메모를 잡는 사이에 다른 서버가 막 끝냈을 수 있으니 원장을 한 번 더 확인한다
      //    (워커는 원장 기록 -> 메모 삭제 순서로 끝내므로, 메모를 잡았다면 원장은 이미 보인다)
      const finished = await this.ledger.find(dto.userId, key);
      if (finished) {
        await this.locks.release(dto.userId, key, lockValue);
        return this.replay(res, finished, requestHash, lastEventId);
      }

      // 4) 크레딧 예약: maxTokens 만큼 잡아둔다. 실제로 쓸 수 있는 잔액(잔액 - 예약)이 모자라면 402.
      //    예약은 유저별로 한 줄씩 처리되므로, 같은 유저가 동시에 여러 번 요청해도 크레딧이 음수가 되지 않는다.
      await this.reserveCredit(dto.userId, key, jobId, dto.maxTokens);

      // 5) 이벤트 구독 -> 큐에 넣기 -> SSE 시작
      this.setSseHeaders(res);
      live = this.attach(res, jobId, dto.userId, key);
      await this.queue.enqueue(jobId, {
        userId: dto.userId,
        idempotencyKey: key,
        requestHash,
        maxTokens: dto.maxTokens,
        lockValue,
        // 한 번 정한 seed를 job에 담아서, 워커가 바뀌어 다시 만들어도 같은 토큰이 만들어지게 한다
        seed: this.fixedSeed ?? Date.now(),
      });
    } catch (err) {
      live?.cancel();
      await this.credits.release(jobId).catch(() => undefined); // 예약했다면 푼다 (예약 전에 실패했으면 아무 일도 없음)
      await this.locks
        .release(dto.userId, key, lockValue)
        .catch(() => undefined);
      if (err instanceof HttpException) throw err;
      this.logger.error(
        `failed to enqueue job ${jobId}: ${(err as Error).message}`,
      );
      throw new ServiceUnavailableException("Could not start generation");
    }

    res.flushHeaders();
    await live.done;
  }

  private async reserveCredit(
    userId: string,
    key: string,
    jobId: string,
    maxTokens: number,
  ) {
    try {
      await this.credits.reserve(userId, key, jobId, maxTokens);
    } catch (err) {
      if (err instanceof InsufficientCreditError) {
        throw new HttpException(
          INSUFFICIENT_CREDIT_MESSAGE,
          HttpStatus.PAYMENT_REQUIRED,
        );
      }
      throw err;
    }
  }

  /** 메모를 남기거나, 이미 있으면 상황에 맞게 거절한다 */
  private async acquireOrReject(
    res: Response,
    userId: string,
    key: string,
    lockValue: string,
    requestHash: string,
  ): Promise<void> {
    for (let attempt = 0; attempt < 3; attempt++) {
      if (await this.locks.acquire(userId, key, lockValue)) return;

      const held = await this.locks.get(userId, key);
      if (!held) continue; // 확인하는 사이에 메모가 사라졌다면 다시 시도
      if (held.requestHash !== requestHash) {
        throw new UnprocessableEntityException(DIFFERENT_BODY_MESSAGE);
      }

      // 메모가 있어도 그 job이 실제로 살아있는지 확인한다.
      // (워커가 죽어서 복구를 기다리는 중이면 waiting/active 이므로 계속 "처리중")
      const state = await this.queue.getJobState(held.jobId);
      if (isHeldLockInFlight(state, held.createdAt)) break;

      // job은 끝났거나 사라졌는데 메모만 남은 경우 -> 지우고 다시 시도
      this.logger.warn(
        `clearing stale idempotency memo (job ${held.jobId}, state=${state ?? "missing"})`,
      );
      await this.locks.release(userId, key, held.raw);
    }
    res.setHeader("Retry-After", "1");
    throw new ConflictException("처리중입니다.");
  }

  private setSseHeaders(res: Response) {
    res.status(200);
    res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
    res.setHeader("Cache-Control", "no-cache, no-transform");
    res.setHeader("X-Accel-Buffering", "no"); // nginx가 버퍼링하지 않도록
  }

  /** 쓰기 버퍼가 가득 찼으면 비워질 때까지(또는 연결이 끊길 때까지) 기다린다 */
  private async write(res: Response, chunk: string): Promise<void> {
    if (res.destroyed || res.writableEnded) return;
    if (res.write(chunk)) return;
    await new Promise<void>((resolve) => {
      const wake = () => {
        res.off("drain", wake);
        res.off("close", wake);
        resolve();
      };
      res.once("drain", wake);
      res.once("close", wake);
    });
  }

  /**
   * DB에 저장된 토큰을 after(번호) 다음부터 끝까지 한 토큰씩 보낸다.
   * 마지막으로 보낸 토큰 번호를 돌려준다 (연결이 끊기면 거기까지).
   */
  private async streamStored(
    res: Response,
    ledgerId: string,
    after: number,
  ): Promise<number> {
    let cursor = after;
    for (;;) {
      const rows = await this.ledger.findTokens(ledgerId, cursor, PAGE_SIZE);
      for (const row of rows) {
        if (res.destroyed || res.writableEnded) return cursor;
        await this.write(res, tokenEvent(row.position, row.content));
        cursor = row.position;
      }
      if (rows.length < PAGE_SIZE) return cursor;
    }
  }

  /** 이미 완료된 결과를 다시 보낸다. 워커가 죽었든 말았든 DB에 저장된 같은 내용이 나간다 */
  private async replay(
    res: Response,
    stored: StoredResult,
    requestHash: string,
    lastEventId: string | undefined,
  ) {
    if (stored.requestHash !== requestHash) {
      throw new UnprocessableEntityException(DIFFERENT_BODY_MESSAGE);
    }
    this.setSseHeaders(res);
    res.setHeader("Idempotent-Replayed", "true");
    res.flushHeaders();
    res.on("error", () => undefined);

    await this.streamStored(res, stored.id, parseLastEventId(lastEventId));
    if (!res.destroyed && !res.writableEnded) {
      res.write(doneEvent(stored.tokens, stored.cancelled));
      res.end();
    }
  }

  /**
   * 워커가 만드는 중인 job의 토큰을 이 응답(SSE)으로 한 토큰씩 흘려보낸다.
   * 클라이언트 연결이 끊겨도 job은 워커에서 계속 진행된다. 여기서는 구독만 해제한다.
   *
   * 실시간 전달은 "빠르게 보여주기 위한 것"이고, 최종 결과의 기준은 DB다.
   * 실시간 이벤트가 중복(워커 교체 후 재전송)이거나 유실돼도, 완료 시점에 DB에서 빠진 토큰을 보충하므로
   * 클라이언트는 항상 1번부터 마지막까지 빠짐없이 순서대로 받는다.
   */
  private attach(res: Response, jobId: string, userId: string, key: string) {
    let lastSent = 0; // 클라이언트에 보낸 마지막 토큰 번호
    let settled = false;
    let closed = false;
    let stallTimer: NodeJS.Timeout | undefined;
    let unsubscribe: () => void = () => undefined;
    let resolveDone: () => void = () => undefined;
    const done = new Promise<void>((resolve) => {
      resolveDone = resolve;
    });

    const writeNow = (chunk: string) => {
      if (closed || res.writableEnded || res.destroyed) return;
      res.write(chunk);
    };
    const keepAlive = setInterval(
      () => writeNow(": keepalive\n\n"),
      KEEPALIVE_MS,
    );

    const teardown = () => {
      settled = true;
      clearInterval(keepAlive);
      if (stallTimer) clearTimeout(stallTimer);
      unsubscribe();
    };
    const settle = (finalChunk?: string) => {
      if (settled) return;
      teardown();
      if (finalChunk) writeNow(finalChunk);
      if (!closed && !res.writableEnded) res.end();
      resolveDone();
    };
    const armStall = () => {
      if (stallTimer) clearTimeout(stallTimer);
      stallTimer = setTimeout(
        () => settle(errorEvent("generation_stalled", lastSent)),
        STALL_TIMEOUT_MS,
      );
    };
    const complete = async () => {
      if (stallTimer) clearTimeout(stallTimer);
      try {
        const stored = await this.ledger.find(userId, key);
        if (!stored) {
          settle(errorEvent("internal_error", lastSent));
          return;
        }
        // 실시간으로 못 받은 토큰이 있으면 DB에서 보충
        lastSent = await this.streamStored(res, stored.id, lastSent);
        settle(doneEvent(stored.tokens, stored.cancelled));
      } catch (err) {
        this.logger.error(
          `failed to read result of job ${jobId}: ${(err as Error).message}`,
        );
        settle(errorEvent("internal_error", lastSent));
      }
    };

    res.on("error", () => undefined);
    res.on("close", () => {
      if (settled) return; // 우리가 정상 종료한 뒤에 오는 close
      closed = true;
      this.logger.log(
        `client disconnected (job ${jobId}); generation continues in worker`,
      );
      settle();
    });

    unsubscribe = this.queue.subscribe(jobId, {
      onActive: armStall,
      onToken: (index, token) => {
        armStall();
        // 다음 번호가 아니면 건너뛴다. 이미 보낸 번호면 워커 교체 후 재전송이고,
        // 번호가 비면 유실이므로 완료 시점에 DB에서 채운다.
        if (index !== lastSent + 1) return;
        lastSent = index;
        writeNow(tokenEvent(index, token));
      },
      onCompleted: () => {
        void complete();
      },
      onFailed: (reason) => {
        // 의도한 에러만 이름 그대로 알려주고, 나머지는 내부 에러 내용을 숨긴다
        const error =
          reason === TOKEN_CREATE_FAIL ? TOKEN_CREATE_FAIL : "internal_error";
        settle(errorEvent(error, lastSent));
      },
    });

    return {
      // enqueue 실패 시: 구독/타이머만 정리 (응답은 호출한 쪽이 에러로 마무리)
      cancel: teardown,
      done,
    };
  }
}
