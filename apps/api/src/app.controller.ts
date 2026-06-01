import { Controller, Get, Inject } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";

import { ok } from "./common/dto/api-response";

@Controller()
export class AppController {
  constructor(@Inject(ConfigService) private readonly configService: ConfigService) {}

  @Get("health")
  health() {
    return ok({
      status: "正常",
      timestamp: new Date().toISOString()
    });
  }

  @Get("public-config")
  publicConfig() {
    return ok({
      amapWebKey: this.configService.get<string>("AMAP_WEB_KEY") ?? "",
      amapSecurityJsCode: this.configService.get<string>("AMAP_SECURITY_JS_CODE") ?? ""
    });
  }
}
