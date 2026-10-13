import { Module } from "@nestjs/common";
import { DatabaseModule } from "../database/database.module";
import { CreditService } from "./credit.service";

@Module({
  imports: [DatabaseModule],
  providers: [CreditService],
  exports: [CreditService],
})
export class CreditsModule {}
