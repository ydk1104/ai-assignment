import { Module } from "@nestjs/common";
import { DocumentsModule } from "./documents/documents.module";
import { StatusController } from "./status.controller";

@Module({
  imports: [DocumentsModule],
  controllers: [StatusController],
})
export class AppModule {}
