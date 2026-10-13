import { Module } from "@nestjs/common";
import { CreditController } from "../credits/credit.controller";
import { CreditsModule } from "../credits/credits.module";
import { DatabaseModule } from "../database/database.module";
import { RedisModule } from "../redis/redis.module";
import { CancelDocumentController } from "./cancel-document.controller";
import { DocumentQueueService } from "./document-queue.service";
import { DocumentsController } from "./documents.controller";
import { IdempotencyLockService } from "./idempotency-lock.service";
import { TokenLedgerService } from "./token-ledger.service";

@Module({
  imports: [DatabaseModule, RedisModule, CreditsModule],
  controllers: [
    DocumentsController,
    CancelDocumentController,
    CreditController,
  ],
  providers: [TokenLedgerService, IdempotencyLockService, DocumentQueueService],
})
export class DocumentsModule {}
