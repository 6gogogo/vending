import { Controller, Get, Inject } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";

import { ok } from "./common/dto/api-response";
import { resolveApiDataFile, resolveUploadDir } from "./common/store/persistence";

@Controller()
export class AppController {
  constructor(@Inject(ConfigService) private readonly configService: ConfigService) {}

  @Get("health")
  health() {
    return ok({
      status: "正常",
      timestamp: new Date().toISOString(),
      dataFile: resolveApiDataFile(),
      uploadDir: resolveUploadDir()
    });
  }

  @Get("public-config")
  publicConfig() {
    return ok({
      amapWebKey: this.configService.get<string>("AMAP_WEB_KEY") ?? ""
    });
  }
}
