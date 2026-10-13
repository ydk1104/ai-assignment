import { Injectable } from "@nestjs/common";
import { RedisService } from "../redis/redis.service";
import { HeldLock, parseLockValue } from "./document-job";

/**
 * 같은 Idempotency-Key로 이미 생성 중인지 Redis에 메모해두는 용도.
 * API 서버가 여러 대여도 Redis 한 곳에서 판단하므로, 서로 다른 서버로 같은 요청이 들어와도 한 번만 생성된다.
 *
 * "처리 중인지"의 기준은 TTL이 아니라 메모에 적힌 job의 실제 상태다 (isHeldLockInFlight).
 * 워커가 죽어서 다른 워커가 이어받기를 기다리는 동안에도 메모가 사라지면 안 되므로 TTL은 길게 잡고,
 * 워커가 생성 중에 계속 연장한다. TTL은 정리되지 않은 메모가 영원히 남지 않게 하는 마지막 안전장치다.
 */
const LOCK_TTL_MS = 60 * 60 * 1000;

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
  async acquire(
    userId: string,
    idempotencyKey: string,
    value: string,
  ): Promise<boolean> {
    const result = await this.redis.client.set(
      this.redisKey(userId, idempotencyKey),
      value,
      "PX",
      LOCK_TTL_MS,
      "NX",
    );
    return result === "OK";
  }

  async get(userId: string, idempotencyKey: string): Promise<HeldLock | null> {
    return parseLockValue(
      await this.redis.client.get(this.redisKey(userId, idempotencyKey)),
    );
  }

  /** 내 메모일 때만 TTL 연장 */
  async refresh(
    userId: string,
    idempotencyKey: string,
    value: string,
  ): Promise<boolean> {
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
  async release(
    userId: string,
    idempotencyKey: string,
    value: string,
  ): Promise<boolean> {
    const result = await this.redis.client.eval(
      RELEASE_LUA,
      1,
      this.redisKey(userId, idempotencyKey),
      value,
    );
    return Number(result) === 1;
  }

  // ---- 취소 요청 표시 ----
  // 키에 jobId가 들어가므로, 예전 job에 대한 취소 표시가 같은 Idempotency-Key로 다시 시작한 새 job에 영향을 주지 않는다.

  private cancelKey(jobId: string): string {
    return `cancel:${jobId}`;
  }

  /**
   * 이 job을 취소하라고 표시한다. atTokens는 취소를 요청한 시점에 보인 진행 개수다.
   * 이미 표시돼 있으면 처음 요청한 시점을 그대로 유지한다 (취소를 여러 번 호출해도 결과가 같다).
   */
  async requestCancel(jobId: string, atTokens: number): Promise<void> {
    await this.redis.client.set(
      this.cancelKey(jobId),
      String(atTokens),
      "PX",
      LOCK_TTL_MS,
      "NX",
    );
  }

  /** 취소가 요청됐으면 그 시점의 개수, 아니면 null */
  async getCancelAt(jobId: string): Promise<number | null> {
    const raw = await this.redis.client.get(this.cancelKey(jobId));
    if (raw === null) return null;
    const n = Number(raw);
    return Number.isInteger(n) && n >= 0 ? n : 0;
  }

  async clearCancel(jobId: string): Promise<void> {
    await this.redis.client.del(this.cancelKey(jobId));
  }
}
