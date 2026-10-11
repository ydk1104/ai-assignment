import { Module } from "@nestjs/common";
import { DatabaseModule } from "../database/database.module";
import { RedisModule } from "../redis/redis.module";
import { CancelDocumentController } from "./cancel-document.controller";
import { DocumentQueueService } from "./document-queue.service";
import { DocumentsController } from "./documents.controller";
import { IdempotencyLockService } from "./idempotency-lock.service";
import { TokenLedgerService } from "./token-ledger.service";

@Module({
  imports: [DatabaseModule, RedisModule],
  controllers: [DocumentsController, CancelDocumentController],
  providers: [TokenLedgerService, IdempotencyLockService, DocumentQueueService],
})
export class DocumentsModule {}
