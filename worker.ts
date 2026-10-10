import { Logger, Module } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";

@Module({})
class WorkerModule {}

async function bootstrap() {
  const app = await NestFactory.createApplicationContext(WorkerModule);
  app.enableShutdownHooks();
  const logger = new Logger("Worker");
  logger.log("worker started (placeholder - BullMQ Worker는 여기에 추가)");
  // 프로세스 유지용. BullMQ Worker를 붙이면 이 줄은 삭제
  setInterval(() => {}, 1 << 30);
}
bootstrap();
