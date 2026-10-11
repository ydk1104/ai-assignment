export const DOCUMENT_QUEUE = "create-document";
export const DOCUMENT_JOB_NAME = "create-document";

/** 토큰 생성 중 의도적으로 내는 에러의 이름(= message). 클라이언트에도 이 값으로 전달된다 */
export const TOKEN_CREATE_FAIL = "token_create_fail";

/**
 * 워커 장애 복구 설정 (BullMQ의 stalled job 복구)
 * - 워커는 처리 중인 job의 락을 LOCK_DURATION 의 절반 주기로 갱신한다.
 * - 워커가 죽으면 갱신이 멈춰 LOCK_DURATION 뒤에 락이 풀린다.
 * - 살아있는 워커들이 STALLED_CHECK_INTERVAL 마다 "락이 풀린 job"을 찾아 큐에 되돌리고, 다른 워커가 처음부터 다시 처리한다.
 * => 워커가 죽은 뒤 다른 워커가 이어받기까지 최대 약 LOCK_DURATION + STALLED_CHECK_INTERVAL (15초)
 */
export const WORKER_LOCK_DURATION_MS = 10_000;
export const STALLED_CHECK_INTERVAL_MS = 5_000;
/** 한 job이 이 횟수까지는 워커가 죽어도 다른 워커가 다시 처리한다. 초과하면 실패 처리 */
export const MAX_STALLED_COUNT = 3;

/** API 서버가 큐에 넣고 워커가 꺼내 처리하는 작업 */
export interface CreateDocumentJob {
  userId: string;
  idempotencyKey: string;
  requestHash: string;
  maxTokens: number;
  /** Redis의 "생성 중" 메모 값. 워커가 자기 메모만 연장/삭제하기 위해 쓴다 */
  lockValue: string;
  /**
   * 난수 seed. API 서버가 한 번 정해서 job에 담는다 (RANDOM_SEED가 있으면 그 값, 없으면 현재 시간).
   * 워커가 죽어 다른 워커가 처음부터 다시 만들어도 같은 seed라서 토큰 내용이 똑같이 만들어진다.
   */
  seed: number;
}

/** 워커가 토큰을 하나 만들 때마다 보내는 진행 정보 (BullMQ progress) */
export interface TokenProgress {
  index: number;
  token: string;
}

export function isTokenProgress(data: unknown): data is TokenProgress {
  if (typeof data !== "object" || data === null) return false;
  const value = data as Partial<TokenProgress>;
  return typeof value.index === "number" && typeof value.token === "string";
}

/** Redis에 남기는 "생성 중" 메모의 내용 */
export interface LockValue {
  jobId: string;
  requestHash: string;
  /** 메모를 남긴 시각(ms). job이 큐에 들어가기 전의 짧은 틈을 구분하는 데 쓴다 */
  createdAt: number;
}

/** Redis에서 읽어온 메모 (compare-and-delete 용 원본 문자열 포함) */
export interface HeldLock extends LockValue {
  raw: string;
}

export function lockValueOf(jobId: string, requestHash: string): string {
  const value: LockValue = { jobId, requestHash, createdAt: Date.now() };
  return JSON.stringify(value);
}

export function parseLockValue(raw: string | null): HeldLock | null {
  if (!raw) return null;
  try {
    return { ...(JSON.parse(raw) as LockValue), raw };
  } catch {
    return null;
  }
}

/** 아직 처리될 예정이거나 처리 중인 job 상태 (BullMQ job state) */
const ALIVE_JOB_STATES = [
  "waiting",
  "active",
  "delayed",
  "prioritized",
  "waiting-children",
];

/** 메모를 남긴 직후 ~ job이 큐에 들어가기 전까지의 유예 시간 */
export const ENQUEUE_GRACE_MS = 10_000;

/**
 * Redis 메모가 "정말 처리 중인 요청"의 것인지 판단한다. 메모의 TTL이 아니라 job의 실제 상태로 판단하므로,
 * 워커가 죽어서 job이 복구되기를 기다리는 동안(waiting/active)에도 "처리 중"으로 유지된다.
 * - job이 살아있음(waiting/active/...)                      -> 처리 중
 * - job이 아직 없음(큐에 넣는 중일 수 있음)                  -> 유예 시간 안이면 처리 중, 지나면 죽은 메모
 * - job이 끝남(completed/failed)                            -> 죽은 메모 (정리 못 하고 남은 것)
 */
export function isHeldLockInFlight(
  state: string | null,
  createdAt: number,
  now: number = Date.now(),
): boolean {
  if (state === null || state === "unknown")
    return now - createdAt < ENQUEUE_GRACE_MS;
  return ALIVE_JOB_STATES.includes(state);
}
