// 워커 장애 복구 테스트: 생성 도중에 그 job을 처리 중인 워커 컨테이너를 죽였을 때, 다른 워커가 이어받아 끝까지 처리하는지 확인한다.
// Docker Engine API 로 워커를 직접 kill/start 하므로 test 컨테이너에 /var/run/docker.sock 이 마운트되어 있어야 한다.
const test = require("node:test");
const assert = require("node:assert/strict");
const docker = require("./lib/docker");

const BASE = process.env.BASE_URL ?? "http://127.0.0.1";
const SEED = process.env.RANDOM_SEED
  ? Number(process.env.RANDOM_SEED)
  : undefined;
const FAILOVER_TIMEOUT_MS = Number(process.env.FAILOVER_TIMEOUT_MS ?? 90_000); // 워커를 죽인 뒤 다른 워커가 이어받기까지 기다릴 최대 시간
const MAX_TOKENS = 1000;
const KILL_AFTER_TOKENS = 50; // 이만큼 진행됐을 때 워커를 죽인다

// 고정 seed일 때 정확히 몇 개가 만들어져야 하는지 (서버와 같은 코드로 계산). 이어받은 워커도 같은 seed라서 같은 개수여야 한다
let expectedTotal;
try {
  const { createRng } = require("../dist/common/random");
  const { pickTokenCount } = require("../dist/documents/token-count");
  if (SEED !== undefined)
    expectedTotal = pickTokenCount(MAX_TOKENS, createRng(SEED));
} catch {
  /* dist 없음 */
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const escapeRegExp = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// fn()이 값(null/undefined/false 가 아닌)을 돌려줄 때까지 기다린다
async function waitFor(
  fn,
  {
    timeout = 30_000,
    interval = 250,
    message = "조건이 충족되지 않았어요",
  } = {},
) {
  const deadline = Date.now() + timeout;
  for (;;) {
    const value = await fn();
    if (value) return value;
    if (Date.now() > deadline)
      throw new Error(`${message} (${Math.round(timeout / 1000)}초 대기)`);
    await sleep(interval);
  }
}
const withTimeout = (promise, ms, message) =>
  Promise.race([
    promise,
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error(message)), ms),
    ),
  ]);

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

// done/error 까지 읽는다. 이벤트마다 onEvent 를 호출한다
async function readSse(res, onEvent) {
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
      onEvent?.(ev);
      if (ev.event === "done" || ev.event === "error")
        return { events, end: ev };
    }
  }
  return { events, end: null };
}

// 워커 로그에서 "[호스트] job <id> started (userId=...)" 를 찾아 어느 워커가 어떤 job을 시작했는지 알아낸다
async function findStartedOn(workers, userId, jobId) {
  const re = new RegExp(
    `\\[([0-9a-f]{12})\\] job (\\S+) started \\(userId=${escapeRegExp(userId)},`,
    "g",
  );
  for (const worker of workers) {
    const logs = await docker.logsOf(worker.id);
    for (const m of logs.matchAll(re)) {
      if (!jobId || m[2] === jobId) return { worker, jobId: m[2], host: m[1] };
    }
  }
  return null;
}

test(
  "워커가 죽어도 다른 워커가 job을 이어받아 같은 스트림으로 끝까지 처리한다",
  { timeout: 300_000 },
  async (t) => {
    assert.ok(
      docker.socketAvailable(),
      "도커 소켓(/var/run/docker.sock)이 필요해요. docker-compose.test.yml 의 test 서비스에 마운트돼 있는지 확인하세요",
    );

    const project =
      (await docker.ownProject()) ??
      process.env.COMPOSE_PROJECT ??
      "nest-app-test";
    const workers = await waitFor(
      async () => {
        const list = await docker.runningWorkers(project);
        return list.length >= 2 ? list : null;
      },
      {
        timeout: 60_000,
        message: `실행 중인 워커가 2대 이상 필요해요 (프로젝트 ${project})`,
      },
    );

    const run = Date.now().toString(36);
    const userId = `e2e-failover-${run}`;
    const key = `e2e-failover-${run}`;
    const body = { userId, prompt: "failover", maxTokens: MAX_TOKENS };
    const create = (extra = {}) =>
      fetch(`${BASE}/create_document`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Idempotency-Key": key,
          ...extra,
        },
        body: JSON.stringify(body),
      });

    // ---- 1) 생성 시작 (스트림은 계속 열어둔다) ----
    const res = await create();
    assert.equal(res.status, 200);
    const timeline = []; // 토큰을 받은 시각
    const stream = readSse(res, (ev) => {
      if (ev.event === "message") timeline.push({ at: Date.now(), id: ev.id });
    });
    stream.catch(() => {}); // 아래에서 await 하기 전에 거부되어도 처리되지 않은 에러가 되지 않도록

    // ---- 2) 이 job을 처리 중인 워커를 찾는다 ----
    const first = await waitFor(() => findStartedOn(workers, userId), {
      timeout: 30_000,
      message: "이 job을 시작한 워커를 로그에서 찾지 못했어요",
    });
    t.diagnostic(
      `처리 중인 워커: ${first.worker.name} (${first.host}), job ${first.jobId}`,
    );

    // 테스트가 끝나면(실패해도) 죽인 워커를 다시 살려둔다
    t.after(async () => {
      try {
        await docker.start(first.worker.id);
        await waitFor(() => docker.isRunning(first.worker.id), {
          timeout: 30_000,
          message: "죽인 워커가 다시 시작되지 않았어요",
        });
      } catch (err) {
        console.error(`워커 복구 실패: ${err.message}`);
      }
    });

    await waitFor(() => (timeline.length >= KILL_AFTER_TOKENS ? true : null), {
      timeout: 30_000,
      message: `토큰 ${KILL_AFTER_TOKENS}개가 오지 않았어요`,
    });

    // ---- 3) 워커를 죽인다 (SIGKILL: 정리 없이 갑자기 죽는 상황) ----
    const tokensAtKill = timeline.length;
    await docker.kill(first.worker.id);
    const killedAt = Date.now();
    t.diagnostic(`토큰 ${tokensAtKill}개 시점에 ${first.worker.name} kill`);
    if (expectedTotal !== undefined)
      assert.ok(
        tokensAtKill < expectedTotal,
        "테스트 전제: 죽일 때 아직 생성 중이어야 함",
      );

    // ---- 4) 다른 워커가 같은 job을 이어받는다 ----
    const others = workers.filter((w) => w.id !== first.worker.id);
    const takeover = await waitFor(
      () => findStartedOn(others, userId, first.jobId),
      {
        timeout: FAILOVER_TIMEOUT_MS,
        message: `다른 워커가 job ${first.jobId} 를 이어받지 않았어요`,
      },
    );
    const takeoverAfter = Date.now() - killedAt;
    t.diagnostic(
      `${takeover.worker.name} 이(가) ${(takeoverAfter / 1000).toFixed(1)}초 뒤에 job을 이어받음`,
    );
    assert.notEqual(takeover.worker.id, first.worker.id);

    // ---- 5) 같은 스트림이 끝까지 간다 ----
    const { events, end } = await withTimeout(
      stream,
      FAILOVER_TIMEOUT_MS + 120_000,
      "스트림이 끝나지 않았어요",
    );
    assert.equal(
      end?.event,
      "done",
      `done 으로 끝나야 함: ${JSON.stringify(end)}`,
    );
    assert.equal(end.data.cancelled, false);

    const tokens = events.filter((e) => e.event === "message");
    tokens.forEach((e, i) => {
      assert.equal(
        e.id,
        i + 1,
        "워커가 바뀌어도 토큰 번호는 1부터 빠짐없이 한 번씩",
      );
      assert.equal(
        e.data.token,
        String(i + 1),
        "이어받은 워커가 만든 내용도 같아야 함 (테스트 모드: 내용 = 번호)",
      );
    });
    assert.equal(end.data.tokens, tokens.length);
    if (expectedTotal !== undefined)
      assert.equal(
        tokens.length,
        expectedTotal,
        "같은 seed라서 이어받은 워커도 같은 개수를 만들어야 함",
      );

    // 장애 복구 중에 소식이 끊겼던 시간
    let maxGap = 0;
    for (let i = 1; i < timeline.length; i++)
      maxGap = Math.max(maxGap, timeline[i].at - timeline[i - 1].at);
    t.diagnostic(`토큰이 끊겼던 최대 시간: ${(maxGap / 1000).toFixed(1)}초`);
    assert.ok(
      maxGap >= 2000,
      `워커 복구로 인한 중단이 보여야 함 (최대 ${maxGap}ms)`,
    );
    assert.ok(
      maxGap <= FAILOVER_TIMEOUT_MS,
      `복구가 너무 오래 걸림 (${maxGap}ms)`,
    );

    // ---- 6) 결과는 한 번만 기록되고, 같은 키로 다시 요청하면 DB 내용이 재생된다 ----
    const replayRes = await create();
    assert.equal(replayRes.headers.get("idempotent-replayed"), "true");
    const replay = await readSse(replayRes);
    assert.equal(
      replay.events.filter((e) => e.event === "message").length,
      tokens.length,
    );
    assert.equal(replay.end.data.tokens, tokens.length);

    if (process.env.DB_HOST) {
      const { Pool } = require("pg");
      const pool = new Pool({
        host: process.env.DB_HOST,
        port: Number(process.env.DB_PORT ?? 5432),
        user: process.env.DB_USER ?? "app",
        password: process.env.DB_PASSWORD ?? "app_password",
        database: process.env.DB_NAME ?? "app",
      });
      try {
        const ledger = await pool.query(
          "SELECT id, tokens FROM token_ledger WHERE user_id = $1 AND idempotency_key = $2",
          [userId, key],
        );
        assert.equal(ledger.rows.length, 1, "원장에는 한 줄만 있어야 함");
        assert.equal(ledger.rows[0].tokens, tokens.length);
        const stored = await pool.query(
          "SELECT COUNT(*)::int AS n FROM generated_tokens WHERE ledger_id = $1",
          [ledger.rows[0].id],
        );
        assert.equal(stored.rows[0].n, tokens.length);
        const totals = await pool.query(
          "SELECT total_tokens FROM user_token_totals WHERE user_id = $1",
          [userId],
        );
        assert.equal(
          Number(totals.rows[0].total_tokens),
          tokens.length,
          "유저 합계에는 한 번만 반영돼야 함",
        );
      } finally {
        await pool.end();
      }
    } else {
      t.diagnostic(
        "DB_HOST 가 없어 DB 직접 확인은 생략 (재생 응답으로만 확인)",
      );
    }
  },
);
