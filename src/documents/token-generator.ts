import { randomInt, type Rng } from "../common/random";
import { TOKEN_CREATE_FAIL } from "./document-job";
import { pickTokenCount } from "./token-count";

/** 생성 도중 에러가 날 확률 */
export const FAIL_RATE = 0.1;

/** 토큰 하나의 내용 길이: 100자 내외(80~120자), 어떤 경우에도 256자를 넘지 않는다 */
export const MAX_TOKEN_CONTENT_LENGTH = 256;
const CONTENT_LENGTH_MIN = 80;
const CONTENT_LENGTH_MAX = 120;

const WORDS = [
  "alpha",
  "bravo",
  "cedar",
  "delta",
  "ember",
  "fable",
  "grove",
  "harbor",
  "iris",
  "jasper",
  "kernel",
  "lumen",
  "meadow",
  "nectar",
  "onyx",
  "prairie",
  "quartz",
  "river",
  "solstice",
  "timber",
  "umber",
  "velvet",
  "willow",
  "zephyr",
  "anchor",
  "beacon",
  "canyon",
  "dune",
  "echo",
  "fjord",
  "glacier",
  "horizon",
];

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

/** 100자 내외(80~120자), 최대 256자의 무작위 텍스트 */
export function randomTokenText(rng: Rng): string {
  const target = Math.min(
    MAX_TOKEN_CONTENT_LENGTH,
    randomInt(rng, CONTENT_LENGTH_MIN, CONTENT_LENGTH_MAX),
  );
  let text = "";
  while (text.length < target) {
    text += (text ? " " : "") + WORDS[randomInt(rng, 0, WORDS.length - 1)];
  }
  return text.slice(0, target).trimEnd();
}

/**
 * 토큰 번호(1부터)를 받아 그 토큰의 내용을 만드는 함수를 만든다.
 * - production: 100자 내외의 무작위 텍스트
 * - 그 외: 토큰 번호를 그대로 사용 (테스트에서 내용을 쉽게 확인)
 */
export function createContent(
  rng: Rng,
  nodeEnv: string | undefined = process.env.NODE_ENV,
): (index: number) => string {
  if (nodeEnv === "production") return () => randomTokenText(rng);
  return (index) => String(index);
}

export interface GenerateOptions {
  maxTokens: number;
  rng: Rng;
  /** 토큰 하나를 만들 때마다 기다릴 시간(ms) */
  delay: () => number;
  /** 토큰 번호(1부터) -> 토큰 내용 */
  content: (index: number) => string;
  sleep: (ms: number) => Promise<void>;
  /** 토큰이 하나 만들어질 때마다 호출 (번호, 내용) */
  onProgress?: (index: number, content: string) => void | Promise<void>;
  failRate?: number;
}

/**
 * 토큰을 "생성"한다. 성공하면 만든 토큰들의 내용(배열)을 돌려주고, 10% 확률로 중간에 token_create_fail 를 던진다.
 *
 * 난수는 아래 순서로 뽑는다 (같은 seed면 매번 같은 결과 - 워커가 죽어 다른 워커가 다시 만들어도 같은 내용).
 *   1) pickTokenCount          : 만들 토큰 수 N
 *   2) 에러 여부               : failRate 확률로 에러
 *   3) 에러 발생 지점 failAt   : 0 ~ N 중 하나 (양끝 포함)
 *   4) 토큰마다                : 지연 -> 내용
 * 그 뒤 실제로 토큰을 하나씩 만들면서(지연 포함) 누적 개수가 failAt에 도달하는 순간 에러를 던진다.
 * failAt이 0이면 하나도 만들기 전에, N이면 전부 만든 직후에 실패한다.
 */
export async function generateTokens(
  options: GenerateOptions,
): Promise<string[]> {
  const {
    maxTokens,
    rng,
    delay,
    content,
    sleep,
    onProgress,
    failRate = FAIL_RATE,
  } = options;

  const total = pickTokenCount(maxTokens, rng);
  const willFail = rng() < failRate;
  const failAt = willFail ? randomInt(rng, 0, total) : -1;

  const contents: string[] = [];
  for (let generated = 0; ; generated++) {
    if (generated === failAt) throw new TokenCreateFailError(generated, total);
    if (generated === total) return contents;

    await sleep(delay()); // 토큰 하나 생성
    const index = generated + 1;
    const text = content(index);
    contents.push(text);
    await onProgress?.(index, text);
  }
}
