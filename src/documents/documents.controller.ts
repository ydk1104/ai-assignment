import {
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  Headers,
  HttpException,
  Logger,
  Post,
  Res,
  ServiceUnavailableException,
  UnprocessableEntityException,
} from "@nestjs/common";
import type { Response } from "express";
import { createHash, randomUUID } from "crypto";
import { CreateDocumentDto } from "./create-document.dto";
import {
  TOKEN_CREATE_FAIL,
  isHeldLockInFlight,
  lockValueOf,
} from "./document-job";
import { DocumentQueueService } from "./document-queue.service";
import { IdempotencyLockService } from "./idempotency-lock.service";
import { parseLastEventId, streamPoints } from "./token-count";
import { TokenLedgerService } from "./token-ledger.service";

const KEEPALIVE_MS = 15_000; // 조용한 동안 nginx/프록시가 연결을 끊지 않도록 보내는 주석 라인 간격
const STALL_TIMEOUT_MS = 30_000; // 워커가 시작한 뒤 이 시간 동안 진행 소식이 없으면 중단된 것으로 본다

const DIFFERENT_BODY_MESSAGE =
  "Idempotency-Key was already used with a different request body";

const doneEvent = (tokens: number) =>
  `id: ${tokens}\nevent: done\ndata: ${JSON.stringify({ tokens })}\n\n`;
const errorEvent = (error: string, tokens: number) =>
  `event: error\ndata: ${JSON.stringify({ error, tokens })}\n\n`;

@Controller("create_document")
export class DocumentsController {
  private readonly logger = new Logger(DocumentsController.name);

  constructor(
    private readonly ledger: TokenLedgerService,
    private readonly locks: IdempotencyLockService,
    private readonly queue: DocumentQueueService,
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

    // 1) 이미 끝난 요청이면 저장된 결과를 다시 보내준다 (Last-Event-ID 이후부터)
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

      // 4) 이벤트 구독 -> 큐에 넣기 -> SSE 시작
      this.setSseHeaders(res);
      live = this.attach(res, jobId, dto.userId, key);
      await this.queue.enqueue(jobId, {
        userId: dto.userId,
        idempotencyKey: key,
        requestHash,
        maxTokens: dto.maxTokens,
        lockValue,
      });
    } catch (err) {
      live?.cancel();
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

  /** 이미 완료된 결과를 다시 보낸다. id는 누적 토큰 수라서 Last-Event-ID 다음부터 이어서 보낸다 */
  private replay(
    res: Response,
    stored: { tokens: number; requestHash: string },
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

    for (const sent of streamPoints(
      stored.tokens,
      parseLastEventId(lastEventId),
    )) {
      if (res.destroyed || res.writableEnded) return;
      res.write(`id: ${sent}\ndata: ${JSON.stringify({ tokens: sent })}\n\n`);
    }
    if (!res.destroyed && !res.writableEnded) {
      res.write(doneEvent(stored.tokens));
      res.end();
    }
  }

  /**
   * 워커가 만드는 중인 job의 진행 상황을 이 응답(SSE)으로 흘려보낸다.
   * 클라이언트 연결이 끊겨도 job은 워커에서 계속 진행된다. 여기서는 구독만 해제한다.
   */
  private attach(res: Response, jobId: string, userId: string, key: string) {
    let lastSent = 0;
    let settled = false;
    let closed = false;
    let stallTimer: NodeJS.Timeout | undefined;
    let unsubscribe: () => void = () => undefined;
    let resolveDone: () => void = () => undefined;
    const done = new Promise<void>((resolve) => {
      resolveDone = resolve;
    });

    const write = (chunk: string) => {
      if (closed || res.writableEnded || res.destroyed) return;
      res.write(chunk);
    };
    const keepAlive = setInterval(() => write(": keepalive\n\n"), KEEPALIVE_MS);

    const teardown = () => {
      settled = true;
      clearInterval(keepAlive);
      if (stallTimer) clearTimeout(stallTimer);
      unsubscribe();
    };
    const settle = (finalChunk?: string) => {
      if (settled) return;
      teardown();
      if (finalChunk) write(finalChunk);
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
      try {
        const stored = await this.ledger.find(userId, key);
        settle(doneEvent(stored?.tokens ?? lastSent));
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
      onProgress: (tokens) => {
        if (tokens > lastSent) {
          lastSent = tokens;
          write(`id: ${tokens}\ndata: ${JSON.stringify({ tokens })}\n\n`);
        }
        armStall();
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
