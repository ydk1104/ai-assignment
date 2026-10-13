import { BadRequestException, Controller, Get, Query } from "@nestjs/common";
import { CreditService } from "./credit.service";

/**
 * GET /credit?userId=u1
 *   balance   : 잔액
 *   reserved  : 예약된 금액 (생성 중인 요청들이 maxTokens 만큼 잡아둔 합계)
 *   available : 잔액 - 예약된 금액 (실제로 쓸 수 있는 잔액)
 * 처음 조회하는 유저면 초기 크레딧을 지급하면서 계정을 만든다.
 */
@Controller("credit")
export class CreditController {
  constructor(private readonly credits: CreditService) {}

  @Get()
  async get(@Query("userId") userId: string | undefined) {
    const id = userId?.trim();
    if (!id || id.length > 128)
      throw new BadRequestException(
        "userId query parameter is required (max 128 chars)",
      );
    const account = await this.credits.getAccount(id);
    return { userId: id, ...account };
  }
}
