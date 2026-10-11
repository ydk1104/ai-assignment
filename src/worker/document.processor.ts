import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from "@nestjs/common";
import { Job, Worker } from "bullmq";
import { hostname } from "os";
import { createRng } from "../common/random";
import { redisConnection } from "../common/redis-options";
import {
  CreateDocumentJob,
  DOCUMENT_QUEUE,
  MAX_STALLED_COUNT,
  STALLED_CHECK_INTERVAL_MS,
  WORKER_LOCK_DURATION_MS,
} from "../documents/document-job";
import { IdempotencyLockService } from "../documents/idempotency-lock.service";
import {
  createContent,
  createDelay,
  generateTokens,
} from "../documents/token-generator";
import { TokenLedgerService } from "../documents/token-ledger.service";

const HEARTBEAT_INTERVAL_MS = 100; // "생성 중" 메모 연장은 이 간격으로만 (토큰마다 하지 않도록)

const sleep = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));

type DocumentJob = Job<CreateDocumentJob, { tokens: number }>;

@Injectable()
export class DocumentProcessor implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(DocumentProcessor.name);
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
    const { userId, idempotencyKey, requestHash, maxTokens, lockValue, seed } =
      job.data;
    this.logger.log(
      `[${hostname()}] job ${job.id} started (userId=${userId}, maxTokens=${maxTokens})`,
    );

    // job에 담긴 seed를 쓰므로, 워커가 바뀌어 처음부터 다시 만들어도 같은 토큰이 만들어진다
    const rng = createRng(seed);
    let lastBeatAt = 0;

    // 토큰이 하나 만들어질 때마다 API 서버로 전달 + 주기적으로 "생성 중" 메모 연장.
    // 전달에 실패해도 생성은 계속한다 (최종 결과는 DB에 저장되고 API 서버가 그걸로 보충한다)
    const onProgress = async (index: number, token: string) => {
      try {
        await job.updateProgress({ index, token });
        const now = Date.now();
        if (now - lastBeatAt >= HEARTBEAT_INTERVAL_MS) {
          lastBeatAt = now;
          await this.locks.refresh(userId, idempotencyKey, lockValue);
        }
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

      const contents = await generateTokens({
        maxTokens,
        rng,
        delay: createDelay(rng),
        content: createContent(rng),
        sleep,
        onProgress,
      });

      // 성공했을 때만 원장 + 토큰 내용 + 합계를 한 트랜잭션으로 저장
      // (이미 저장돼 있으면 중복 없이 저장된 값을 돌려줌)
      const result = await this.ledger.record({
        userId,
        idempotencyKey,
        requestHash,
        maxTokens,
        contents,
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
