export const INSUFFICIENT_CREDIT_MESSAGE = "크레딧이 부족합니다.";

/** 새 유저에게 처음 지급하는 크레딧 기본값 (INITIAL_CREDIT 환경변수로 바꾼다) */
export const DEFAULT_INITIAL_CREDIT = 100_000;

/** 크레딧 현황. balance = 잔액, reserved = 예약된 금액, available = balance - reserved (실제로 쓸 수 있는 잔액) */
export interface CreditAccount {
  balance: number;
  reserved: number;
  available: number;
}

/** 예약하려는 금액보다 실제 잔액(available)이 적을 때 */
export class InsufficientCreditError extends Error {
  readonly available: number;
  readonly requested: number;

  constructor(available: number, requested: number) {
    super(INSUFFICIENT_CREDIT_MESSAGE);
    this.name = "InsufficientCreditError";
    this.available = available;
    this.requested = requested;
  }
}

export function toAccount(balance: number, reserved: number): CreditAccount {
  return { balance, reserved, available: balance - reserved };
}

/** 실제 잔액(잔액 - 예약)이 amount 이상이면 예약할 수 있다 */
export function hasEnoughCredit(
  balance: number,
  reserved: number,
  amount: number,
): boolean {
  return balance - reserved >= amount;
}

/** INITIAL_CREDIT 파싱. 비어 있으면 기본값, 0 이상의 정수가 아니면 서버 시작 시 바로 에러 */
export function parseInitialCredit(raw?: string): number {
  if (raw === undefined || raw.trim() === "") return DEFAULT_INITIAL_CREDIT;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(
      `INITIAL_CREDIT must be a non-negative integer, got "${raw}"`,
    );
  }
  return value;
}
