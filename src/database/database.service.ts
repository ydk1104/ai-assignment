import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from "@nestjs/common";
import { Pool } from "pg";

// 서버가 여러 대 동시에 뜰 때 스키마 생성이 겹치지 않도록 쓰는 advisory lock 번호
const MIGRATION_LOCK_ID = 727274;

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS user_token_totals (
  user_id      TEXT PRIMARY KEY,
  total_tokens BIGINT NOT NULL DEFAULT 0 CHECK (total_tokens >= 0),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS token_ledger (
  id              BIGSERIAL PRIMARY KEY,
  user_id         TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  request_hash    TEXT NOT NULL,
  max_tokens      INTEGER NOT NULL CHECK (max_tokens > 0),
  tokens          INTEGER NOT NULL,
  cancelled       BOOLEAN NOT NULL DEFAULT false,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (user_id, idempotency_key)
);

-- 이전 버전에서 만든 테이블 보정
--  - cancelled: 취소로 끝난 요청인지
--  - tokens >= 0: 시작하기 전에 취소하면 0개로 확정될 수 있다 (이전에는 tokens > 0 이었음)
ALTER TABLE token_ledger ADD COLUMN IF NOT EXISTS cancelled BOOLEAN NOT NULL DEFAULT false;
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'token_ledger_tokens_nonneg') THEN
    ALTER TABLE token_ledger DROP CONSTRAINT IF EXISTS token_ledger_tokens_check;
    ALTER TABLE token_ledger ADD CONSTRAINT token_ledger_tokens_nonneg CHECK (tokens >= 0);
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_token_ledger_user_created
  ON token_ledger (user_id, created_at DESC);

-- 유저별 크레딧 현재 상태. 음수가 될 수 없고, 예약은 잔액을 넘을 수 없다 (실제 잔액 = balance - reserved >= 0)
CREATE TABLE IF NOT EXISTS user_credits (
  user_id    TEXT PRIMARY KEY,
  balance    BIGINT NOT NULL CHECK (balance >= 0),
  reserved   BIGINT NOT NULL CHECK (reserved >= 0),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (reserved <= balance)
);

-- 크레딧 원장: 크레딧이 움직인 모든 기록 (GRANT 지급 / RESERVE 예약 / SETTLE 정산 / RELEASE 예약 해제). 추가만 한다.
-- job_id 는 "생성 시도" 하나를 가리킨다. 같은 요청(idempotency_key)이 실패 후 재시도되면 시도마다 job_id 가 다르다.
CREATE TABLE IF NOT EXISTS credit_ledger (
  id              BIGSERIAL PRIMARY KEY,
  user_id         TEXT NOT NULL,
  entry_type      TEXT NOT NULL CHECK (entry_type IN ('GRANT', 'RESERVE', 'SETTLE', 'RELEASE')),
  job_id          TEXT,
  idempotency_key TEXT,
  balance_delta   BIGINT NOT NULL,
  reserved_delta  BIGINT NOT NULL,
  balance_after   BIGINT NOT NULL,
  reserved_after  BIGINT NOT NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
-- 한 시도(job)에는 종류별로 한 줄만: 같은 예약/정산/해제가 두 번 반영되지 않는다
CREATE UNIQUE INDEX IF NOT EXISTS uq_credit_ledger_job_type
  ON credit_ledger (job_id, entry_type) WHERE job_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_credit_ledger_user ON credit_ledger (user_id, id);
CREATE INDEX IF NOT EXISTS idx_credit_ledger_type_created ON credit_ledger (entry_type, created_at);

-- 생성이 완료된 요청의 토큰 내용. 워커가 죽어도 같은 응답을 다시 보내줄 수 있도록 저장한다.
-- 원장(token_ledger)과 같은 트랜잭션에서 저장되므로 "원장에 있으면 내용도 전부 있다".
CREATE TABLE IF NOT EXISTS generated_tokens (
  ledger_id BIGINT       NOT NULL REFERENCES token_ledger (id) ON DELETE CASCADE,
  position  INTEGER      NOT NULL CHECK (position > 0),
  content   VARCHAR(256) NOT NULL,
  PRIMARY KEY (ledger_id, position)
);
`;

@Injectable()
export class DatabaseService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(DatabaseService.name);

  readonly pool = new Pool({
    host: process.env.DB_HOST ?? "localhost",
    port: Number(process.env.DB_PORT ?? 5432),
    user: process.env.DB_USER ?? "app",
    password: process.env.DB_PASSWORD ?? "app_password",
    database: process.env.DB_NAME ?? "app",
    max: 10,
  });

  constructor() {
    this.pool.on("error", (err) =>
      this.logger.error(`idle client error: ${err.message}`),
    );
  }

  async onModuleInit() {
    const client = await this.pool.connect();
    try {
      await client.query("SELECT pg_advisory_lock($1)", [MIGRATION_LOCK_ID]);
      await client.query(SCHEMA_SQL);
      this.logger.log("schema ready");
    } finally {
      await client
        .query("SELECT pg_advisory_unlock($1)", [MIGRATION_LOCK_ID])
        .catch(() => undefined);
      client.release();
    }
  }

  async onModuleDestroy() {
    await this.pool.end();
  }
}
