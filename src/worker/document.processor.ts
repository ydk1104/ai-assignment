import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from "@nestjs/common";
import { Job, Worker } from "bullmq";
import { hostname } from "os";
import { createRng, parseSeed } from "../common/random";
import { redisConnection } from "../common/redis-options";
import {
  CreateDocumentJob,
  DOCUMENT_QUEUE,
  MAX_STALLED_COUNT,
  STALLED_CHECK_INTERVAL_MS,
  WORKER_LOCK_DURATION_MS,
} from "../documents/document-job";
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
      {
        connection: redisConnection(),
        concurrency,
        // 워커가 죽으면 락이 풀리고, 다른 워커가 그 job을 큐에 되돌려 다시 처리한다
        lockDuration: WORKER_LOCK_DURATION_MS,
        stalledInterval: STALLED_CHECK_INTERVAL_MS,
        maxStalledCount: MAX_STALLED_COUNT,
      },
    );
    this.worker.on("error", (err) =>
      this.logger.error(`worker error: ${err.message}`),
    );
    this.worker.on("failed", (job, err) => {
      this.logger.warn(`job ${job?.id} failed: ${err.message}`);
      // stalled 한도를 넘겨 실패한 job은 처리하던 워커가 이미 죽어서 메모를 못 지웠으므로 여기서 정리한다.
      // 자기 메모일 때만 지워지므로, 이미 정리됐거나 새 요청이 잡은 메모에는 영향이 없다.
      if (job) {
        const { userId, idempotencyKey, lockValue } = job.data;
        void this.locks
          .release(userId, idempotencyKey, lockValue)
          .catch(() => undefined);
      }
    });

    const delay = process.env.NODE_ENV === "production" ? "20~80ms" : "10ms";
    this.logger.log(
      `[${hostname()}] worker started (NODE_ENV=${process.env.NODE_ENV ?? "unset"}, token delay=${delay}, concurrency=${concurrency})`,
    );
  }

  async onModuleDestroy() {
    await this.worker?.close(); // 진행 중인 job이 끝나길 기다린 뒤 종료
  }

  private async handleJob(job: DocumentJob): Promise<{ tokens: number }> {
    const { userId, idempotencyKey, requestHash, maxTokens, lockValue } =
      job.data;
    this.logger.log(
      `[${hostname()}] job ${job.id} started (userId=${userId}, maxTokens=${maxTokens})`,
    );

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
      // 이전 워커가 원장까지 기록하고 죽었다면(job 완료 처리만 못 한 경우) 다시 생성하지 않는다
      const already = await this.ledger.find(userId, idempotencyKey);
      if (already) {
        this.logger.log(
          `job ${job.id} skipped: already recorded (${already.tokens} tokens)`,
        );
        return { tokens: already.tokens };
      }

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
        `[${hostname()}] job ${job.id} done: ${result.tokens} tokens (userId=${userId})`,
      );
      return { tokens: result.tokens };
    } finally {
      // 정상 종료/에러 모두 메모 삭제. 원장 기록 이후에 지우므로, 메모가 없으면 원장에는 결과가 있다.
      // 에러로 끝난 경우엔 메모가 지워져서 같은 Idempotency-Key로 다시 요청할 수 있다.
      // (워커 프로세스가 죽은 경우엔 이 코드가 실행되지 않으므로 메모가 남고, 다른 워커가 job을 이어받는다)
      await this.locks
        .release(userId, idempotencyKey, lockValue)
        .catch((err) =>
          this.logger.warn(`failed to release lock: ${(err as Error).message}`),
        );
    }
  }
}
