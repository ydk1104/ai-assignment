const test = require("node:test");
const assert = require("node:assert/strict");
const { createRng, randomInt, parseSeed } = require("../../dist/common/random");
const {
  pickTokenCount,
  parseLastEventId,
} = require("../../dist/documents/token-count");
const {
  isHeldLockInFlight,
  ENQUEUE_GRACE_MS,
  lockValueOf,
  parseLockValue,
  isTokenProgress,
} = require("../../dist/documents/document-job");

test("createRng: seed가 같으면 같은 수열, 없으면 시간 기반", () => {
  const a = createRng(42);
  const b = createRng(42);
  for (let i = 0; i < 100; i++) assert.equal(a(), b());
  const value = createRng()();
  assert.ok(value >= 0 && value < 1);
  for (let i = 0; i < 1000; i++) {
    const v = randomInt(createRng(i), 3, 7);
    assert.ok(Number.isInteger(v) && v >= 3 && v <= 7);
  }
});

test("parseSeed: 비어 있으면 undefined, 정수가 아니면 에러", () => {
  assert.equal(parseSeed(undefined), undefined);
  assert.equal(parseSeed(""), undefined);
  assert.equal(parseSeed("42"), 42);
  assert.throws(() => parseSeed("abc"));
  assert.throws(() => parseSeed("1.5"));
});

test("pickTokenCount: maxTokens의 30% ~ 100% (양끝 포함), 최소 1", () => {
  for (const max of [1, 2, 3, 10, 100, 1000, 5000]) {
    const min = Math.max(1, Math.ceil((max * 3) / 10));
    const seen = new Set();
    for (let seed = 1; seed <= 3000; seed++) {
      const n = pickTokenCount(max, createRng(seed));
      assert.ok(
        Number.isInteger(n) && n >= min && n <= max,
        `max=${max} n=${n}`,
      );
      seen.add(n);
    }
    if (max <= 10) assert.equal(seen.size, max - min + 1); // 작은 범위는 양끝까지 전부 나온다
  }
});

test("parseLastEventId: 올바른 양의 정수/0만 인정, 나머지는 0(처음부터)", () => {
  assert.deepEqual(
    ["", undefined, "abc", "-1", "1.5", "0", "300"].map(parseLastEventId),
    [0, 0, 0, 0, 0, 0, 300],
  );
});

test("isHeldLockInFlight: 메모가 아니라 job의 실제 상태로 판단", () => {
  const now = 1_000_000;
  const cases = [
    ["active", now - 600_000, true], // 워커가 죽어 복구를 기다리는 중
    ["waiting", now - 600_000, true],
    ["delayed", now - 600_000, true],
    ["completed", now - 5, false], // 끝났는데 메모만 남음
    ["failed", now - 5, false],
    [null, now - 1_000, true], // 큐에 넣는 중일 수 있는 짧은 틈
    [null, now - ENQUEUE_GRACE_MS - 1, false], // 큐에 넣기 전에 API가 죽음
    ["unknown", now - 100, true],
    ["unknown", now - 60_000, false],
    [null, undefined, false], // createdAt 없는 옛 메모
  ];
  for (const [state, createdAt, expected] of cases) {
    assert.equal(
      isHeldLockInFlight(state, createdAt, now),
      expected,
      `${state} / ${createdAt}`,
    );
  }
});

test("lockValueOf / parseLockValue", () => {
  const raw = lockValueOf("job-1", "hash-1");
  const parsed = parseLockValue(raw);
  assert.equal(parsed.jobId, "job-1");
  assert.equal(parsed.requestHash, "hash-1");
  assert.equal(typeof parsed.createdAt, "number");
  assert.equal(parsed.raw, raw);
  assert.equal(parseLockValue("not-json"), null);
  assert.equal(parseLockValue(null), null);
});

test("isTokenProgress", () => {
  assert.equal(isTokenProgress({ index: 1, token: "a" }), true);
  for (const v of [
    { index: "1", token: "a" },
    { index: 1 },
    5,
    null,
    "x",
    undefined,
  ]) {
    assert.equal(isTokenProgress(v), false);
  }
});
