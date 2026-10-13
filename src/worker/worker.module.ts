import { Module } from "@nestjs/common";
import { CreditsModule } from "../credits/credits.module";
import { DatabaseModule } from "../database/database.module";
import { IdempotencyLockService } from "../documents/idempotency-lock.service";
import { TokenLedgerService } from "../documents/token-ledger.service";
import { RedisModule } from "../redis/redis.module";
import { DocumentProcessor } from "./document.processor";
import { ReservationSweeper } from "./reservation-sweeper";

@Module({
  imports: [DatabaseModule, RedisModule, CreditsModule],
  providers: [
    TokenLedgerService,
    IdempotencyLockService,
    DocumentProcessor,
    ReservationSweeper,
  ],
})
export class WorkerModule {}
