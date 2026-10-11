// 사용법: node scripts/resume-test.js [key=r-${Date.now().toString(36)}]
//
// 1) 새 Idempotency-Key로 생성을 시작하고, 토큰 3개만 받은 뒤 연결을 끊는다 (생성은 워커에서 계속된다)
// 2) 같은 키 + Last-Event-ID 로 다시 요청한다
//    - 아직 생성 중이면 409 "처리중입니다." 를 받는다 -> 잠시 기다렸다 재시도
//    - 생성이 끝났으면 DB에 저장된 토큰을 Last-Event-ID 다음 번호부터 이어받는다 (Idempotent-Replayed: true)
// 3) Last-Event-ID: 0 으로 전체를 다시 받아서, 1)에서 실시간으로 받은 토큰과 저장된 토큰의 내용이 같은지 비교한다
//
// 종료 코드: 0=PASS, 1=FAIL, 2=판단 불가(10% 확률로 일부러 내는 token_create_fail 때문에 다시 실행 필요)
const url = "http://127.0.0.1/create_document";
const key = process.argv[2] ?? `r-${Date.now().toString(36)}`;
console.log(key);
const body = JSON.stringify({
  userId: "resume-test",
  prompt: "hello",
  maxTokens: 1000,
});
const headers = { "Content-Type": "application/json", "Idempotency-Key": key };
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// SSE 이벤트 한 덩어리 파싱. ':'로 시작하는 주석(keepalive)만 있으면 null
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

// stopAfter를 주면 그 개수만 읽고 연결을 끊는다
async function readEvents(res, stopAfter) {
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  const events = [];
  let buf = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) return events;
    buf += decoder.decode(value, { stream: true });
    let idx;
    while ((idx = buf.indexOf("\n\n")) !== -1) {
      const ev = parseEvent(buf.slice(0, idx));
      buf = buf.slice(idx + 2);
      if (!ev) continue;
      events.push(ev);
      if (ev.event === "error" || ev.event === "done") return events;
      if (stopAfter && events.length >= stopAfter) {
        await reader.cancel(); // 연결 끊기
        return events;
      }
    }
  }
}

const isSse = (res) =>
  res.ok &&
  (res.headers.get("content-type") ?? "").includes("text/event-stream");
const post = (extra = {}) =>
  fetch(url, { method: "POST", headers: { ...headers, ...extra }, body });
const snippet = (t) => (t.length > 24 ? `${t.slice(0, 24)}…` : t);

async function failResponse(label, res) {
  console.error(
    `${label} 실패: status=${res.status} content-type=${res.headers.get("content-type")}`,
  );
  console.error((await res.text()).slice(0, 500));
  process.exit(1);
}

function inconclusive(message) {
  console.log(`\n판단 불가: ${message}`);
  process.exit(2);
}

(async () => {
  // ---- 1) 생성 시작 -> 토큰 3개만 받고 끊기 ----
  const r1 = await post();
  if (!isSse(r1)) await failResponse("1차 연결", r1);
  const first = await readEvents(r1, 3);
  const err = first.find((e) => e.event === "error");
  if (err)
    inconclusive(
      `1차 연결 중 ${err.data.error} 발생 (10% 확률로 일부러 내는 에러). 다시 실행해 주세요.`,
    );
  if (first.length === 0) await failResponse("1차 연결(이벤트 없음)", r1);
  const lastId = first[first.length - 1].id;
  console.log(`1차 연결: 토큰 ${first.length}개 받고 끊음`);
  for (const e of first)
    console.log(`          #${e.id} "${snippet(e.data.token)}"`);

  // ---- 2) 같은 키로 재요청 (생성 중이면 409 -> 재시도) ----
  let busy = 0;
  let busyMessageOk = true;
  for (let attempt = 0; attempt < 240; attempt++) {
    const r2 = await post({ "Last-Event-ID": String(lastId) });

    if (r2.status === 409) {
      const message = (await r2.json()).message;
      if (message !== "처리중입니다.") busyMessageOk = false;
      if (++busy === 1)
        console.log(
          `2차 연결: 409 "${message}" (생성 중, Retry-After=${r2.headers.get("retry-after")})`,
        );
      await sleep(500);
      continue;
    }
    if (!isSse(r2)) await failResponse("2차 연결", r2);
    if (r2.headers.get("idempotent-replayed") !== "true") {
      await r2.body.cancel();
      inconclusive(
        "첫 생성이 token_create_fail 로 실패해서 같은 키로 새 생성이 시작됐어요(10% 확률). 다시 실행해 주세요.",
      );
    }

    const rest = await readEvents(r2);
    const tokens = rest.filter((e) => e.event === "message");
    const done = rest[rest.length - 1];
    const total = done?.data?.tokens;
    console.log(
      `2차 연결: 409를 ${busy}번 받은 뒤 이어받기 (Last-Event-ID=${lastId}, replayed=true)`,
    );
    console.log(
      `          토큰 #${tokens[0]?.id} ~ #${tokens[tokens.length - 1]?.id} (${tokens.length}개) + done(전체 ${total}개)`,
    );

    // ---- 3) 처음부터 전체를 받아 실시간으로 받은 내용과 비교 ----
    const r3 = await post({ "Last-Event-ID": "0" });
    if (!isSse(r3)) await failResponse("3차 연결", r3);
    const all = (await readEvents(r3)).filter((e) => e.event === "message");

    const checks = {
      "이어받은 토큰이 Last-Event-ID 다음 번호부터 빠짐없이 연속": tokens.every(
        (e, i) => e.id === lastId + 1 + i,
      ),
      "done 이벤트로 끝나고 전체 개수가 맞음":
        done?.event === "done" && total === lastId + tokens.length,
      '생성 중 재요청에 "처리중입니다." 회신': busyMessageOk,
      "전체 재생이 1번부터 연속이고 개수가 total과 같음":
        all.length === total && all.every((e, i) => e.id === i + 1),
      "모든 토큰이 내용(문자열, 256자 이하)을 가짐": all.every(
        (e) =>
          typeof e.data.token === "string" &&
          e.data.token.length > 0 &&
          e.data.token.length <= 256,
      ),
      "실시간으로 받은 토큰 내용 = DB에 저장된 내용": first.every(
        (e) => all[e.id - 1]?.data.token === e.data.token,
      ),
      "이어받은 내용 = 전체 재생의 같은 구간": tokens.every(
        (e) => all[e.id - 1]?.data.token === e.data.token,
      ),
    };
    let ok = true;
    for (const [name, pass] of Object.entries(checks)) {
      console.log(`  ${pass ? "OK  " : "FAIL"} ${name}`);
      ok &&= pass;
    }
    if (busy === 0)
      console.log(
        '  참고: 재요청 시점에 이미 생성이 끝나 "처리중입니다."는 확인하지 못했어요.',
      );
    console.log(ok ? "\nPASS" : "\nFAIL");
    process.exit(ok ? 0 : 1);
  }
  console.error("2분 안에 생성이 끝나지 않았어요.");
  process.exit(1);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
