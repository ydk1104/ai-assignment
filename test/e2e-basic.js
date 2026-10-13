// API 기본 동작 테스트 (실행 중인 스택에 HTTP로 요청). BASE_URL 환경변수로 주소를 지정한다.
// RANDOM_SEED(고정 seed)가 있으면 결과가 항상 같으므로 재시도 없이 정확한 기대값(토큰 수)까지 단언한다.
// seed가 없으면(랜덤 모드) 10% 확률로 일부러 내는 token_create_fail 에 걸릴 때 새 키로 다시 시도한다.
const test = require("node:test");
const assert = require("node:assert/strict");

const BASE = process.env.BASE_URL ?? "http://127.0.0.1";
const IS_PRODUCTION = process.env.NODE_ENV === "production";
const SEED = process.env.RANDOM_SEED
  ? Number(process.env.RANDOM_SEED)
  : undefined;
const MAX_ATTEMPTS = SEED === undefined ? 8 : 1; // 고정 seed에서는 실패가 나면 seed 설정이 잘못된 것이라 재시도하지 않는다

// 고정 seed일 때, maxTokens 요청이 만들어야 하는 정확한 토큰 수 (서버와 같은 코드로 계산). dist가 없으면 undefined
let expectedTotal = () => undefined;
try {
  const { createRng } = require("../dist/common/random");
  const { pickTokenCount } = require("../dist/documents/token-count");
  if (SEED !== undefined)
    expectedTotal = (maxTokens) => pickTokenCount(maxTokens, createRng(SEED));
} catch {
  /* 호스트에서 dist 없이 실행하는 경우 */
}
const failedWith = (end) =>
  SEED === undefined
    ? end?.data?.error
    : `고정 seed(${SEED})인데 생성이 실패함(${end?.data?.error}). 성공하는 seed가 맞는지 확인하세요`;
const run = Date.now().toString(36);
let seq = 0;
const newKey = (label) => `e2e-${run}-${label}-${++seq}`;

const post = (path, body, headers = {}) =>
  fetch(`${BASE}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
const create = (body, key, extra = {}) =>
  post(
    "/create_document",
    body,
    key === undefined ? extra : { "Idempotency-Key": key, ...extra },
  );

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

// SSE를 읽는다. stopAfter(토큰 개수)를 주면 그만큼 받고 연결을 끊는다
async function readSse(res, stopAfter) {
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  const events = [];
  let buf = "";
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
      if (ev.event === "done" || ev.event === "error") return summarize(events);
      if (stopAfter && events.length >= stopAfter) {
        await reader.cancel();
        return summarize(events);
      }
    }
  }
  return summarize(events);
}
function summarize(events) {
  return {
    tokens: events.filter((e) => e.event === "message"),
    end: events.find((e) => e.event === "done" || e.event === "error") ?? null,
  };
}

// 에러(token_create_fail)가 나면 새 키로 다시 시도해서 정상 완료된 결과를 돌려준다
async function generateOk(body, label) {
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    const key = newKey(label);
    const res = await create(body, key);
    assert.equal(res.status, 200);
    const result = await readSse(res);
    if (result.end?.event === "done") return { key, res, ...result };
    assert.equal(
      result.end?.data?.error,
      "token_create_fail",
      "의도한 에러 외의 에러",
    );
  }
  assert.fail(failedWith({ data: { error: "token_create_fail" } }));
}

// 오래 걸리는 생성을 시작해서 첫 토큰을 받은 상태로 돌려준다 (에러로 바로 끝나면 새 키로 재시도)
async function startLong(userId, label) {
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    const key = newKey(label);
    const body = { userId, prompt: "long", maxTokens: 5000 }; // 최소 1500개 -> development 에서도 15초 이상
    const res = await create(body, key);
    assert.equal(res.status, 200);
    const first = await readSse(res, 1);
    if (first.tokens.length === 1) return { key, body };
  }
  assert.fail("긴 생성을 시작하지 못함");
}

test("GET /status 는 200", async () => {
  const res = await fetch(`${BASE}/status`);
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { status: "ok" });
});

test("입력 검증: Idempotency-Key 없음 / 잘못된 본문은 400", async () => {
  assert.equal(
    (await create({ userId: "u", prompt: "p", maxTokens: 10 })).status,
    400,
  );
  const key = newKey("invalid");
  for (const body of [
    { prompt: "p", maxTokens: 10 },
    { userId: "u", maxTokens: 10 },
    { userId: "u", prompt: "p" },
    { userId: "u", prompt: "p", maxTokens: 0 },
    { userId: "u", prompt: "p", maxTokens: 1.5 },
    { userId: "u", prompt: "p", maxTokens: 1_000_001 },
  ]) {
    assert.equal((await create(body, key)).status, 400, JSON.stringify(body));
  }
});

test("생성: 토큰이 1번부터 한 개씩 내용과 함께 오고, 개수는 maxTokens의 30~100%", async () => {
  const { tokens, end } = await generateOk(
    { userId: "e2e-basic", prompt: "hello", maxTokens: 200 },
    "basic",
  );
  assert.ok(
    tokens.length >= 60 && tokens.length <= 200,
    `개수 ${tokens.length}`,
  );
  if (expectedTotal(200) !== undefined)
    assert.equal(
      tokens.length,
      expectedTotal(200),
      "고정 seed: 토큰 수가 정확히 같아야 함",
    );
  tokens.forEach((e, i) => {
    assert.equal(e.id, i + 1);
    assert.equal(e.data.tokens, i + 1);
    assert.equal(typeof e.data.token, "string");
    assert.ok(e.data.token.length >= 1 && e.data.token.length <= 256);
    if (!IS_PRODUCTION) assert.equal(e.data.token, String(i + 1)); // 테스트 모드: 내용 = 토큰 번호
  });
  assert.equal(end.data.tokens, tokens.length);
  assert.equal(end.data.cancelled, false);
});

test("같은 키로 다시 요청하면 DB에 저장된 같은 내용이 재생되고, Last-Event-ID 다음부터 이어받는다", async () => {
  const body = { userId: "e2e-replay", prompt: "hello", maxTokens: 150 };
  const { key, tokens } = await generateOk(body, "replay");
  if (expectedTotal(150) !== undefined)
    assert.equal(tokens.length, expectedTotal(150));

  const replayRes = await create(body, key);
  assert.equal(replayRes.headers.get("idempotent-replayed"), "true");
  const replay = await readSse(replayRes);
  assert.deepEqual(
    replay.tokens.map((e) => e.data.token),
    tokens.map((e) => e.data.token),
  );
  assert.equal(replay.end.data.tokens, tokens.length);

  const from = Math.floor(tokens.length / 2);
  const resumed = await readSse(
    await create(body, key, { "Last-Event-ID": String(from) }),
  );
  assert.deepEqual(
    resumed.tokens.map((e) => e.id),
    tokens.slice(from).map((e) => e.id),
  );
  assert.equal(resumed.end.data.tokens, tokens.length);
});

test("같은 키 + 다른 본문은 422", async () => {
  const body = { userId: "e2e-422", prompt: "hello", maxTokens: 100 };
  const { key } = await generateOk(body, "422");
  assert.equal(
    (await create({ ...body, prompt: "different" }, key)).status,
    422,
  );
  assert.equal((await create({ ...body, maxTokens: 101 }, key)).status, 422);
});

test("Idempotency-Key는 유저별로 독립적이다", async () => {
  const key = newKey("scope");
  for (const userId of ["e2e-scope-a", "e2e-scope-b"]) {
    let finished = false;
    for (let attempt = 0; attempt < MAX_ATTEMPTS && !finished; attempt++) {
      const res = await create({ userId, prompt: "p", maxTokens: 50 }, key);
      assert.equal(res.status, 200, `${userId}`);
      assert.equal(res.headers.get("idempotent-replayed"), null);
      const { end } = await readSse(res);
      if (end?.event === "done") finished = true;
      else assert.equal(end?.data?.error, "token_create_fail"); // 실패는 기록되지 않아 같은 키로 재시도 가능
    }
    assert.ok(finished, failedWith());
  }
});

test('생성 중에 같은 키로 다시 요청하면 409 "처리중입니다.", 다른 본문이면 422, 취소하면 확정된다', async () => {
  const { key, body } = await startLong("e2e-busy", "busy");

  const busy = await create(body, key);
  assert.equal(busy.status, 409);
  assert.equal((await busy.json()).message, "처리중입니다.");
  assert.equal(busy.headers.get("retry-after"), "1");

  assert.equal((await create({ ...body, prompt: "other" }, key)).status, 422);

  // 정리: 취소 (취소 시점의 개수로 확정)
  const cancel = await post("/cancel_document", {
    userId: body.userId,
    idempotencyKey: key,
  });
  assert.ok([200, 202].includes(cancel.status), `취소 응답 ${cancel.status}`);
  if (cancel.status === 200) {
    const result = await cancel.json();
    assert.equal(result.status, "cancelled");
    assert.ok(result.tokens >= 1 && result.tokens < 1500);
  }
});

test("취소할 작업이 없으면 404, 검증 오류는 400", async () => {
  assert.equal(
    (
      await post("/cancel_document", {
        userId: "e2e-none",
        idempotencyKey: newKey("none"),
      })
    ).status,
    404,
  );
  assert.equal(
    (await post("/cancel_document", { userId: "e2e-none" })).status,
    400,
  );
  assert.equal(
    (await post("/cancel_document", { idempotencyKey: "x" })).status,
    400,
  );
});

test("완료된 요청을 취소하면 completed 로 그대로 알려준다", async () => {
  const body = { userId: "e2e-done-cancel", prompt: "p", maxTokens: 60 };
  const { key, tokens } = await generateOk(body, "done-cancel");
  if (expectedTotal(60) !== undefined)
    assert.equal(tokens.length, expectedTotal(60));
  const res = await post("/cancel_document", {
    userId: body.userId,
    idempotencyKey: key,
  });
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), {
    status: "completed",
    tokens: tokens.length,
    cancelled: false,
  });
});

// ---------------------------------------------------------------- 크레딧

const INITIAL = Number(process.env.INITIAL_CREDIT ?? 10000); // 서버가 새 유저에게 지급하는 초기 크레딧
const getCredit = async (userId) => {
  const res = await fetch(
    `${BASE}/credit?userId=${encodeURIComponent(userId)}`,
  );
  assert.equal(res.status, 200);
  return res.json();
};
// 조건이 맞을 때까지 잠깐씩 기다린다 (취소 요청 직후 정산이 끝나길 기다릴 때)
async function eventually(fn, message, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await fn();
    if (value) return value;
    if (Date.now() > deadline) assert.fail(message);
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
}

test("GET /credit: userId 가 없으면 400", async () => {
  assert.equal((await fetch(`${BASE}/credit`)).status, 400);
  assert.equal((await fetch(`${BASE}/credit?userId=`)).status, 400);
});

test("GET /credit: 처음 조회하면 초기 크레딧이 지급된다 (잔액, 예약, 실제 잔액)", async () => {
  const userId = `e2e-credit-${run}-init`;
  assert.deepEqual(await getCredit(userId), {
    userId,
    balance: INITIAL,
    reserved: 0,
    available: INITIAL,
  });
  assert.deepEqual(
    await getCredit(userId),
    { userId, balance: INITIAL, reserved: 0, available: INITIAL },
    "다시 조회해도 다시 지급되지 않음",
  );
});

test("생성이 끝나면 생성된 토큰 수만큼만 차감되고 예약은 풀린다. 재생/중복 요청은 차감하지 않는다", async () => {
  const userId = `e2e-credit-${run}-settle`;
  const body = { userId, prompt: "p", maxTokens: 200 };
  const { key, tokens } = await generateOk(body, "credit-settle");

  const after = await getCredit(userId);
  assert.equal(
    after.balance,
    INITIAL - tokens.length,
    "생성된 토큰 수만큼만 차감 (maxTokens 200 전부가 아님)",
  );
  assert.equal(after.reserved, 0);
  assert.equal(after.available, INITIAL - tokens.length);

  await readSse(await create(body, key)); // 같은 키로 재생
  assert.deepEqual(
    await getCredit(userId),
    after,
    "재생은 크레딧을 건드리지 않음",
  );
});

test("생성 중에는 maxTokens 만큼 예약되고(중복 요청은 예약을 늘리지 않음), 취소하면 생성된 만큼만 차감된다", async () => {
  const userId = `e2e-credit-${run}-reserve`;
  const { key, body } = await startLong(userId, "credit-reserve"); // maxTokens 5000, 첫 토큰을 받은 상태
  assert.ok(
    INITIAL >= body.maxTokens,
    `테스트 전제: 초기 크레딧(${INITIAL}) >= ${body.maxTokens}`,
  );

  const during = await getCredit(userId);
  assert.equal(during.balance, INITIAL, "아직 차감되지 않음");
  assert.equal(during.reserved, body.maxTokens, "maxTokens 만큼 예약");
  assert.equal(
    during.available,
    INITIAL - body.maxTokens,
    "실제 잔액 = 잔액 - 예약",
  );

  assert.equal((await create(body, key)).status, 409); // 같은 키 중복 요청
  assert.equal(
    (await getCredit(userId)).reserved,
    body.maxTokens,
    "중복 요청이 예약을 더 잡지 않음",
  );

  const cancel = await post("/cancel_document", {
    userId,
    idempotencyKey: key,
  });
  assert.ok([200, 202].includes(cancel.status));
  const settled = await eventually(async () => {
    const c = await getCredit(userId);
    return c.reserved === 0 ? c : null;
  }, "취소 후 예약이 풀리지 않았어요");
  assert.ok(
    settled.balance < INITIAL && settled.balance > INITIAL - body.maxTokens,
    `생성된 만큼만 차감 (잔액 ${settled.balance})`,
  );
  assert.equal(settled.available, settled.balance);
  if (cancel.status === 200)
    assert.equal(settled.balance, INITIAL - (await cancel.json()).tokens);
});

test(
  '크레딧이 부족하면 402 "크레딧이 부족합니다."이고 잔액/예약은 그대로이며, 같은 키로 다시 요청할 수 있다',
  { skip: INITIAL >= 1_000_000 },
  async () => {
    const userId = `e2e-credit-${run}-poor`;
    const key = newKey("credit-poor");

    const res = await create(
      { userId, prompt: "p", maxTokens: INITIAL + 1 },
      key,
    );
    assert.equal(res.status, 402);
    assert.equal((await res.json()).message, "크레딧이 부족합니다.");
    assert.deepEqual(await getCredit(userId), {
      userId,
      balance: INITIAL,
      reserved: 0,
      available: INITIAL,
    });

    // 거절된 요청이 "생성 중" 표시를 남기지 않았으므로, 같은 키로 (모자라지 않게) 다시 요청하면 정상 처리된다
    const retry = await create({ userId, prompt: "p", maxTokens: 100 }, key);
    assert.equal(retry.status, 200);
    const { end } = await readSse(retry);
    assert.equal(
      end?.event === "done" || end?.data?.error === "token_create_fail",
      true,
    );
  },
);

test("같은 유저가 동시에 여러 번 요청해도 크레딧이 음수가 되지 않는다 (예약)", async () => {
  const userId = `e2e-credit-${run}-race`;
  const each = Math.floor(INITIAL * 0.4); // 2건은 들어가고(0.8) 3번째는 모자란다(1.2)
  const keys = [newKey("race"), newKey("race"), newKey("race")];

  const responses = await Promise.all(
    keys.map((key) => create({ userId, prompt: "p", maxTokens: each }, key)),
  );
  const statuses = responses.map((r) => r.status).sort();
  assert.deepEqual(
    statuses,
    [200, 200, 402],
    `동시 요청 3건 중 정확히 2건만 예약돼야 함: ${statuses}`,
  );
  const rejected = responses.find((r) => r.status === 402);
  assert.equal((await rejected.json()).message, "크레딧이 부족합니다.");

  const accepted = [];
  for (let i = 0; i < responses.length; i++) {
    if (responses[i].status === 200) {
      await readSse(responses[i], 1); // 첫 토큰만 받고 연결을 끊는다 (생성은 계속됨)
      accepted.push(keys[i]);
    }
  }
  const during = await getCredit(userId);
  assert.equal(during.balance, INITIAL);
  assert.equal(during.reserved, each * 2);
  assert.ok(
    during.available >= 0,
    `실제 잔액이 음수가 되면 안 됨: ${during.available}`,
  );
  assert.equal(during.available, INITIAL - each * 2);

  // 정리: 둘 다 취소하면 생성된 만큼만 차감되고 예약은 풀린다
  for (const key of accepted)
    assert.ok(
      [200, 202].includes(
        (await post("/cancel_document", { userId, idempotencyKey: key }))
          .status,
      ),
    );
  const final = await eventually(async () => {
    const c = await getCredit(userId);
    return c.reserved === 0 ? c : null;
  }, "취소 후 예약이 풀리지 않았어요");
  assert.ok(
    final.balance >= 0 && final.balance < INITIAL,
    `최종 잔액 ${final.balance}`,
  );
  assert.equal(final.available, final.balance);
});
