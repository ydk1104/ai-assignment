// 컴파일된 dist 를 대상으로 하는 단위 테스트 (docker test 컨테이너 안에서, 또는 npm run test:unit)
const test = require("node:test");
const assert = require("node:assert/strict");
const { createRng } = require("../../dist/common/random");
const {
  generateTokens,
  createDelay,
  createContent,
  TokenCreateFailError,
  MAX_TOKEN_CONTENT_LENGTH,
} = require("../../dist/documents/token-generator");

const instant = async () => {};
const run = (seed, extra = {}, env = "development", maxTokens = 400) => {
  const rng = createRng(seed);
  return generateTokens({
    maxTokens,
    rng,
    delay: createDelay(rng, env),
    content: createContent(rng, env),
    sleep: instant,
    ...extra,
  });
};
const firstSuccessfulSeed = async () => {
  for (let seed = 1; ; seed++) {
    try {
      await run(seed);
      return seed;
    } catch {
      /* 실패하는 seed는 건너뜀 */
    }
  }
};

test("production: 토큰 내용은 100자 내외(80~120자)이고 256자를 넘지 않는다", async () => {
  const lengths = [];
  for (let seed = 1; seed <= 300; seed++) {
    try {
      const { contents } = await run(seed, {}, "production");
      contents.forEach((c) => lengths.push(c.length));
    } catch {
      /* 에러 시나리오는 다른 테스트에서 */
    }
  }
  assert.ok(lengths.length > 1000);
  assert.ok(
    lengths.every((l) => l >= 79 && l <= 120 && l <= MAX_TOKEN_CONTENT_LENGTH),
  );
  const mean = lengths.reduce((a, b) => a + b, 0) / lengths.length;
  assert.ok(mean > 95 && mean < 105, `평균 ${mean}`);
});

test("production이 아니면(development/test/미설정) 토큰 내용은 토큰 번호", async () => {
  for (const env of ["development", "test", undefined]) {
    const rng = createRng(5);
    const { contents } = await generateTokens({
      maxTokens: 10,
      rng,
      delay: createDelay(rng, env),
      content: createContent(rng, env),
      sleep: instant,
      failRate: 0,
    });
    assert.deepEqual(
      contents,
      contents.map((_, i) => String(i + 1)),
    );
  }
});

test("지연: production은 20~80ms 무작위, 그 외는 10ms 고정", () => {
  const rng = createRng(7);
  const prod = createDelay(rng, "production");
  const values = Array.from({ length: 5000 }, prod);
  assert.ok(values.every((v) => Number.isInteger(v) && v >= 20 && v <= 80));
  assert.ok(new Set(values).size > 30);
  for (const env of ["development", "test", undefined]) {
    const delay = createDelay(rng, env);
    assert.equal(delay(), 10);
  }
});

test("약 10% 확률로 token_create_fail, 에러 시점까지 만든 만큼만 진행 보고된다", async () => {
  let fail = 0;
  const N = 20000;
  for (let seed = 1; seed <= N; seed++) {
    const progress = [];
    try {
      await run(seed, { onProgress: (i) => progress.push(i) });
    } catch (e) {
      fail++;
      assert.ok(e instanceof TokenCreateFailError);
      assert.equal(e.name, "token_create_fail");
      assert.equal(e.message, "token_create_fail");
      assert.ok(e.generated >= 0 && e.generated <= e.total);
      assert.equal(progress.length, e.generated);
    }
  }
  const rate = fail / N;
  assert.ok(rate > 0.09 && rate < 0.11, `실패율 ${rate}`);
});

test("에러 발생 지점은 0 ~ 토큰 수 (양끝 포함)", async () => {
  let sawZero = false;
  let sawTotal = false;
  for (let seed = 1; seed <= 60000 && !(sawZero && sawTotal); seed++) {
    try {
      await run(seed, {}, "development", 20);
    } catch (e) {
      if (e.generated === 0) sawZero = true;
      if (e.generated === e.total) sawTotal = true;
    }
  }
  assert.ok(sawZero, "0번째(하나도 만들기 전) 에러가 발생해야 함");
  assert.ok(sawTotal, "전부 만든 직후 에러가 발생해야 함");
});

test("같은 seed면 같은 결과 (워커가 바뀌어 다시 만들어도 같은 내용)", async () => {
  for (let seed = 1; seed <= 100; seed++) {
    const a = await run(seed, {}, "production").catch(
      (e) => `ERR@${e.generated}/${e.total}`,
    );
    const b = await run(seed, {}, "production").catch(
      (e) => `ERR@${e.generated}/${e.total}`,
    );
    assert.deepEqual(a, b);
  }
});

test("취소: 시작 전 0개, 중간 취소는 그 개수까지, 내용은 취소 없이 만든 것의 앞부분", async () => {
  const seed = await firstSuccessfulSeed();
  const full = await run(seed);
  const total = full.contents.length;

  const none = await run(seed, { shouldStop: () => true });
  assert.deepEqual(none, { contents: [], cancelled: true });

  const k = Math.floor(total / 2);
  const progress = [];
  const partial = await run(seed, {
    shouldStop: (g) => g >= k,
    onProgress: (i) => progress.push(i),
  });
  assert.equal(partial.cancelled, true);
  assert.equal(partial.contents.length, k);
  assert.equal(progress.length, k);
  assert.deepEqual(partial.contents, full.contents.slice(0, k));
});

test("취소: 이미 다 만들었거나 아직 도달 전이면 정상 완료로 본다", async () => {
  const seed = await firstSuccessfulSeed();
  const total = (await run(seed)).contents.length;
  assert.equal(
    (await run(seed, { shouldStop: (g) => g >= total })).cancelled,
    false,
  );
  assert.equal(
    (await run(seed, { shouldStop: (g) => g >= total + 50 })).cancelled,
    false,
  );
});

test("취소와 에러 우선순위: 같은 순간이면 취소, 에러 지점이 먼저면 에러", async () => {
  let failSeed;
  let failAt;
  for (let seed = 1; seed <= 100000; seed++) {
    try {
      await run(seed);
    } catch (e) {
      if (e.generated > 0 && e.generated < e.total) {
        failSeed = seed;
        failAt = e.generated;
        break;
      }
    }
  }
  assert.ok(failSeed, "실패하는 seed를 찾지 못함");
  const cancelled = await run(failSeed, { shouldStop: (g) => g >= failAt });
  assert.equal(cancelled.cancelled, true);
  assert.equal(cancelled.contents.length, failAt);
  await assert.rejects(
    run(failSeed, { shouldStop: (g) => g >= failAt + 10 }),
    TokenCreateFailError,
  );
  const before = await run(failSeed, { shouldStop: (g) => g >= failAt - 3 });
  assert.equal(before.cancelled, true);
});
