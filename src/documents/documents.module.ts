import { Module } from "@nestjs/common";
import { DatabaseModule } from "../database/database.module";
import { DocumentsController } from "./documents.controller";
import { TokenLedgerService } from "./token-ledger.service";

@Module({
  imports: [DatabaseModule],
  controllers: [DocumentsController],
  providers: [TokenLedgerService],
})
export class DocumentsModule {}
