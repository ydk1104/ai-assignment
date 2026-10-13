import {
  BadRequestException,
  Body,
  Controller,
  NotFoundException,
  Post,
  Res,
} from "@nestjs/common";
import type { Response } from "express";
import { CancelDocumentDto } from "./cancel-document.dto";
import { isHeldLockInFlight } from "./document-job";
import { DocumentQueueService } from "./document-queue.service";
import { IdempotencyLockService } from "./idempotency-lock.service";
import { StoredResult, TokenLedgerService } from "./token-ledger.service";

const NOTHING_TO_CANCEL = "취소할 생성 작업이 없습니다.";
const WAIT_MS = 5_000; // 워커가 멈추고 기록할 때까지 응답을 붙들고 기다리는 최대 시간
const POLL_MS = 100;

const sleep = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * POST /cancel_document  { userId, idempotencyKey }
 *
 * 생성 중인 작업을 취소한다. 취소 시점까지 만든 토큰만큼만 확정(과금)하고, 완료된 것처럼 처리한다.
 *  - 200 { status: 'cancelled', tokens, cancelled: true } : 취소 시점의 개수로 확정됨
 *  - 200 { status: 'completed', tokens, cancelled: false }: 취소가 닿기 전에 이미 끝남 (그대로 완료)
 *  - 202 { status: 'cancelling' }                         : 취소를 요청했지만 아직 마무리 안 됨 (잠시 후 같은 요청을 다시 호출)
 *  - 404                                                  : 취소할 작업이 없음 (없거나, 실패해서 끝남)
 * 여러 번 호출해도 같은 결과다. 취소된 요청의 Idempotency-Key로 다시 생성 요청을 보내면 새로 만들지 않고
 * 취소된 결과가 그대로 재생된다. 다시 생성하려면 새 Idempotency-Key를 써야 한다.
 */
@Controller("cancel_document")
export class CancelDocumentController {
  constructor(
    private readonly ledger: TokenLedgerService,
    private readonly locks: IdempotencyLockService,
    private readonly queue: DocumentQueueService,
  ) {}

  @Post()
  async cancel(@Body() dto: CancelDocumentDto, @Res() res: Response) {
    const userId = dto.userId;
    const key = dto.idempotencyKey.trim();
    if (!key) throw new BadRequestException("idempotencyKey must not be blank");

    // 1) 이미 끝났으면(완료 또는 이전 취소) 저장된 결과를 그대로 알려준다
    const finished = await this.ledger.find(userId, key);
    if (finished) return this.respond(res, finished);

    // 2) 생성 중인 작업 찾기 (Redis 메모 + job이 실제로 살아있는지)
    const held = await this.locks.get(userId, key);
    if (!held) throw new NotFoundException(NOTHING_TO_CANCEL);
    const state = await this.queue.getJobState(held.jobId);
    if (!isHeldLockInFlight(state, held.createdAt))
      throw new NotFoundException(NOTHING_TO_CANCEL);

    // 3) "취소 요청 시점의 진행 개수"를 표시한다. 워커는 거기서 멈춰 그 개수로 확정한다.
    //    아직 시작 전이면 0이라서, 시작하자마자 0개로 확정된다.
    const atTokens = await this.queue.getJobProgress(held.jobId);
    await this.locks.requestCancel(held.jobId, atTokens);

    // 4) 워커가 멈추고 DB에 기록할 때까지 잠시 기다린다
    const result = await this.waitForResult(userId, key, held.jobId);
    if (result === "gone") throw new NotFoundException(NOTHING_TO_CANCEL);
    if (result) return this.respond(res, result);

    return res.status(202).json({ status: "cancelling" });
  }

  private respond(res: Response, stored: StoredResult) {
    return res.status(200).json({
      status: stored.cancelled ? "cancelled" : "completed",
      tokens: stored.tokens,
      cancelled: stored.cancelled,
    });
  }

  /** 결과가 기록되길 기다린다. 못 기다리면 null, 그 사이 작업이 실패해서 사라졌으면 'gone' */
  private async waitForResult(
    userId: string,
    key: string,
    jobId: string,
  ): Promise<StoredResult | "gone" | null> {
    const deadline = Date.now() + WAIT_MS;
    while (Date.now() < deadline) {
      const stored = await this.ledger.find(userId, key);
      if (stored) return stored;

      const held = await this.locks.get(userId, key);
      if (!held || held.jobId !== jobId) {
        // 메모가 사라졌다. 워커는 "원장 기록 -> 메모 삭제" 순서라서, 원장에 있으면 완료된 것이고 없으면 실패한 것이다.
        return (await this.ledger.find(userId, key)) ?? "gone";
      }
      await sleep(POLL_MS);
    }
    return null;
  }
}
