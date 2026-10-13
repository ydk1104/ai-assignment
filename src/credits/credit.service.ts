import { Injectable } from "@nestjs/common";
import type { PoolClient } from "pg";
import { DatabaseService } from "../database/database.service";
import {
  CreditAccount,
  InsufficientCreditError,
  hasEnoughCredit,
  parseInitialCredit,
  toAccount,
} from "./credit-math";

type EntryType = "GRANT" | "RESERVE" | "SETTLE" | "RELEASE";

interface NewEntry {
  userId: string;
  type: EntryType;
  jobId: string | null;
  idempotencyKey: string | null;
  balanceDelta: number;
  reservedDelta: number;
  balanceAfter: number;
  reservedAfter: number;
}

export interface OpenReservation {
  jobId: string;
  userId: string;
  createdAt: number; // ms
}

/**
 * 유저별 크레딧 잔액/예약 관리.
 *
 *   user_credits   : 유저별 현재 상태 (balance 잔액, reserved 예약된 금액)
 *   credit_ledger  : 크레딧이 움직인 모든 기록 (추가만 하고 고치지 않는다)
 *       GRANT   처음 지급        balance +초기금액
 *       RESERVE 예약             reserved +maxTokens
 *       SETTLE  정산(생성 완료)  balance -생성한 토큰 수, reserved -예약했던 금액
 *       RELEASE 예약 해제(실패)  reserved -예약했던 금액 (잔액은 그대로)
 *
 * 음수 방지: 모든 변경은 그 유저의 user_credits 행을 잠근(SELECT ... FOR UPDATE) 트랜잭션 안에서 한다.
 * 그래서 같은 유저의 요청이 동시에 여러 개 와도 하나씩 차례로 "실제 잔액(잔액 - 예약) >= 요청 금액"을 확인하고 예약한다.
 * (DB에도 CHECK (balance >= 0, reserved >= 0, reserved <= balance) 가 있어서 어떤 버그가 있어도 음수는 저장되지 않는다)
 */
@Injectable()
export class CreditService {
  private readonly initialCredit = parseInitialCredit(
    process.env.INITIAL_CREDIT,
  );

  constructor(private readonly db: DatabaseService) {}

  /** 현재 크레딧. 처음 보는 유저면 초기 크레딧을 지급하면서 계정을 만든다 */
  async getAccount(userId: string): Promise<CreditAccount> {
    return this.inTransaction(async (client) =>
      this.loadAccount(client, userId, false),
    );
  }

  /**
   * amount 만큼 예약한다. 실제 잔액(잔액 - 예약)이 모자라면 InsufficientCreditError.
   * 같은 jobId로 다시 불러도 한 번만 예약된다.
   */
  async reserve(
    userId: string,
    idempotencyKey: string,
    jobId: string,
    amount: number,
  ): Promise<CreditAccount> {
    const outcome = await this.inTransaction(async (client) => {
      const account = await this.loadAccount(client, userId, true);
      if (!hasEnoughCredit(account.balance, account.reserved, amount))
        return { ok: false as const, account };

      const inserted = await this.insertEntry(client, {
        userId,
        type: "RESERVE",
        jobId,
        idempotencyKey,
        balanceDelta: 0,
        reservedDelta: amount,
        balanceAfter: account.balance,
        reservedAfter: account.reserved + amount,
      });
      if (!inserted) return { ok: true as const, account }; // 이 job의 예약이 이미 있음
      await client.query(
        `UPDATE user_credits SET reserved = reserved + $2, updated_at = now() WHERE user_id = $1`,
        [userId, amount],
      );
      return {
        ok: true as const,
        account: toAccount(account.balance, account.reserved + amount),
      };
    });

    if (!outcome.ok)
      throw new InsufficientCreditError(outcome.account.available, amount);
    return outcome.account;
  }

  /**
   * 정산: 생성한 토큰 수만큼 잔액에서 차감하고, 예약했던 금액은 전부 푼다.
   * 토큰 원장 저장과 같은 트랜잭션(client)에서 호출해서, "결과 저장"과 "차감"이 항상 같이 반영되게 한다.
   * 이미 정산/해제된 job이면 아무것도 하지 않는다 (워커가 바뀌어 다시 실행돼도 한 번만 차감).
   */
  async settle(
    client: PoolClient,
    input: { userId: string; jobId: string; tokens: number },
  ): Promise<void> {
    const account = await this.loadAccount(client, input.userId, true);

    const reservation = await client.query<{
      reserved_delta: string;
      idempotency_key: string | null;
    }>(
      `SELECT reserved_delta, idempotency_key FROM credit_ledger WHERE job_id = $1 AND entry_type = 'RESERVE'`,
      [input.jobId],
    );
    if (reservation.rows.length === 0) return; // 예약 없이 만들어진 job(이 기능 이전에 큐에 들어간 것)은 크레딧 정산 대상이 아님

    const closed = await client.query(
      `SELECT 1 FROM credit_ledger WHERE job_id = $1 AND entry_type IN ('SETTLE', 'RELEASE')`,
      [input.jobId],
    );
    if (closed.rows.length > 0) return;

    const reserved = Number(reservation.rows[0].reserved_delta);
    const charge = Math.min(input.tokens, reserved); // 예약한 금액보다 더 차감하지 않는다
    const inserted = await this.insertEntry(client, {
      userId: input.userId,
      type: "SETTLE",
      jobId: input.jobId,
      idempotencyKey: reservation.rows[0].idempotency_key,
      balanceDelta: -charge,
      reservedDelta: -reserved,
      balanceAfter: account.balance - charge,
      reservedAfter: account.reserved - reserved,
    });
    if (!inserted) return;
    await client.query(
      `UPDATE user_credits
       SET balance = balance - $2, reserved = reserved - $3, updated_at = now()
       WHERE user_id = $1`,
      [input.userId, charge, reserved],
    );
  }

  /**
   * 예약을 푼다 (과금 없음). 생성이 실패했거나, 큐에 넣지 못했거나, 이 job이 결과를 못 남기는 경우에 쓴다.
   * 이미 정산/해제된 job이면 false (여러 번 불러도 안전).
   */
  async release(jobId: string): Promise<boolean> {
    const found = await this.db.pool.query<{
      user_id: string;
      reserved_delta: string;
      idempotency_key: string | null;
    }>(
      `SELECT user_id, reserved_delta, idempotency_key FROM credit_ledger WHERE job_id = $1 AND entry_type = 'RESERVE'`,
      [jobId],
    );
    const reservation = found.rows[0];
    if (!reservation) return false;
    const amount = Number(reservation.reserved_delta);

    return this.inTransaction(async (client) => {
      const account = await this.loadAccount(client, reservation.user_id, true);
      // 잠금을 잡은 뒤에 다시 확인한다 (그 사이에 정산/해제됐을 수 있음)
      const closed = await client.query(
        `SELECT 1 FROM credit_ledger WHERE job_id = $1 AND entry_type IN ('SETTLE', 'RELEASE')`,
        [jobId],
      );
      if (closed.rows.length > 0) return false;

      const inserted = await this.insertEntry(client, {
        userId: reservation.user_id,
        type: "RELEASE",
        jobId,
        idempotencyKey: reservation.idempotency_key,
        balanceDelta: 0,
        reservedDelta: -amount,
        balanceAfter: account.balance,
        reservedAfter: account.reserved - amount,
      });
      if (!inserted) return false;
      await client.query(
        `UPDATE user_credits SET reserved = reserved - $2, updated_at = now() WHERE user_id = $1`,
        [reservation.user_id, amount],
      );
      return true;
    });
  }

  /** 정산도 해제도 안 된 채 grace 이상 지난 예약 (워커가 죽는 등으로 남은 것). 정리 작업이 쓴다 */
  async findOpenReservations(
    graceMs: number,
    limit: number,
  ): Promise<OpenReservation[]> {
    const { rows } = await this.db.pool.query<{
      job_id: string;
      user_id: string;
      created_at: Date;
    }>(
      `SELECT r.job_id, r.user_id, r.created_at
       FROM credit_ledger r
       WHERE r.entry_type = 'RESERVE'
         AND r.created_at < now() - make_interval(secs => $1::double precision)
         AND NOT EXISTS (
           SELECT 1 FROM credit_ledger d
           WHERE d.job_id = r.job_id AND d.entry_type IN ('SETTLE', 'RELEASE')
         )
       ORDER BY r.id
       LIMIT $2`,
      [graceMs / 1000, limit],
    );
    return rows.map((r) => ({
      jobId: r.job_id,
      userId: r.user_id,
      createdAt: new Date(r.created_at).getTime(),
    }));
  }

  // ---------------------------------------------------------------- 내부

  private async inTransaction<T>(
    fn: (client: PoolClient) => Promise<T>,
  ): Promise<T> {
    const client = await this.db.pool.connect();
    try {
      await client.query("BEGIN");
      const result = await fn(client);
      await client.query("COMMIT");
      return result;
    } catch (err) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
  }

  /** 계정이 없으면 초기 크레딧을 지급하며 만들고, 현재 상태를 읽는다. lock=true면 행을 잠근다 */
  private async loadAccount(
    client: PoolClient,
    userId: string,
    lock: boolean,
  ): Promise<CreditAccount> {
    const created = await client.query(
      `INSERT INTO user_credits (user_id, balance, reserved) VALUES ($1, $2, 0)
       ON CONFLICT (user_id) DO NOTHING
       RETURNING user_id`,
      [userId, this.initialCredit],
    );
    if (created.rows.length === 1) {
      await this.insertEntry(client, {
        userId,
        type: "GRANT",
        jobId: null,
        idempotencyKey: null,
        balanceDelta: this.initialCredit,
        reservedDelta: 0,
        balanceAfter: this.initialCredit,
        reservedAfter: 0,
      });
    }
    const { rows } = await client.query<{ balance: string; reserved: string }>(
      `SELECT balance, reserved FROM user_credits WHERE user_id = $1${lock ? " FOR UPDATE" : ""}`,
      [userId],
    );
    return toAccount(Number(rows[0].balance), Number(rows[0].reserved));
  }

  /** 원장에 한 줄 추가. 같은 (jobId, 종류)가 이미 있으면 추가하지 않고 false */
  private async insertEntry(client: PoolClient, e: NewEntry): Promise<boolean> {
    const { rows } = await client.query(
      `INSERT INTO credit_ledger
         (user_id, entry_type, job_id, idempotency_key, balance_delta, reserved_delta, balance_after, reserved_after)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       ON CONFLICT (job_id, entry_type) WHERE job_id IS NOT NULL DO NOTHING
       RETURNING id`,
      [
        e.userId,
        e.type,
        e.jobId,
        e.idempotencyKey,
        e.balanceDelta,
        e.reservedDelta,
        e.balanceAfter,
        e.reservedAfter,
      ],
    );
    return rows.length === 1;
  }
}
