export const DOCUMENT_QUEUE = 'create-document';
export const DOCUMENT_JOB_NAME = 'create-document';

/** 토큰 생성 중 의도적으로 내는 에러의 이름(= message). 클라이언트에도 이 값으로 전달된다 */
export const TOKEN_CREATE_FAIL = 'token_create_fail';

/** API 서버가 큐에 넣고 워커가 꺼내 처리하는 작업 */
export interface CreateDocumentJob {
  userId: string;
  idempotencyKey: string;
  requestHash: string;
  maxTokens: number;
  /** Redis의 "생성 중" 메모 값. 워커가 자기 메모만 연장/삭제하기 위해 쓴다 */
  lockValue: string;
}

/** Redis에 남기는 "생성 중" 메모의 내용 */
export interface LockValue {
  jobId: string;
  requestHash: string;
}

export function lockValueOf(jobId: string, requestHash: string): string {
  const value: LockValue = { jobId, requestHash };
  return JSON.stringify(value);
}

export function parseLockValue(raw: string | null): LockValue | null {
  if (!raw) return null;
  try {
    return JSON.parse(raw) as LockValue;
  } catch {
    return null;
  }
}
