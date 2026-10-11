import { Injectable, OnModuleDestroy, OnModuleInit } from "@nestjs/common";
import { Queue, QueueEvents } from "bullmq";
import { redisConnection } from "../common/redis-options";
import {
  CreateDocumentJob,
  DOCUMENT_JOB_NAME,
  DOCUMENT_QUEUE,
} from "./document-job";

/** 특정 job의 진행 상황을 받는 쪽 (SSE 응답 하나가 하나씩 가진다) */
export interface JobListener {
  /** 워커가 job을 집어 처리를 시작함 */
  onActive(): void;
  /** 지금까지 생성한 누적 토큰 수 */
  onProgress(tokens: number): void;
  onCompleted(): void;
  onFailed(reason: string): void;
}

@Injectable()
export class DocumentQueueService implements OnModuleInit, OnModuleDestroy {
  private readonly queue = new Queue<CreateDocumentJob>(DOCUMENT_QUEUE, {
    connection: redisConnection(),
  });
  private readonly events = new QueueEvents(DOCUMENT_QUEUE, {
    connection: redisConnection(),
  });
  /** jobId -> 이 서버에서 그 job의 결과를 기다리는 SSE 응답 */
  private readonly listeners = new Map<string, JobListener>();

  async onModuleInit() {
    // 이 서버 안에서 구독 중인 job의 이벤트만 골라서 전달한다 (다른 서버의 job 이벤트는 무시)
    this.events.on("active", ({ jobId }) =>
      this.listeners.get(jobId)?.onActive(),
    );
    this.events.on("progress", ({ jobId, data }) => {
      if (typeof data === "number") this.listeners.get(jobId)?.onProgress(data);
    });
    this.events.on("completed", ({ jobId }) =>
      this.listeners.get(jobId)?.onCompleted(),
    );
    this.events.on("failed", ({ jobId, failedReason }) =>
      this.listeners.get(jobId)?.onFailed(failedReason),
    );
    await this.events.waitUntilReady();
  }

  async onModuleDestroy() {
    await this.events.close();
    await this.queue.close();
  }

  /** enqueue 하기 "전에" 구독해야 이벤트를 놓치지 않는다. 해제 함수를 돌려준다 */
  subscribe(jobId: string, listener: JobListener): () => void {
    this.listeners.set(jobId, listener);
    return () => {
      this.listeners.delete(jobId);
    };
  }

  /** job의 현재 상태 (waiting/active/completed/failed ...). 큐에 없으면 null */
  async getJobState(jobId: string): Promise<string | null> {
    const job = await this.queue.getJob(jobId);
    return job ? await job.getState() : null;
  }

  async enqueue(jobId: string, data: CreateDocumentJob): Promise<void> {
    await this.queue.add(DOCUMENT_JOB_NAME, data, {
      jobId,
      attempts: 1, // 실패해도 자동 재시도하지 않음 (클라이언트가 같은 키로 다시 요청)
      removeOnComplete: { age: 3600, count: 1000 },
      removeOnFail: { age: 3600, count: 1000 },
    });
  }
}
