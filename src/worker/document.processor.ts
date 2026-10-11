import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from "@nestjs/common";
import { Job, Worker } from "bullmq";
import { createRng, parseSeed } from "../common/random";
import { redisConnection } from "../common/redis-options";
import { CreateDocumentJob, DOCUMENT_QUEUE } from "../documents/document-job";
import { IdempotencyLockService } from "../documents/idempotency-lock.service";
import { createDelay, generateTokens } from "../documents/token-generator";
import { TokenLedgerService } from "../documents/token-ledger.service";

const PROGRESS_INTERVAL_MS = 100; // 진행 상황/메모 연장은 이 간격으로만 (토큰마다 Redis를 치지 않도록)

const sleep = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));

type DocumentJob = Job<CreateDocumentJob, { tokens: number }>;

@Injectable()
export class DocumentProcessor implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(DocumentProcessor.name);
  // RANDOM_SEED가 있으면 고정 seed, 없으면 job마다 시간 기반. 잘못된 값이면 시작 시 바로 에러
  private readonly seed = parseSeed(process.env.RANDOM_SEED);
  private worker?: Worker<CreateDocumentJob, { tokens: number }>;

  constructor(
    private readonly ledger: TokenLedgerService,
    private readonly locks: IdempotencyLockService,
  ) {}

  onModuleInit() {
    const concurrency = Number(process.env.WORKER_CONCURRENCY ?? 5);
    this.worker = new Worker<CreateDocumentJob, { tokens: number }>(
      DOCUMENT_QUEUE,
      (job) => this.handleJob(job),
      { connection: redisConnection(), concurrency },
    );
    this.worker.on("error", (err) =>
      this.logger.error(`worker error: ${err.message}`),
    );
    this.worker.on("failed", (job, err) =>
      this.logger.warn(`job ${job?.id} failed: ${err.message}`),
    );

    const delay = process.env.NODE_ENV === "production" ? "20~80ms" : "10ms";
    this.logger.log(
      `worker started (NODE_ENV=${process.env.NODE_ENV ?? "unset"}, token delay=${delay}, concurrency=${concurrency})`,
    );
  }

  async onModuleDestroy() {
    await this.worker?.close(); // 진행 중인 job이 끝나길 기다린 뒤 종료
  }

  private async handleJob(job: DocumentJob): Promise<{ tokens: number }> {
    const { userId, idempotencyKey, requestHash, maxTokens, lockValue } =
      job.data;
    const rng = createRng(this.seed);
    let lastReportAt = 0;

    // 진행 상황 전달 + "생성 중" 메모 연장. 실패해도 생성 자체는 계속한다
    const report = async (generated: number, force = false) => {
      const now = Date.now();
      if (!force && now - lastReportAt < PROGRESS_INTERVAL_MS) return;
      lastReportAt = now;
      try {
        await Promise.all([
          job.updateProgress(generated),
          this.locks.refresh(userId, idempotencyKey, lockValue),
        ]);
      } catch (err) {
        this.logger.warn(
          `progress report failed (job ${job.id}): ${(err as Error).message}`,
        );
      }
    };

    try {
      const tokens = await generateTokens({
        maxTokens,
        rng,
        delay: createDelay(rng),
        sleep,
        onProgress: (generated) => report(generated),
      });
      await report(tokens, true);

      // 성공했을 때만 원장/합계에 반영 (이미 반영돼 있으면 중복 없이 저장된 값을 돌려줌)
      const result = await this.ledger.record({
        userId,
        idempotencyKey,
        requestHash,
        maxTokens,
        tokens,
      });
      this.logger.log(
        `job ${job.id} done: ${result.tokens} tokens (userId=${userId})`,
      );
      return { tokens: result.tokens };
    } finally {
      // 성공/실패 모두 메모 삭제. 원장 기록 이후에 지우므로, 메모가 없으면 원장에는 결과가 있다.
      // 실패한 경우엔 메모가 지워져서 같은 Idempotency-Key로 다시 요청할 수 있다.
      await this.locks
        .release(userId, idempotencyKey, lockValue)
        .catch((err) =>
          this.logger.warn(`failed to release lock: ${(err as Error).message}`),
        );
    }
  }
}
