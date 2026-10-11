import {
  BadRequestException,
  Body,
  Controller,
  Headers,
  Logger,
  Post,
  Res,
} from "@nestjs/common";
import type { Response } from "express";
import { createHash } from "crypto";
import { createRng, parseSeed } from "../common/random";
import { CreateDocumentDto } from "./create-document.dto";
import { parseLastEventId, pickTokenCount, streamPoints } from "./token-count";
import { TokenLedgerService } from "./token-ledger.service";

const STEP_DELAY_MS = 100;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

@Controller("create_document")
export class DocumentsController {
  private readonly logger = new Logger(DocumentsController.name);

  // RANDOM_SEED가 있으면 고정 seed, 없으면 요청마다 시간 기반. 잘못된 값이면 서버 시작 시 바로 에러
  private readonly seed = parseSeed(process.env.RANDOM_SEED);

  constructor(private readonly ledger: TokenLedgerService) {}

  @Post()
  async create(
    @Body() dto: CreateDocumentDto,
    @Headers("idempotency-key") idempotencyKey: string | undefined,
    @Headers("last-event-id") lastEventId: string | undefined,
    @Res() res: Response,
  ) {
    const key = idempotencyKey?.trim();
    if (!key || key.length > 255) {
      throw new BadRequestException(
        "Idempotency-Key header is required (max 255 chars)",
      );
    }

    const tokens = pickTokenCount(dto.maxTokens, createRng(this.seed));
    const requestHash = createHash("sha256")
      .update(JSON.stringify([dto.prompt, dto.maxTokens]))
      .digest("hex");

    // 스트림 시작 전에 DB 반영 (실패하면 일반 HTTP 에러로 응답)
    const result = await this.ledger.record({
      userId: dto.userId,
      idempotencyKey: key,
      requestHash,
      maxTokens: dto.maxTokens,
      tokens,
    });

    // 같은 Idempotency-Key로 재연결한 경우에만 Last-Event-ID 이후부터 이어서 보낸다
    const resumeFrom = result.replayed ? parseLastEventId(lastEventId) : 0;

    res.status(200);
    res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
    res.setHeader("Cache-Control", "no-cache, no-transform");
    res.setHeader("X-Accel-Buffering", "no"); // nginx가 버퍼링하지 않도록
    if (result.replayed) res.setHeader("Idempotent-Replayed", "true");
    res.flushHeaders();

    await this.streamTokenCount(res, result.tokens, resumeFrom);
  }

  /**
   * 누적 토큰 수를 SSE로 흘려보낸다. 각 이벤트의 id는 그 시점의 누적 토큰 수이다.
   * - resumeFrom(Last-Event-ID) 이하는 이미 받은 것이므로 건너뛰고 그 다음부터 보낸다.
   * - 클라이언트 연결이 끊겨도 생성(루프)은 끝까지 진행하고, 끊긴 뒤에는 전송만 건너뛴다.
   *   (원장 기록은 스트림 시작 전에 이미 끝나 있으므로 연결이 끊겨도 DB 상태는 항상 일관적이다)
   */
  private async streamTokenCount(
    res: Response,
    total: number,
    resumeFrom: number,
  ) {
    let disconnected = false;
    res.on("close", () => {
      if (!res.writableEnded) disconnected = true;
    });
    // 이미 끊긴 소켓에 쓰다 발생하는 에러가 프로세스를 죽이지 않도록
    res.on("error", () => undefined);

    // 연결이 살아있을 때만 쓰고, 실제로 썼는지 돌려준다
    const send = (chunk: string): boolean => {
      if (disconnected || res.writableEnded || res.destroyed) return false;
      res.write(chunk);
      return true;
    };

    let delivered = Math.min(resumeFrom, total); // 클라이언트가 받은 마지막 누적 토큰 수
    const points = streamPoints(total, resumeFrom);
    for (let i = 0; i < points.length; i++) {
      const sent = points[i];
      if (send(`id: ${sent}\ndata: ${JSON.stringify({ tokens: sent })}\n\n`))
        delivered = sent;
      if (i < points.length - 1) await sleep(STEP_DELAY_MS); // 연결 여부와 상관없이 계속 진행
    }

    if (
      send(
        `id: ${total}\nevent: done\ndata: ${JSON.stringify({ tokens: total })}\n\n`,
      )
    ) {
      res.end();
    } else {
      this.logger.warn(
        `client disconnected after ${delivered}/${total} tokens; generation completed`,
      );
    }
  }
}
