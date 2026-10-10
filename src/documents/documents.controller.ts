import {
  BadRequestException,
  Body,
  Controller,
  Headers,
  Post,
  Res,
} from "@nestjs/common";
import type { Response } from "express";
import { createHash } from "crypto";
import { createRng, parseSeed } from "../common/random";
import { CreateDocumentDto } from "./create-document.dto";
import { pickTokenCount } from "./token-count";
import { TokenLedgerService } from "./token-ledger.service";

const STREAM_STEPS = 10; // 누적 토큰 수를 최대 몇 번에 나눠 보낼지
const STEP_DELAY_MS = 100;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

@Controller("create_document")
export class DocumentsController {
  // RANDOM_SEED가 있으면 고정 seed, 없으면 요청마다 시간 기반. 잘못된 값이면 서버 시작 시 바로 에러
  private readonly seed = parseSeed(process.env.RANDOM_SEED);

  constructor(private readonly ledger: TokenLedgerService) {}

  @Post()
  async create(
    @Body() dto: CreateDocumentDto,
    @Headers("idempotency-key") idempotencyKey: string | undefined,
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

    res.status(200);
    res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
    res.setHeader("Cache-Control", "no-cache, no-transform");
    res.setHeader("X-Accel-Buffering", "no"); // nginx가 버퍼링하지 않도록
    if (result.replayed) res.setHeader("Idempotent-Replayed", "true");
    res.flushHeaders();

    await this.streamTokenCount(res, result.tokens);
  }

  /** 지금까지 보낸 누적 토큰 수를 SSE로 흘려보낸다 */
  private async streamTokenCount(res: Response, total: number) {
    let aborted = false;
    res.on("close", () => {
      if (!res.writableEnded) aborted = true;
    });

    const steps = Math.min(total, STREAM_STEPS);
    for (let i = 1; i <= steps; i++) {
      if (aborted) return;
      const sent = Math.floor((total * i) / steps);
      res.write(`data: ${JSON.stringify({ tokens: sent })}\n\n`);
      if (i < steps) await sleep(STEP_DELAY_MS);
    }

    if (aborted) return;
    res.write(`event: done\ndata: ${JSON.stringify({ tokens: total })}\n\n`);
    res.end();
  }
}
