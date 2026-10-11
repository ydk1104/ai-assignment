// 사용법: node scripts/resume-test.js [URL=http://127.0.0.1/create_document]
// 1) 이벤트 3개만 받고 연결을 끊은 뒤
// 2) 같은 Idempotency-Key + Last-Event-ID 로 재연결해서 이어받는지 확인한다.
const url = process.argv[2] ?? "http://127.0.0.1/create_document";
const key = `r-${Date.now().toString(36)}`;
const body = JSON.stringify({
  userId: "resume-test",
  prompt: "hello",
  maxTokens: 1000,
});
const baseHeaders = {
  "Content-Type": "application/json",
  "Idempotency-Key": key,
};

function parseEvent(block) {
  const ev = { id: null, event: "message", data: null };
  for (const line of block.split("\n")) {
    if (line.startsWith("id:")) ev.id = Number(line.slice(3).trim());
    else if (line.startsWith("event:")) ev.event = line.slice(6).trim();
    else if (line.startsWith("data:"))
      ev.data = JSON.parse(line.slice(5).trim());
  }
  return ev;
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
      events.push(parseEvent(buf.slice(0, idx)));
      buf = buf.slice(idx + 2);
      if (stopAfter && events.length >= stopAfter) {
        await reader.cancel(); // 연결 끊기
        return events;
      }
    }
  }
}

// SSE가 아닌 응답(502, 400, 500 등)이면 원인을 그대로 보여주고 종료한다
async function assertSse(res, label) {
  const type = res.headers.get("content-type") ?? "";
  if (res.ok && type.includes("text/event-stream")) return;
  console.error(`${label} 실패: status=${res.status} content-type=${type}`);
  console.error((await res.text()).slice(0, 500));
  process.exit(1);
}

(async () => {
  const r1 = await fetch(url, { method: "POST", headers: baseHeaders, body });
  await assertSse(r1, "1차 연결");
  const first = await readEvents(r1, 3);
  const lastId = first[first.length - 1].id;
  console.log(
    `1차 연결: ${first.length}개 받고 끊음 (id: ${first.map((e) => e.id).join(", ")})`,
  );

  const r2 = await fetch(url, {
    method: "POST",
    headers: { ...baseHeaders, "Last-Event-ID": String(lastId) },
    body,
  });
  await assertSse(r2, "2차 연결");
  const rest = await readEvents(r2);
  const progress = rest.filter((e) => e.event === "message");
  const done = rest[rest.length - 1];
  console.log(
    `2차 연결: Last-Event-ID=${lastId}, replayed=${r2.headers.get("idempotent-replayed")}`,
  );
  console.log(
    `          받은 id: ${progress.map((e) => e.id).join(", ")} + done(${done?.data?.tokens})`,
  );

  const ok =
    r2.headers.get("idempotent-replayed") === "true" &&
    progress.every(
      (e, i) => e.id > lastId && (i === 0 || e.id > progress[i - 1].id),
    ) &&
    done?.event === "done" &&
    progress[progress.length - 1]?.id === done.data.tokens &&
    first.length + progress.length === 10; // 1차 + 2차 = 전체 10단계, 중복/누락 없음
  console.log(ok ? "\nPASS: 끊긴 지점부터 중복/누락 없이 이어받음" : "\nFAIL");
  process.exitCode = ok ? 0 : 1;
})().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
