// 테스트가 끝난 뒤 DB의 최종 상태가 서로 맞는지 확인한다 (원장 / 토큰 내용 / 유저별 합계).
// DB 접속 정보는 DB_HOST, DB_PORT, DB_USER, DB_PASSWORD, DB_NAME 환경변수를 쓴다.
const { Pool } = require("pg");

const pool = new Pool({
  host: process.env.DB_HOST ?? "localhost",
  port: Number(process.env.DB_PORT ?? 5432),
  user: process.env.DB_USER ?? "app",
  password: process.env.DB_PASSWORD ?? "app_password",
  database: process.env.DB_NAME ?? "app",
});

const checks = [
  {
    name: "유저별 합계 = 그 유저의 원장 tokens 합계",
    sql: `SELECT t.user_id, t.total_tokens, COALESCE(SUM(l.tokens), 0) AS ledger_sum
          FROM user_token_totals t
          LEFT JOIN token_ledger l ON l.user_id = t.user_id
          GROUP BY t.user_id, t.total_tokens
          HAVING t.total_tokens <> COALESCE(SUM(l.tokens), 0)`,
  },
  {
    name: "원장에 있는 유저는 모두 합계 행이 있음",
    sql: `SELECT DISTINCT l.user_id FROM token_ledger l
          LEFT JOIN user_token_totals t ON t.user_id = l.user_id
          WHERE t.user_id IS NULL`,
  },
  {
    name: "원장 tokens = 저장된 토큰 내용 개수이고 번호가 1..tokens 로 빠짐없이 이어짐",
    sql: `SELECT l.id, l.tokens, COUNT(g.position) AS stored, COALESCE(MAX(g.position), 0) AS max_position
          FROM token_ledger l
          LEFT JOIN generated_tokens g ON g.ledger_id = l.id
          GROUP BY l.id, l.tokens
          HAVING COUNT(g.position) <> l.tokens OR COALESCE(MAX(g.position), 0) <> l.tokens`,
  },
  {
    name: "개수 범위: 취소가 아니면 maxTokens의 30~100%, 취소면 maxTokens 이하",
    sql: `SELECT id, tokens, max_tokens, cancelled FROM token_ledger
          WHERE tokens > max_tokens
             OR (NOT cancelled AND tokens * 10 < max_tokens * 3)`,
  },
  {
    name: "토큰 내용은 1~256자",
    sql: `SELECT ledger_id, position FROM generated_tokens
          WHERE char_length(content) < 1 OR char_length(content) > 256 LIMIT 5`,
  },
  // ---------------------------------------------------------------- 크레딧
  {
    name: "크레딧: 잔액/예약은 음수가 아니고, 예약은 잔액을 넘지 않음 (실제 잔액 >= 0)",
    sql: `SELECT user_id, balance, reserved FROM user_credits
          WHERE balance < 0 OR reserved < 0 OR reserved > balance`,
  },
  {
    name: "크레딧: 현재 잔액/예약 = 크레딧 원장의 변동 합계",
    sql: `SELECT c.user_id, c.balance, c.reserved,
                 COALESCE(l.balance_sum, 0) AS ledger_balance, COALESCE(l.reserved_sum, 0) AS ledger_reserved
          FROM user_credits c
          LEFT JOIN (SELECT user_id, SUM(balance_delta) AS balance_sum, SUM(reserved_delta) AS reserved_sum
                     FROM credit_ledger GROUP BY user_id) l ON l.user_id = c.user_id
          WHERE c.balance <> COALESCE(l.balance_sum, 0) OR c.reserved <> COALESCE(l.reserved_sum, 0)`,
  },
  {
    name: "크레딧: 예약된 금액 = 아직 정산/해제되지 않은 예약의 합계",
    sql: `SELECT c.user_id, c.reserved, COALESCE(o.open_amount, 0) AS open_amount
          FROM user_credits c
          LEFT JOIN (SELECT r.user_id, SUM(r.reserved_delta) AS open_amount
                     FROM credit_ledger r
                     WHERE r.entry_type = 'RESERVE'
                       AND NOT EXISTS (SELECT 1 FROM credit_ledger d
                                       WHERE d.job_id = r.job_id AND d.entry_type IN ('SETTLE', 'RELEASE'))
                     GROUP BY r.user_id) o ON o.user_id = c.user_id
          WHERE c.reserved <> COALESCE(o.open_amount, 0)`,
  },
  {
    name: "크레딧: 한 번의 예약은 정산 또는 해제 중 하나로만 닫히고, 예약 없는 정산/해제는 없음",
    sql: `SELECT job_id FROM credit_ledger WHERE entry_type IN ('SETTLE', 'RELEASE') GROUP BY job_id HAVING COUNT(*) > 1
          UNION ALL
          SELECT d.job_id FROM credit_ledger d
          WHERE d.entry_type IN ('SETTLE', 'RELEASE')
            AND NOT EXISTS (SELECT 1 FROM credit_ledger r WHERE r.job_id = d.job_id AND r.entry_type = 'RESERVE')`,
  },
  {
    name: "크레딧: 정산/해제는 예약했던 금액만큼 예약을 풀고, 정산 차감액은 예약액을 넘지 않음",
    sql: `SELECT d.job_id, d.entry_type, d.balance_delta, d.reserved_delta, r.reserved_delta AS reserved_amount
          FROM credit_ledger d
          JOIN credit_ledger r ON r.job_id = d.job_id AND r.entry_type = 'RESERVE'
          WHERE d.entry_type IN ('SETTLE', 'RELEASE')
            AND (d.reserved_delta <> -r.reserved_delta
                 OR (d.entry_type = 'RELEASE' AND d.balance_delta <> 0)
                 OR (d.entry_type = 'SETTLE' AND (d.balance_delta > 0 OR -d.balance_delta > r.reserved_delta)))`,
  },
  {
    name: "크레딧: 완료된 요청마다 정산이 한 번 있고, 차감액 = 토큰 원장의 토큰 수",
    sql: `SELECT l.id, l.tokens, -c.balance_delta AS charged
          FROM token_ledger l
          LEFT JOIN credit_ledger c
            ON c.user_id = l.user_id AND c.idempotency_key = l.idempotency_key AND c.entry_type = 'SETTLE'
          WHERE c.id IS NULL OR -c.balance_delta <> l.tokens`,
  },
  {
    name: "크레딧: 유저별 차감 합계 = 토큰 사용 합계 (user_token_totals)",
    sql: `SELECT t.user_id, t.total_tokens, COALESCE(s.used, 0) AS credit_used
          FROM user_token_totals t
          LEFT JOIN (SELECT user_id, -SUM(balance_delta) AS used
                     FROM credit_ledger WHERE entry_type = 'SETTLE' GROUP BY user_id) s ON s.user_id = t.user_id
          WHERE t.total_tokens <> COALESCE(s.used, 0)`,
  },
];

(async () => {
  let failed = 0;
  for (const check of checks) {
    const { rows } = await pool.query(check.sql);
    if (rows.length === 0) {
      console.log(`OK   ${check.name}`);
    } else {
      failed++;
      console.log(`FAIL ${check.name}`);
      console.log("     ", JSON.stringify(rows.slice(0, 5)));
    }
  }
  const { rows } = await pool.query(
    `SELECT COUNT(*) AS requests, COALESCE(SUM(tokens), 0) AS tokens,
            COUNT(*) FILTER (WHERE cancelled) AS cancelled
     FROM token_ledger`,
  );
  console.log(
    `\n원장 ${rows[0].requests}건 (취소 ${rows[0].cancelled}건), 토큰 합계 ${rows[0].tokens}`,
  );
  const credit = await pool.query(
    `SELECT COUNT(*) AS users, COALESCE(SUM(balance), 0) AS balance, COALESCE(SUM(reserved), 0) AS reserved,
            (SELECT COUNT(*) FROM credit_ledger) AS entries
     FROM user_credits`,
  );
  console.log(
    `크레딧: 유저 ${credit.rows[0].users}명, 잔액 합계 ${credit.rows[0].balance}, 예약 합계 ${credit.rows[0].reserved}, 원장 ${credit.rows[0].entries}줄`,
  );
  await pool.end();
  console.log(failed === 0 ? "PASS" : "FAIL");
  process.exit(failed === 0 ? 0 : 1);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
