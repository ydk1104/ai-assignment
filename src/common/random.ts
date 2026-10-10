/** 0 이상 1 미만의 난수를 돌려주는 함수 */
export type Rng = () => number;

/**
 * 난수 생성기를 만든다 (mulberry32).
 * - seed를 주면 항상 같은 수열이 나온다 (테스트/재현용)
 * - seed를 안 주면 현재 시간(Date.now())을 seed로 쓴다
 */
export function createRng(seed?: number): Rng {
  let state = (seed ?? Date.now()) >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** min 이상 max 이하(양끝 포함)의 정수 */
export function randomInt(rng: Rng, min: number, max: number): number {
  return min + Math.floor(rng() * (max - min + 1));
}

/** 환경변수 RANDOM_SEED 파싱. 비어 있으면 undefined(=시간 기반), 정수가 아니면 에러 */
export function parseSeed(raw?: string): number | undefined {
  if (raw === undefined || raw.trim() === "") return undefined;
  const seed = Number(raw);
  if (!Number.isInteger(seed)) {
    throw new Error(`RANDOM_SEED must be an integer, got "${raw}"`);
  }
  return seed;
}
