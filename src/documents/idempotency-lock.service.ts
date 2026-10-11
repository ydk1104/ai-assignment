import { Injectable } from '@nestjs/common';
import { RedisService } from '../redis/redis.service';
import { LockValue, parseLockValue } from './document-job';

/**
 * 같은 Idempotency-Key로 이미 생성 중인지 Redis에 메모해두는 용도.
 * API 서버가 여러 대여도 Redis 한 곳에서 판단하므로, 서로 다른 서버로 같은 요청이 들어와도 한 번만 생성된다.
 *
 * 메모에는 TTL을 걸고 워커가 생성 중에 계속 연장(heartbeat)한다.
 * 워커가 죽으면 TTL이 지나 메모가 사라지므로 영원히 "처리중"으로 남지 않는다.
 */
const LOCK_TTL_MS = 30_000;

// 내가 만든 메모일 때만 삭제 / 연장 (값 비교와 삭제를 원자적으로 처리)
const RELEASE_LUA = `
if redis.call('get', KEYS[1]) == ARGV[1] then
  return redis.call('del', KEYS[1])
end
return 0`;

const REFRESH_LUA = `
if redis.call('get', KEYS[1]) == ARGV[1] then
  return redis.call('pexpire', KEYS[1], ARGV[2])
end
return 0`;

@Injectable()
export class IdempotencyLockService {
  constructor(private readonly redis: RedisService) {}

  /** userId/key에 ':' 같은 문자가 있어도 서로 다른 조합이 같은 키가 되지 않도록 인코딩 */
  private redisKey(userId: string, idempotencyKey: string): string {
    return `idem:${encodeURIComponent(userId)}:${encodeURIComponent(idempotencyKey)}`;
  }

  /** 메모 남기기 (이미 있으면 false) */
  async acquire(userId: string, idempotencyKey: string, value: string): Promise<boolean> {
    const result = await this.redis.client.set(
      this.redisKey(userId, idempotencyKey),
      value,
      'PX',
      LOCK_TTL_MS,
      'NX',
    );
    return result === 'OK';
  }

  async get(userId: string, idempotencyKey: string): Promise<LockValue | null> {
    return parseLockValue(await this.redis.client.get(this.redisKey(userId, idempotencyKey)));
  }

  /** 내 메모일 때만 TTL 연장 */
  async refresh(userId: string, idempotencyKey: string, value: string): Promise<boolean> {
    const result = await this.redis.client.eval(
      REFRESH_LUA,
      1,
      this.redisKey(userId, idempotencyKey),
      value,
      String(LOCK_TTL_MS),
    );
    return Number(result) === 1;
  }

  /** 내 메모일 때만 삭제 */
  async release(userId: string, idempotencyKey: string, value: string): Promise<boolean> {
    const result = await this.redis.client.eval(
      RELEASE_LUA,
      1,
      this.redisKey(userId, idempotencyKey),
      value,
    );
    return Number(result) === 1;
  }
}
