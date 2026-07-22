import { Controller, Get, Inject, Optional, ServiceUnavailableException } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";

import { isProductionReady } from "./common/config/production-safety";
import { ok } from "./common/dto/api-response";
import { InMemoryStoreService } from "./common/store/in-memory-store.service";
import { SystemAuditLogService } from "./common/store/system-audit-log.service";

@Controller()
export class AppController {
  constructor(
    @Inject(ConfigService) private readonly configService: ConfigService,
    @Inject(InMemoryStoreService) private readonly store: InMemoryStoreService,
    @Optional()
    @Inject(SystemAuditLogService)
    private readonly auditLog: SystemAuditLogService = new SystemAuditLogService()
  ) {}

  @Get("health")
  health() {
    return ok({
      status: "正常",
      timestamp: new Date().toISOString()
    });
  }

  @Get("health/production-readiness")
  productionReadiness() {
    if (!isProductionReady(this.configService, this.store, this.auditLog)) {
      throw new ServiceUnavailableException("生产就绪检查未通过。");
    }

    return ok({ status: "就绪" });
  }

  @Get("public-config")
  publicConfig() {
    return ok({
      amapWebKey: this.configService.get<string>("AMAP_WEB_KEY") ?? "",
      amapSecurityJsCode: this.configService.get<string>("AMAP_SECURITY_JS_CODE") ?? ""
    });
  }
}
