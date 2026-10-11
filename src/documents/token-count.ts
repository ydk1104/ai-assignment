import { randomInt, type Rng } from "../common/random";

/** maxTokens의 30% ~ 100% 사이(양끝 포함)에서 정수 토큰 수를 고른다 */
export function pickTokenCount(maxTokens: number, rng: Rng): number {
  // 0.3 * maxTokens 는 부동소수점 오차가 생길 수 있어 정수 연산으로 올림 처리
  const min = Math.max(1, Math.ceil((maxTokens * 3) / 10));
  return randomInt(rng, min, maxTokens);
}

/** Last-Event-ID(= 마지막으로 받은 토큰 번호) 헤더 파싱. 없거나 올바르지 않으면 0(처음부터) */
export function parseLastEventId(raw: string | undefined): number {
  if (!raw) return 0;
  const n = Number(raw);
  return Number.isInteger(n) && n >= 0 ? n : 0;
}
