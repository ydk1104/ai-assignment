// 사용법: node scripts/cancel-test.js [cancelAfter=50] [BASE_URL=http://127.0.0.1]
//
// 긴 생성(maxTokens 5000 -> 최소 1500개)을 시작하고, 토큰을 cancelAfter개 받은 시점에 취소 API를 호출한다.
// 확인하는 것:
//   - 취소 응답이 200 / status "cancelled" 이고, 스트림이 done(cancelled=true)으로 끝나는지
//   - 취소 시점의 개수로 확정되어(= 조기 중단) 받은 토큰 수 = done 개수 = 취소 응답의 개수인지
//   - 같은 키로 다시 요청하면(전체 재생) 같은 개수/내용이 오는지, 취소를 한 번 더 호출해도 같은 응답인지
//
// 종료 코드: 0=PASS, 1=FAIL, 2=판단 불가(10% 확률로 일부러 내는 token_create_fail 에 걸린 경우)
const cancelAfter = Number(process.argv[2] ?? 50);
const base = process.argv[3] ?? 'http://127.0.0.1';
const createUrl = `${base}/create_document`;
const cancelUrl = `${base}/cancel_document`;
const userId = 'cancel-test';
const key = `c-${Date.now().toString(36)}`;
const MIN_TOTAL = 1500; // maxTokens 5000 의 30%

function parseEvent(block) {
  const ev = { id: null, event: 'message', data: null };
  let seen = false;
  for (const line of block.split('\n')) {
    if (line.startsWith('id:')) { ev.id = Number(line.slice(3).trim()); seen = true; }
    else if (line.startsWith('event:')) { ev.event = line.slice(6).trim(); seen = true; }
    else if (line.startsWith('data:')) { ev.data = JSON.parse(line.slice(5).trim()); seen = true; }
  }
  return seen ? ev : null;
}

// onToken 콜백을 줄 수 있는 SSE 읽기. done/error 에서 끝난다
async function readAll(res, onToken) {
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  const events = [];
  let buf = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) return events;
    buf += decoder.decode(value, { stream: true });
    let idx;
    while ((idx = buf.indexOf('\n\n')) !== -1) {
      const ev = parseEvent(buf.slice(0, idx));
      buf = buf.slice(idx + 2);
      if (!ev) continue;
      events.push(ev);
      if (ev.event === 'message') onToken?.(events.filter((e) => e.event === 'message').length);
      if (ev.event === 'error' || ev.event === 'done') return events;
    }
  }
}

const createReq = (extra = {}) =>
  fetch(createUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Idempotency-Key': key, ...extra },
    body: JSON.stringify({ userId, prompt: 'hello', maxTokens: 5000 }),
  });
const cancelReq = async () => {
  const r = await fetch(cancelUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ userId, idempotencyKey: key }),
  });
  return { status: r.status, body: await r.json().catch(() => null) };
};

(async () => {
  // 1) 생성 시작, cancelAfter개를 받는 순간 취소 API 호출 (스트림은 계속 읽는다)
  const r1 = await createReq();
  if (!r1.ok) {
    console.error(`생성 요청 실패: status=${r1.status}`, (await r1.text()).slice(0, 300));
    process.exit(1);
  }
  let cancelCall = null;
  let cancelCalledAt = 0;
  const events = await readAll(r1, (count) => {
    if (count === cancelAfter && !cancelCall) {
      cancelCalledAt = count;
      console.log(`토큰 ${count}개 받음 -> 취소 API 호출`);
      cancelCall = cancelReq();
    }
  });
  const tokens = events.filter((e) => e.event === 'message');
  const end = events[events.length - 1];
  if (end?.event === 'error') {
    console.log(`\n판단 불가: 생성 중 ${end.data.error} 발생 (10% 확률로 일부러 내는 에러). 다시 실행해 주세요.`);
    process.exit(2);
  }
  const cancel = cancelCall ? await cancelCall : null;
  console.log(`스트림 종료: 토큰 ${tokens.length}개, done=${JSON.stringify(end?.data)}`);
  console.log(`취소 응답: status=${cancel?.status} body=${JSON.stringify(cancel?.body)}`);

  // 2) 같은 키로 전체 재생
  const r2 = await createReq({ 'Last-Event-ID': '0' });
  const replayEvents = r2.ok ? await readAll(r2) : [];
  const replayTokens = replayEvents.filter((e) => e.event === 'message');
  const replayEnd = replayEvents[replayEvents.length - 1];
  console.log(`재생: 토큰 ${replayTokens.length}개, replayed=${r2.headers.get('idempotent-replayed')}, done=${JSON.stringify(replayEnd?.data)}`);

  // 3) 취소를 한 번 더
  const cancel2 = await cancelReq();
  console.log(`취소 재호출: status=${cancel2.status} body=${JSON.stringify(cancel2.body)}`);

  const n = tokens.length;
  const checks = {
    '취소 응답이 200 cancelled': cancel?.status === 200 && cancel.body?.status === 'cancelled',
    '스트림이 done(cancelled=true)으로 끝남': end?.event === 'done' && end.data.cancelled === true,
    '받은 토큰이 1번부터 빠짐없이 연속': tokens.every((e, i) => e.id === i + 1),
    '받은 토큰 수 = done 개수 = 취소 응답 개수': n === end?.data?.tokens && n === cancel?.body?.tokens,
    [`취소 시점 이후에 곧 멈춤 (${cancelCalledAt}개 이상, 전체 최소 ${MIN_TOTAL}개보다 훨씬 적음)`]: n >= cancelCalledAt && n < MIN_TOTAL,
    '같은 키 재생: 같은 개수/내용, cancelled=true': replayTokens.length === n && replayEnd?.data?.cancelled === true && replayTokens.every((e, i) => e.data.token === tokens[i].data.token),
    '취소 재호출도 같은 응답': cancel2.status === 200 && cancel2.body?.tokens === n && cancel2.body?.status === 'cancelled',
  };
  let ok = true;
  for (const [name, pass] of Object.entries(checks)) {
    console.log(`  ${pass ? 'OK  ' : 'FAIL'} ${name}`);
    ok &&= pass;
  }
  console.log(ok ? '\nPASS' : '\nFAIL');
  console.log(`\nDB 확인 (tokens=${n}, cancelled=t 이고 합계에 ${n}만 반영돼야 해요):`);
  console.log(`  docker compose exec postgres psql -U app -d app -c "SELECT tokens, max_tokens, cancelled FROM token_ledger WHERE idempotency_key='${key}';"`);
  process.exit(ok ? 0 : 1);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
