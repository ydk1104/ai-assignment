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
  await pool.end();
  console.log(failed === 0 ? "PASS" : "FAIL");
  process.exit(failed === 0 ? 0 : 1);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
