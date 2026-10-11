import { randomInt, type Rng } from "../common/random";
import { TOKEN_CREATE_FAIL } from "./document-job";
import { pickTokenCount } from "./token-count";

/** 생성 도중 에러가 날 확률 */
export const FAIL_RATE = 0.1;

/** 생성 도중 의도적으로 내는 에러 (name/message 모두 token_create_fail) */
export class TokenCreateFailError extends Error {
  readonly generated: number;
  readonly total: number;

  constructor(generated: number, total: number) {
    super(TOKEN_CREATE_FAIL);
    this.name = TOKEN_CREATE_FAIL;
    this.generated = generated; // 에러가 나기 전까지 생성한 토큰 수
    this.total = total; // 원래 생성하려던 토큰 수
  }
}

/**
 * 토큰 하나를 만드는 데 걸리는 지연(ms)을 돌려주는 함수를 만든다.
 * - production: 20~80ms 사이 무작위
 * - 그 외(development, test, 미설정): 10ms 고정 → 테스트가 빨리 끝남
 */
export function createDelay(
  rng: Rng,
  nodeEnv: string | undefined = process.env.NODE_ENV,
): () => number {
  if (nodeEnv === "production") return () => randomInt(rng, 20, 80);
  return () => 10;
}

export interface GenerateOptions {
  maxTokens: number;
  rng: Rng;
  /** 토큰 하나를 만들 때마다 기다릴 시간(ms) */
  delay: () => number;
  sleep: (ms: number) => Promise<void>;
  /** 토큰이 하나 만들어질 때마다 호출 (누적 개수 전달) */
  onProgress?: (generated: number) => void | Promise<void>;
  failRate?: number;
}

/**
 * 토큰을 "생성"한다. 성공하면 만든 토큰 수를 돌려주고, 10% 확률로 중간에 token_create_fail 를 던진다.
 *
 * 난수는 아래 순서로 뽑는다 (seed를 고정하면 매번 같은 결과).
 *   1) pickTokenCount          : 만들 토큰 수 N
 *   2) 에러 여부               : failRate 확률로 에러
 *   3) 에러 발생 지점 failAt   : 0 ~ N 중 하나 (양끝 포함)
 * 그 뒤 실제로 토큰을 하나씩 만들면서(지연 포함) 누적 개수가 failAt에 도달하는 순간 에러를 던진다.
 * failAt이 0이면 하나도 만들기 전에, N이면 전부 만든 직후에 실패한다.
 */
export async function generateTokens(
  options: GenerateOptions,
): Promise<number> {
  const {
    maxTokens,
    rng,
    delay,
    sleep,
    onProgress,
    failRate = FAIL_RATE,
  } = options;

  const total = pickTokenCount(maxTokens, rng);
  const willFail = rng() < failRate;
  const failAt = willFail ? randomInt(rng, 0, total) : -1;

  for (let generated = 0; ; generated++) {
    if (generated === failAt) throw new TokenCreateFailError(generated, total);
    if (generated === total) return total;

    await sleep(delay()); // 토큰 하나 생성
    await onProgress?.(generated + 1);
  }
}
