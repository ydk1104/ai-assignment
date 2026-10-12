// token_create_fail 경로 테스트. 항상 도중에 실패하는 고정 seed(RANDOM_SEED)로 띄운 스택에서 실행한다 (TEST_PHASE=failure).
// 같은 seed면 실패 여부/지점이 항상 같으므로, 서버와 같은 코드로 "몇 번째 토큰에서 실패해야 하는지"를 계산해 정확히 단언한다.
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
  test(`maxTokens=${maxTokens}: 정해진 지점에서 token_create_fail 로 끝난다`, async () => {
    const { at, total } = await expectedFailure(maxTokens);
    const res = await create(
      { userId: "e2e-fail", prompt: "p", maxTokens },
      newKey(`fail${maxTokens}`),
    );
    assert.equal(res.status, 200);
    const { tokens, end } = await readSse(res);

    assert.equal(
      tokens.length,
      at,
      `${total}개를 만들려다 ${at}번째에서 실패해야 함`,
    );
    tokens.forEach((e, i) => assert.equal(e.id, i + 1));
    assert.equal(end.event, "error");
    assert.equal(end.data.error, "token_create_fail");
    assert.equal(end.data.tokens, at);
  });
}

test("실패한 요청은 기록되지 않고, 같은 키로 다시 요청하면 새로 생성해서 같은 지점에서 다시 실패한다", async () => {
  const { at } = await expectedFailure(1000);
  const body = { userId: "e2e-fail-retry", prompt: "p", maxTokens: 1000 };
  const key = newKey("retry");

  const first = await readSse(await create(body, key));
  assert.equal(first.end.data.error, "token_create_fail");
  assert.equal(first.tokens.length, at);

  // 원장에 없으므로 취소할 것도 없고, 재생이 아니라 새 생성이다
  assert.equal((await cancel(body.userId, key)).status, 404);
  const retryRes = await create(body, key);
  assert.equal(retryRes.status, 200);
  assert.equal(retryRes.headers.get("idempotent-replayed"), null);
  const second = await readSse(retryRes);
  assert.equal(second.tokens.length, at);
  assert.equal(second.end.data.error, "token_create_fail");
});

test("에러 지점보다 앞서 취소하면 에러 대신 취소로 확정된다", async () => {
  const { at } = await expectedFailure(1000);
  assert.ok(at >= 100, `테스트 전제: 실패 지점(${at})이 충분히 뒤여야 함`);
  const body = { userId: "e2e-fail-cancel", prompt: "p", maxTokens: 1000 };
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

  // 취소로 확정된 결과는 같은 키로 다시 요청하면 그대로 재생된다
  const replayRes = await create(body, key, { "Last-Event-ID": "0" });
  assert.equal(replayRes.headers.get("idempotent-replayed"), "true");
  const replay = await readSse(replayRes);
  assert.equal(replay.tokens.length, tokens.length);
  assert.equal(replay.end.data.cancelled, true);
});
