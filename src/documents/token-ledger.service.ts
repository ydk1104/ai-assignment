import { Injectable, UnprocessableEntityException } from "@nestjs/common";
import { DatabaseService } from "../database/database.service";

export interface RecordInput {
  userId: string;
  idempotencyKey: string;
  requestHash: string;
  maxTokens: number;
  tokens: number;
}

export interface RecordResult {
  tokens: number;
  /** true면 같은 Idempotency-Key로 이미 처리된 요청 (이번엔 DB에 쌓지 않음) */
  replayed: boolean;
}

@Injectable()
export class TokenLedgerService {
  constructor(private readonly db: DatabaseService) {}

  /**
   * 원장(token_ledger)에 한 줄 추가하고 유저별 합계(user_token_totals)를 올린다.
   * 둘은 한 트랜잭션이라 항상 같이 반영되거나 같이 취소된다.
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
  ): Promise<{ tokens: number; requestHash: string } | null> {
    const { rows } = await this.db.pool.query<{
      tokens: number;
      request_hash: string;
    }>(
      `SELECT tokens, request_hash FROM token_ledger
       WHERE user_id = $1 AND idempotency_key = $2`,
      [userId, idempotencyKey],
    );
    return rows[0]
      ? { tokens: rows[0].tokens, requestHash: rows[0].request_hash }
      : null;
  }

  private async runTransaction(input: RecordInput) {
    const client = await this.db.pool.connect();
    try {
      await client.query("BEGIN");

      const inserted = await client.query(
        `INSERT INTO token_ledger (user_id, idempotency_key, request_hash, max_tokens, tokens)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (user_id, idempotency_key) DO NOTHING
         RETURNING id`,
        [
          input.userId,
          input.idempotencyKey,
          input.requestHash,
          input.maxTokens,
          input.tokens,
        ],
      );

      if (inserted.rowCount === 1) {
        await client.query(
          `INSERT INTO user_token_totals (user_id, total_tokens)
           VALUES ($1, $2)
           ON CONFLICT (user_id) DO UPDATE
             SET total_tokens = user_token_totals.total_tokens + EXCLUDED.total_tokens,
                 updated_at = now()`,
          [input.userId, input.tokens],
        );
        await client.query("COMMIT");
        return {
          tokens: input.tokens,
          replayed: false,
          storedHash: input.requestHash,
        };
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
}
