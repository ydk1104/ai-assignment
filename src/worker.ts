import { NestFactory } from '@nestjs/core';
import { WorkerModule } from './worker/worker.module';

// HTTP 서버 없이 Nest 컨텍스트만 띄운다. BullMQ Worker(Redis 연결)가 프로세스를 유지한다.
async function bootstrap() {
  const app = await NestFactory.createApplicationContext(WorkerModule);
  app.enableShutdownHooks(); // docker stop(SIGTERM) 시 진행 중인 job을 마무리하고 종료
}
bootstrap();
