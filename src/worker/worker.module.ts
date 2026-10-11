import { Module } from "@nestjs/common";
import { IdempotencyLockService } from "../documents/idempotency-lock.service";
import { TokenLedgerService } from "../documents/token-ledger.service";
import { DatabaseModule } from "../database/database.module";
import { RedisModule } from "../redis/redis.module";
import { DocumentProcessor } from "./document.processor";

@Module({
  imports: [DatabaseModule, RedisModule],
  providers: [TokenLedgerService, IdempotencyLockService, DocumentProcessor],
})
export class WorkerModule {}
