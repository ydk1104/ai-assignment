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
  tokens          INTEGER NOT NULL CHECK (tokens > 0),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (user_id, idempotency_key)
);

CREATE INDEX IF NOT EXISTS idx_token_ledger_user_created
  ON token_ledger (user_id, created_at DESC);

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
