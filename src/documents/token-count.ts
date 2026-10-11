import { randomInt, type Rng } from "../common/random";

/** 누적 토큰 수를 최대 몇 번에 나눠 보낼지 */
export const STREAM_STEPS = 10;

/** maxTokens의 30% ~ 100% 사이(양끝 포함)에서 정수 토큰 수를 고른다 */
export function pickTokenCount(maxTokens: number, rng: Rng): number {
  // 0.3 * maxTokens 는 부동소수점 오차가 생길 수 있어 정수 연산으로 올림 처리
  const min = Math.max(1, Math.ceil((maxTokens * 3) / 10));
  return randomInt(rng, min, maxTokens);
}

/**
 * SSE로 보낼 누적 토큰 수 목록 (마지막 값은 항상 total).
 * 각 값이 곧 SSE 이벤트 id 이다. lastEventId 이하는 클라이언트가 이미 받았으므로 제외한다.
 * id가 "단계 번호"가 아니라 "누적 토큰 수"라서, 단계 수(STREAM_STEPS)가 바뀌어도 이어받기가 깨지지 않는다.
 */
export function streamPoints(
  total: number,
  lastEventId = 0,
  steps = STREAM_STEPS,
): number[] {
  const n = Math.min(total, steps);
  const points: number[] = [];
  for (let i = 1; i <= n; i++) {
    points.push(Math.floor((total * i) / n));
  }
  return points.filter((p) => p > lastEventId);
}

/** Last-Event-ID 헤더 파싱. 없거나 올바르지 않으면 0(처음부터) */
export function parseLastEventId(raw: string | undefined): number {
  if (!raw) return 0;
  const n = Number(raw);
  return Number.isInteger(n) && n >= 0 ? n : 0;
}
