import { Controller, Get } from "@nestjs/common";

import { ok } from "./common/dto/api-response";

@Controller()
export class AppController {
  @Get("health")
  health() {
    return ok({
      status: "正常",
      timestamp: new Date().toISOString()
    });
  }
}
