// 사용법: node scripts/failover-test.js [maxTokens=5000] [URL=http://127.0.0.1/create_document]
//
// 긴 생성을 시작하고 진행 상황을 실시간으로 보여준다. 생성 도중에 이 job을 처리 중인 워커를 죽이면
// 다른 워커가 이어받아 끝까지 처리하는지 확인할 수 있다.
//   1) docker compose logs -f worker      <- "job ... started" 로그에서 어느 워커가 잡았는지 확인
//   2) docker kill nest-app-worker-1      <- 그 워커 컨테이너를 죽이기 (이름은 docker compose ps 로 확인)
//   3) 이 스크립트 출력에서 잠깐(약 10~15초) 멈췄다가 다른 워커가 이어받아 done 까지 가는지 확인
const maxTokens = Number(process.argv[2] ?? 5000);
const url = process.argv[3] ?? "http://127.0.0.1/create_document";
const key = `f-${Date.now().toString(36)}`;
const t0 = Date.now();
const at = () => `[+${((Date.now() - t0) / 1000).toFixed(1)}s]`;

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

// 서버에 연결하지 못했을 때 원인을 알아보기 쉽게 안내한다 (그 외 에러는 null)
function describeConnectionError(err, target) {
  const code = err?.cause?.code ?? err?.code;
  if (
    !["ECONNREFUSED", "ENOTFOUND", "ECONNRESET", "EHOSTUNREACH"].includes(
      code,
    ) &&
    err?.message !== "fetch failed"
  )
    return null;
  return [
    `서버에 연결할 수 없어요: ${target} (${code ?? err.message})`,
    "  - 스택이 떠 있는지 확인하세요: docker compose ps",
    "    (nginx 는 api-1, api-2 가 healthy 가 된 뒤에 시작돼요. API가 못 떴다면 nginx 도 없어서 80번 포트가 닫혀 있어요)",
    "  - API 가 못 떴다면 로그를 보세요: docker compose logs --tail=50 api-1 worker",
    "  - 테스트 전용 스택(npm run test:docker)은 호스트 포트를 열지 않아요. 호스트에서 이 스크립트를 직접 실행하려면 개발 스택(docker compose up -d)을 쓰세요.",
  ].join("\n");
}

(async () => {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", "Idempotency-Key": key },
    body: JSON.stringify({
      userId: "failover-test",
      prompt: "hello",
      maxTokens,
    }),
  });
  if (
    !res.ok ||
    !(res.headers.get("content-type") ?? "").includes("text/event-stream")
  ) {
    console.error(`실패: status=${res.status}`);
    console.error((await res.text()).slice(0, 500));
    process.exit(1);
  }
  console.log(
    `${at()} 연결됨 (Idempotency-Key=${key}, maxTokens=${maxTokens})`,
  );
  console.log(
    "        -> 지금 이 job을 처리 중인 워커를 죽여 보세요 (위 안내 참고)\n",
  );

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  let lastEventAt = Date.now();
  let lastPrintAt = 0;
  let lastTokens = 0;
  let lastToken = "";

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let idx;
    while ((idx = buf.indexOf("\n\n")) !== -1) {
      const ev = parseEvent(buf.slice(0, idx));
      buf = buf.slice(idx + 2);
      if (!ev) continue; // keepalive 주석

      const gap = Date.now() - lastEventAt;
      lastEventAt = Date.now();
      if (gap > 3000)
        console.log(
          `${at()} (${(gap / 1000).toFixed(1)}초 동안 소식 없음 - 워커 장애 복구 중일 수 있어요)`,
        );

      if (ev.event === "done") {
        console.log(`${at()} done: ${ev.data.tokens} tokens`);
        console.log(
          `\n원장에 한 줄만 있어야 해요:\n  docker compose exec postgres psql -U app -d app -c "SELECT idempotency_key, tokens FROM token_ledger WHERE idempotency_key='${key}';"`,
        );
        process.exit(0);
      }
      if (ev.event === "error") {
        console.log(
          `${at()} error: ${ev.data.error} (tokens=${ev.data.tokens})`,
        );
        process.exit(1);
      }
      lastTokens = ev.data.tokens;
      lastToken = String(ev.data.token ?? "");
      if (Date.now() - lastPrintAt >= 1000) {
        lastPrintAt = Date.now();
        console.log(
          `${at()} tokens=${lastTokens} last="${lastToken.slice(0, 30)}${lastToken.length > 30 ? "…" : ""}"`,
        );
      }
    }
  }
  console.log(
    `${at()} 스트림이 done 없이 끝났어요 (마지막 tokens=${lastTokens})`,
  );
  process.exit(1);
})().catch((e) => {
  console.error(describeConnectionError(e, url) ?? e);
  process.exit(1);
});
