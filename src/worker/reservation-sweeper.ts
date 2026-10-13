import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from "@nestjs/common";
import { Queue } from "bullmq";
import { redisConnection } from "../common/redis-options";
import { CreditService } from "../credits/credit.service";
import { DOCUMENT_QUEUE, isHeldLockInFlight } from "../documents/document-job";

const SWEEP_INTERVAL_MS = Number(
  process.env.RESERVATION_SWEEP_INTERVAL_MS ?? 30_000,
);
const GRACE_MS = 60_000; // 예약한 뒤 이 시간이 지나야 정리 대상 (큐에 넣는 중인 예약을 건드리지 않도록)

/**
 * 정산도 해제도 안 된 채 남은 예약을 정리한다.
 * 예) API 서버가 예약만 하고 죽어서 job이 큐에 들어가지 못함 / job이 큐에서 사라짐.
 * job이 아직 처리될 예정(waiting/active 등)이면 건드리지 않는다. 오래 걸리는 생성의 예약은 그대로 유지된다.
 */
@Injectable()
export class ReservationSweeper implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(ReservationSweeper.name);
  private readonly queue = new Queue(DOCUMENT_QUEUE, {
    connection: redisConnection(),
  });
  private timer?: NodeJS.Timeout;
  private running = false;

  constructor(private readonly credits: CreditService) {}

  onModuleInit() {
    this.timer = setInterval(() => void this.sweep(), SWEEP_INTERVAL_MS);
  }

  async onModuleDestroy() {
    if (this.timer) clearInterval(this.timer);
    await this.queue.close();
  }

  async sweep(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      for (const reservation of await this.credits.findOpenReservations(
        GRACE_MS,
        100,
      )) {
        const job = await this.queue.getJob(reservation.jobId);
        const state = job ? await job.getState() : null;
        if (isHeldLockInFlight(state, reservation.createdAt)) continue; // 아직 살아있는 job

        if (await this.credits.release(reservation.jobId)) {
          this.logger.warn(
            `released stale credit reservation (job ${reservation.jobId}, state=${state ?? "missing"})`,
          );
        }
      }
    } catch (err) {
      this.logger.warn(`reservation sweep failed: ${(err as Error).message}`);
    } finally {
      this.running = false;
    }
  }
}
