import { Controller, Get } from "@nestjs/common";

@Controller("status")
export class StatusController {
  @Get()
  getStatus() {
    return { status: "ok" }; // 기본 200 OK
  }
}
