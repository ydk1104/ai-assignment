import { Injectable, UnprocessableEntityException } from "@nestjs/common";
import type { PoolClient } from "pg";
import { DatabaseService } from "../database/database.service";

/** 토큰 내용을 한 번에 몇 개씩 INSERT 할지 */
const INSERT_BATCH = 2000;

export interface RecordInput {
  userId: string;
  idempotencyKey: string;
  requestHash: string;
  maxTokens: number;
  /** 생성한 토큰들의 내용. 1번째 토큰이 contents[0]. 토큰 수 = contents.length */
  contents: string[];
  /** 취소로 중단되어 그때까지 만든 것만으로 확정한 경우 true */
  cancelled?: boolean;
}

export interface RecordResult {
  tokens: number;
  /** true면 같은 Idempotency-Key로 이미 처리된 요청 (이번엔 DB에 쌓지 않음) */
  replayed: boolean;
}

export interface StoredResult {
  /** 원장 행 id (BIGINT라 문자열) */
  id: string;
  tokens: number;
  requestHash: string;
  /** 취소로 끝난 요청이면 true (그때까지 만든 토큰만큼만 저장되어 있음) */
  cancelled: boolean;
}

export interface StoredToken {
  position: number;
  content: string;
}

@Injectable()
export class TokenLedgerService {
  constructor(private readonly db: DatabaseService) {}

  /**
   * 원장(token_ledger)에 한 줄 추가하고, 토큰 내용(generated_tokens)과 유저별 합계(user_token_totals)를 함께 저장한다.
   * 셋은 한 트랜잭션이라 항상 같이 반영되거나 같이 취소된다.
   * 같은 (userId, Idempotency-Key)가 다시 오면 아무것도 쌓지 않고 저장된 값을 돌려준다.
   */
  async record(input: RecordInput): Promise<RecordResult> {
    const { tokens, replayed, storedHash } = await this.runTransaction(input);

    if (replayed && storedHash !== input.requestHash) {
      throw new UnprocessableEntityException(
        "Idempotency-Key was already used with a different request body",
      );
    }
    return { tokens, replayed };
  }

  /** 이미 처리 완료된 요청이면 저장된 결과를, 아니면 null */
  async find(
    userId: string,
    idempotencyKey: string,
  ): Promise<StoredResult | null> {
    const { rows } = await this.db.pool.query<{
      id: string;
      tokens: number;
      request_hash: string;
      cancelled: boolean;
    }>(
      `SELECT id, tokens, request_hash, cancelled FROM token_ledger
       WHERE user_id = $1 AND idempotency_key = $2`,
      [userId, idempotencyKey],
    );
    const row = rows[0];
    return row
      ? {
          id: row.id,
          tokens: row.tokens,
          requestHash: row.request_hash,
          cancelled: row.cancelled,
        }
      : null;
  }

  /** 저장된 토큰 내용을 번호 순서로 읽는다. after(번호)보다 큰 것만, 최대 limit개 */
  async findTokens(
    ledgerId: string,
    after: number,
    limit: number,
  ): Promise<StoredToken[]> {
    const { rows } = await this.db.pool.query<StoredToken>(
      `SELECT position, content FROM generated_tokens
       WHERE ledger_id = $1 AND position > $2
       ORDER BY position
       LIMIT $3`,
      [ledgerId, after, limit],
    );
    return rows;
  }

  private async runTransaction(input: RecordInput) {
    const tokens = input.contents.length;
    const client = await this.db.pool.connect();
    try {
      await client.query("BEGIN");

      const inserted = await client.query<{ id: string }>(
        `INSERT INTO token_ledger
           (user_id, idempotency_key, request_hash, max_tokens, tokens, cancelled)
         VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT (user_id, idempotency_key) DO NOTHING
         RETURNING id`,
        [
          input.userId,
          input.idempotencyKey,
          input.requestHash,
          input.maxTokens, // 요청 때 받은 값을 그대로 둔다 (멱등성 비교/감사용). 실제 확정 개수는 tokens
          tokens,
          input.cancelled ?? false,
        ],
      );

      if (inserted.rowCount === 1) {
        await this.insertTokens(client, inserted.rows[0].id, input.contents);
        await client.query(
          `INSERT INTO user_token_totals (user_id, total_tokens)
           VALUES ($1, $2)
           ON CONFLICT (user_id) DO UPDATE
             SET total_tokens = user_token_totals.total_tokens + EXCLUDED.total_tokens,
                 updated_at = now()`,
          [input.userId, tokens],
        );
        await client.query("COMMIT");
        return { tokens, replayed: false, storedHash: input.requestHash };
      }

      const existing = await client.query<{
        request_hash: string;
        tokens: number;
      }>(
        `SELECT request_hash, tokens FROM token_ledger
         WHERE user_id = $1 AND idempotency_key = $2`,
        [input.userId, input.idempotencyKey],
      );
      await client.query("COMMIT");
      const row = existing.rows[0];
      return {
        tokens: row.tokens,
        replayed: true,
        storedHash: row.request_hash,
      };
    } catch (err) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
  }

  /** 토큰 내용을 INSERT_BATCH개씩 묶어서 저장 (position은 1부터) */
  private async insertTokens(
    client: PoolClient,
    ledgerId: string,
    contents: string[],
  ) {
    for (let start = 0; start < contents.length; start += INSERT_BATCH) {
      const slice = contents.slice(start, start + INSERT_BATCH);
      const positions = slice.map((_, i) => start + i + 1);
      await client.query(
        `INSERT INTO generated_tokens (ledger_id, position, content)
         SELECT $1::bigint, t.position, t.content
         FROM unnest($2::int[], $3::text[]) AS t(position, content)`,
        [ledgerId, positions, slice],
      );
    }
  }
}
