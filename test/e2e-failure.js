// token_create_fail 경로 테스트. 항상 도중에 실패하는 고정 seed(RANDOM_SEED)로 띄운 스택에서 실행한다 (TEST_PHASE=failure).
// 같은 seed면 실패 여부/지점이 항상 같으므로, 서버와 같은 코드로 "몇 번째 토큰에서 실패해야 하는지"를 계산해 정확히 단언한다.
// 실패한 생성은 과금되지 않아야 하므로, 크레딧 잔액/예약과 (DB가 있으면) 크레딧 원장도 함께 확인한다.
const test = require("node:test");
const assert = require("node:assert/strict");
const { createRng } = require("../dist/common/random");
const {
  generateTokens,
  createDelay,
  createContent,
  TokenCreateFailError,
} = require("../dist/documents/token-generator");

const BASE = process.env.BASE_URL ?? "http://127.0.0.1";
if (!process.env.RANDOM_SEED)
  throw new Error("RANDOM_SEED(실패하는 고정 seed)가 필요해요");
const SEED = Number(process.env.RANDOM_SEED);
const INITIAL = Number(process.env.INITIAL_CREDIT ?? 10000); // 서버가 새 유저에게 지급하는 초기 크레딧
const run = Date.now().toString(36);
let seq = 0;
const newKey = (label) => `e2e-fail-${run}-${label}-${++seq}`;

// 이 seed로 maxTokens 요청을 하면 몇 번째 토큰에서(at) 실패해야 하는지, 원래 몇 개를 만들려 했는지(total)
async function expectedFailure(maxTokens) {
  const rng = createRng(SEED);
  try {
    await generateTokens({
      maxTokens,
      rng,
      delay: createDelay(rng, "development"),
      content: createContent(rng, "development"),
      sleep: async () => {},
    });
  } catch (e) {
    if (e instanceof TokenCreateFailError)
      return { at: e.generated, total: e.total };
    throw e;
  }
  throw new Error(
    `seed ${SEED} 로는 maxTokens=${maxTokens} 생성이 실패하지 않아요. 도중에 실패하는 seed를 쓰세요 (test/seeds.json 의 failure)`,
  );
}

const post = (path, body, headers = {}) =>
  fetch(`${BASE}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
const create = (body, key, extra = {}) =>
  post("/create_document", body, { "Idempotency-Key": key, ...extra });
const cancel = (userId, idempotencyKey) =>
  post("/cancel_document", { userId, idempotencyKey });

// ---- 크레딧 확인 ----
const getCredit = async (userId) => {
  const res = await fetch(
    `${BASE}/credit?userId=${encodeURIComponent(userId)}`,
  );
  assert.equal(res.status, 200);
  return res.json();
};
const untouched = (userId) => ({
  userId,
  balance: INITIAL,
  reserved: 0,
  available: INITIAL,
}); // 초기 상태 그대로

// DB를 직접 확인한다 (test 컨테이너에는 DB 접속 정보가 있다). DB_HOST 가 없으면 null
async function withDb(fn) {
  if (!process.env.DB_HOST) return null;
  const { Pool } = require("pg");
  const pool = new Pool({
    host: process.env.DB_HOST,
    port: Number(process.env.DB_PORT ?? 5432),
    user: process.env.DB_USER ?? "app",
    password: process.env.DB_PASSWORD ?? "app_password",
    database: process.env.DB_NAME ?? "app",
  });
  try {
    return await fn(pool);
  } finally {
    await pool.end();
  }
}
// 크레딧 원장(GRANT/RESERVE/SETTLE/RELEASE)을 시간 순서로
const creditEntries = (userId) =>
  withDb(
    async (pool) =>
      (
        await pool.query(
          `SELECT entry_type, balance_delta::int AS balance_delta, reserved_delta::int AS reserved_delta
       FROM credit_ledger WHERE user_id = $1 ORDER BY id`,
          [userId],
        )
      ).rows,
  );
// 토큰 사용 기록(결과 저장)이 있는지: 실패한 생성은 아무것도 남기지 않아야 한다
const usageRecords = (userId) =>
  withDb(async (pool) => ({
    ledgerRows: (
      await pool.query(
        "SELECT COUNT(*)::int AS n FROM token_ledger WHERE user_id = $1",
        [userId],
      )
    ).rows[0].n,
    totalsRows: (
      await pool.query(
        "SELECT COUNT(*)::int AS n FROM user_token_totals WHERE user_id = $1",
        [userId],
      )
    ).rows[0].n,
  }));

function parseEvent(block) {
  const ev = { id: null, event: "message", data: null };
  let seen = false;
  for (const line of block.split("\n")) {
    if (line.startsWith("id:")) {
      ev.id = Number(line.slice(3).trim());
      seen = true;
    } else if (line.startsWith("event:")) {
      ev.event = line.slice(6).trim();
      seen = true;
    } else if (line.startsWith("data:")) {
      ev.data = JSON.parse(line.slice(5).trim());
      seen = true;
    }
  }
  return seen ? ev : null;
}

// done/error 까지 읽는다. onToken(개수)은 토큰을 받을 때마다 호출된다
async function readSse(res, onToken) {
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  const events = [];
  let buf = "";
  let count = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let idx;
    while ((idx = buf.indexOf("\n\n")) !== -1) {
      const ev = parseEvent(buf.slice(0, idx));
      buf = buf.slice(idx + 2);
      if (!ev) continue;
      events.push(ev);
      if (ev.event === "message") onToken?.(++count);
      if (ev.event === "done" || ev.event === "error") return summarize(events);
    }
  }
  return summarize(events);
}
const summarize = (events) => ({
  tokens: events.filter((e) => e.event === "message"),
  end: events.find((e) => e.event === "done" || e.event === "error") ?? null,
});

for (const maxTokens of [200, 1000]) {
  test(`maxTokens=${maxTokens}: 정해진 지점에서 token_create_fail 로 끝나고, 크레딧은 차감되지 않는다`, async (t) => {
    const { at, total } = await expectedFailure(maxTokens);
    const userId = `e2e-fail-${run}-${maxTokens}`;
    assert.deepEqual(
      await getCredit(userId),
      untouched(userId),
      "시작 전: 초기 크레딧 그대로",
    );

    const res = await create(
      { userId, prompt: "p", maxTokens },
      newKey(`fail${maxTokens}`),
    );
    assert.equal(res.status, 200);
    let duringCall = null;
    const { tokens, end } = await readSse(res, (count) => {
      if (count === 5 && !duringCall) duringCall = getCredit(userId); // 생성 중의 크레딧 상태
    });

    assert.equal(
      tokens.length,
      at,
      `${total}개를 만들려다 ${at}번째에서 실패해야 함`,
    );
    tokens.forEach((e, i) => assert.equal(e.id, i + 1));
    assert.equal(end.event, "error");
    assert.equal(end.data.error, "token_create_fail");
    assert.equal(end.data.tokens, at);

    // 생성 중에는 maxTokens 만큼 예약돼 있었고 (예약이 실제로 있었음), 잔액은 아직 그대로
    const during = await duringCall;
    assert.equal(during.reserved, maxTokens, "생성 중에는 maxTokens 만큼 예약");
    assert.equal(during.balance, INITIAL);
    assert.equal(during.available, INITIAL - maxTokens);

    // 실패가 보이는 시점에는 예약이 이미 풀려 있고, 잔액은 한 토큰도 차감되지 않았다
    // (실패해서 만든 토큰이 at개 있었어도 과금하지 않는다)
    assert.deepEqual(
      await getCredit(userId),
      untouched(userId),
      "실패한 생성은 잔액을 차감하지 않고 예약만 푼다",
    );

    const entries = await creditEntries(userId);
    if (entries) {
      assert.deepEqual(
        entries.map((e) => e.entry_type),
        ["GRANT", "RESERVE", "RELEASE"],
        "원장: 지급 -> 예약 -> 예약 해제 (정산 없음)",
      );
      assert.equal(entries[1].reserved_delta, maxTokens);
      assert.deepEqual(
        [entries[2].balance_delta, entries[2].reserved_delta],
        [0, -maxTokens],
        "해제는 잔액을 건드리지 않고 예약만 되돌림",
      );
      assert.deepEqual(
        await usageRecords(userId),
        { ledgerRows: 0, totalsRows: 0 },
        "실패한 생성은 사용 기록을 남기지 않음",
      );
    } else {
      t.diagnostic("DB_HOST 가 없어 크레딧 원장 직접 확인은 생략");
    }
  });
}

test("실패한 요청은 기록/과금되지 않고, 같은 키로 다시 요청하면 새로 예약/생성해서 같은 지점에서 다시 실패한다", async (t) => {
  const { at } = await expectedFailure(1000);
  const body = {
    userId: `e2e-fail-${run}-retry`,
    prompt: "p",
    maxTokens: 1000,
  };
  const key = newKey("retry");

  const first = await readSse(await create(body, key));
  assert.equal(first.end.data.error, "token_create_fail");
  assert.equal(first.tokens.length, at);
  assert.deepEqual(
    await getCredit(body.userId),
    untouched(body.userId),
    "1차 실패 후에도 잔액/예약 그대로",
  );

  // 원장에 없으므로 취소할 것도 없고, 재생이 아니라 새 생성이다 (자기 예약 때문에 크레딧이 모자라지도 않는다)
  assert.equal((await cancel(body.userId, key)).status, 404);
  const retryRes = await create(body, key);
  assert.equal(
    retryRes.status,
    200,
    "실패한 요청의 예약이 풀려 있어야 같은 키로 다시 요청할 수 있음",
  );
  assert.equal(retryRes.headers.get("idempotent-replayed"), null);
  const second = await readSse(retryRes);
  assert.equal(second.tokens.length, at);
  assert.equal(second.end.data.error, "token_create_fail");
  assert.deepEqual(
    await getCredit(body.userId),
    untouched(body.userId),
    "2차 실패 후에도 잔액/예약 그대로 (두 번 실패해도 차감 없음)",
  );

  const entries = await creditEntries(body.userId);
  if (entries) {
    assert.deepEqual(
      entries.map((e) => e.entry_type),
      ["GRANT", "RESERVE", "RELEASE", "RESERVE", "RELEASE"],
      "원장: 시도마다 예약 -> 해제",
    );
    assert.ok(!entries.some((e) => e.entry_type === "SETTLE"));
    assert.equal(
      entries.reduce((sum, e) => sum + e.balance_delta, 0),
      INITIAL,
      "원장 합계 = 초기 지급액 (잔액 변동 없음)",
    );
    assert.equal(
      entries.reduce((sum, e) => sum + e.reserved_delta, 0),
      0,
      "예약 합계 0",
    );
    assert.deepEqual(await usageRecords(body.userId), {
      ledgerRows: 0,
      totalsRows: 0,
    });
  } else {
    t.diagnostic("DB_HOST 가 없어 크레딧 원장 직접 확인은 생략");
  }
});

test("에러 지점보다 앞서 취소하면 에러 대신 취소로 확정되고, 생성된 만큼만 차감된다", async (t) => {
  const { at } = await expectedFailure(1000);
  assert.ok(at >= 100, `테스트 전제: 실패 지점(${at})이 충분히 뒤여야 함`);
  const body = {
    userId: `e2e-fail-${run}-cancel`,
    prompt: "p",
    maxTokens: 1000,
  };
  const key = newKey("cancel");

  const res = await create(body, key);
  assert.equal(res.status, 200);
  let cancelCall = null;
  const { tokens, end } = await readSse(res, (count) => {
    if (count === 20 && !cancelCall)
      cancelCall = cancel(body.userId, key).then(async (r) => ({
        status: r.status,
        body: await r.json(),
      }));
  });
  const cancelRes = await cancelCall;

  assert.equal(
    end.event,
    "done",
    `에러가 아니라 done 이어야 함: ${JSON.stringify(end)}`,
  );
  assert.equal(end.data.cancelled, true);
  assert.equal(cancelRes.status, 200);
  assert.equal(cancelRes.body.status, "cancelled");
  assert.equal(tokens.length, end.data.tokens);
  assert.equal(tokens.length, cancelRes.body.tokens);
  assert.ok(
    tokens.length >= 20 && tokens.length < at,
    `20 <= ${tokens.length} < ${at}`,
  );

  // 취소는 "완료된 것처럼" 정산된다: 만든 토큰 수만큼만 차감, 나머지 예약은 풀림
  const credit = await getCredit(body.userId);
  assert.equal(
    credit.balance,
    INITIAL - tokens.length,
    "생성된 토큰 수만큼만 차감",
  );
  assert.equal(credit.reserved, 0);
  assert.equal(credit.available, INITIAL - tokens.length);

  const entries = await creditEntries(body.userId);
  if (entries) {
    assert.deepEqual(
      entries.map((e) => e.entry_type),
      ["GRANT", "RESERVE", "SETTLE"],
    );
    assert.deepEqual(
      [entries[2].balance_delta, entries[2].reserved_delta],
      [-tokens.length, -1000],
      "정산: 만든 토큰 수만큼 차감 + 예약 1000 전부 해제",
    );
  } else {
    t.diagnostic("DB_HOST 가 없어 크레딧 원장 직접 확인은 생략");
  }

  // 취소로 확정된 결과는 같은 키로 다시 요청하면 그대로 재생된다 (크레딧은 그대로)
  const replayRes = await create(body, key, { "Last-Event-ID": "0" });
  assert.equal(replayRes.headers.get("idempotent-replayed"), "true");
  const replay = await readSse(replayRes);
  assert.equal(replay.tokens.length, tokens.length);
  assert.equal(replay.end.data.cancelled, true);
  assert.deepEqual(
    await getCredit(body.userId),
    credit,
    "재생은 크레딧을 건드리지 않음",
  );
});
