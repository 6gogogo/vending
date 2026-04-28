import { Body, Controller, Get, Inject, Patch, UseGuards } from "@nestjs/common";
import type { SystemSettingsUpdatePayload } from "@vm/shared-types";

import { ok } from "../../common/dto/api-response";
import { AllowedRoles } from "../../common/guards/allowed-roles.decorator";
import { RoleGuard } from "../../common/guards/role.guard";
import { SystemSettingsService } from "./system-settings.service";

@Controller("system-settings")
@UseGuards(RoleGuard)
@AllowedRoles("admin")
export class SystemSettingsController {
  constructor(
    @Inject(SystemSettingsService)
    private readonly systemSettingsService: SystemSettingsService
  ) {}

  @Get()
  settings() {
    return ok(this.systemSettingsService.getSettings());
  }

  @Patch()
  updateSettings(@Body() body: SystemSettingsUpdatePayload) {
    return ok(this.systemSettingsService.updateSettings(body), "系统设置已保存。");
  }
}
