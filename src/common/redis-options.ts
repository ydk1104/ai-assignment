/** BullMQ(Queue/Worker/QueueEvents)와 ioredis가 같이 쓰는 Redis 접속 정보 */
export function redisConnection() {
  return {
    host: process.env.REDIS_HOST ?? "localhost",
    port: Number(process.env.REDIS_PORT ?? 6379),
  };
}
