// 사용법: node scripts/measure.js [횟수=20] [URL=http://127.0.0.1/create_document]
// 요청을 순서대로 보내면서 첫 응답(firstbyte)과 전체 시간을 출력한다.
const count = Number(process.argv[2] ?? 20);
const url = process.argv[3] ?? "http://127.0.0.1/create_document";
const runId = Date.now().toString(36); // 실행할 때마다 Idempotency-Key가 겹치지 않게

async function once(i) {
  const t0 = performance.now();
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Idempotency-Key": `m-${runId}-${i}`,
    },
    body: JSON.stringify({
      userId: "measure",
      prompt: "hello",
      maxTokens: 1000,
    }),
  });
  const firstByte = performance.now() - t0; // 응답 헤더가 도착한 시점
  await res.text(); // 스트림 끝까지 읽기
  const total = performance.now() - t0;
  return { status: res.status, firstByte, total };
}

(async () => {
  let slow = 0;
  let worst = 0;
  for (let i = 1; i <= count; i++) {
    try {
      const r = await once(i);
      const isSlow = r.firstByte >= 1000;
      if (isSlow) slow++;
      worst = Math.max(worst, r.firstByte);
      console.log(
        `#${i} status=${r.status} firstbyte=${r.firstByte.toFixed(0)}ms total=${r.total.toFixed(0)}ms${isSlow ? "  <-- SLOW" : ""}`,
      );
    } catch (err) {
      console.log(`#${i} ERROR ${err.cause?.code ?? err.message}`);
    }
  }
  console.log(
    `\n${count}회 중 firstbyte 1초 이상: ${slow}회, 최대 ${worst.toFixed(0)}ms`,
  );
})();
