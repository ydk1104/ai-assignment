import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { Redis } from 'ioredis';
import { redisConnection } from '../common/redis-options';

@Injectable()
export class RedisService implements OnModuleDestroy {
  private readonly logger = new Logger(RedisService.name);
  readonly client = new Redis(redisConnection());

  constructor() {
    this.client.on('error', (err) => this.logger.error(`redis error: ${err.message}`));
  }

  async onModuleDestroy() {
    await this.client.quit();
  }
}
