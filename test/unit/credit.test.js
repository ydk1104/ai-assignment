const test = require("node:test");
const assert = require("node:assert/strict");
const {
  INSUFFICIENT_CREDIT_MESSAGE,
  DEFAULT_INITIAL_CREDIT,
  InsufficientCreditError,
  hasEnoughCredit,
  parseInitialCredit,
  toAccount,
} = require("../../dist/credits/credit-math");

test("toAccount: 실제 잔액(available) = 잔액 - 예약", () => {
  assert.deepEqual(toAccount(10000, 3000), {
    balance: 10000,
    reserved: 3000,
    available: 7000,
  });
  assert.deepEqual(toAccount(0, 0), { balance: 0, reserved: 0, available: 0 });
});

test("hasEnoughCredit: 예약된 금액을 뺀 실제 잔액이 요청 금액 이상이어야 한다", () => {
  assert.equal(hasEnoughCredit(10000, 0, 10000), true); // 딱 맞으면 가능
  assert.equal(hasEnoughCredit(10000, 0, 10001), false);
  assert.equal(hasEnoughCredit(10000, 6000, 4000), true);
  assert.equal(hasEnoughCredit(10000, 6000, 4001), false); // 잔액은 충분해도 예약분을 빼면 모자람
  assert.equal(hasEnoughCredit(0, 0, 1), false);
});

test("예약을 하나씩 차례로 받으면 합계가 잔액을 넘지 않는다 (음수 방지의 핵심 규칙)", () => {
  const balance = 10000;
  const each = 4000;
  let reserved = 0;
  const results = [];
  for (let i = 0; i < 5; i++) {
    const ok = hasEnoughCredit(balance, reserved, each);
    results.push(ok);
    if (ok) reserved += each;
  }
  assert.deepEqual(results, [true, true, false, false, false]);
  assert.ok(balance - reserved >= 0);
});

test('InsufficientCreditError: 메시지는 "크레딧이 부족합니다."', () => {
  const err = new InsufficientCreditError(2000, 4000);
  assert.equal(err.message, "크레딧이 부족합니다.");
  assert.equal(err.message, INSUFFICIENT_CREDIT_MESSAGE);
  assert.equal(err.name, "InsufficientCreditError");
  assert.equal(err.available, 2000);
  assert.equal(err.requested, 4000);
  assert.ok(err instanceof Error);
});

test("parseInitialCredit: 비어 있으면 기본값, 0 이상의 정수만 허용", () => {
  assert.equal(parseInitialCredit(undefined), DEFAULT_INITIAL_CREDIT);
  assert.equal(parseInitialCredit(""), DEFAULT_INITIAL_CREDIT);
  assert.equal(parseInitialCredit("10000"), 10000);
  assert.equal(parseInitialCredit("0"), 0);
  for (const bad of ["-1", "1.5", "abc", "1e400"])
    assert.throws(() => parseInitialCredit(bad), bad);
});
