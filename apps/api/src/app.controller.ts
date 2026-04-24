import { Controller, Get, Inject } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";

import { ok } from "./common/dto/api-response";
import { resolveApiDataFile, resolveUploadDir } from "./common/store/persistence";

@Controller()
export class AppController {
  constructor(@Inject(ConfigService) private readonly configService: ConfigService) {}

  @Get("health")
  health() {
    const openAiApiKey = this.configService.get<string>("OPENAI_API_KEY")?.trim();
    const openAiModel = this.configService.get<string>("OPENAI_MODEL")?.trim() || "gpt-4.1-mini";
    const openAiBaseUrl =
      this.configService.get<string>("OPENAI_BASE_URL")?.trim() || "https://api.openai.com/v1";

    return ok({
      status: "正常",
      timestamp: new Date().toISOString(),
      dataFile: resolveApiDataFile(),
      uploadDir: resolveUploadDir(),
      ai: {
        enabled: Boolean(openAiApiKey),
        provider: "openai-compatible",
        model: openAiModel,
        baseUrl: openAiBaseUrl
      }
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
