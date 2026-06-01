import { Body, Controller, Get, Inject, Patch, Req, UseGuards } from "@nestjs/common";
import type { SystemSettingsUpdatePayload } from "@vm/shared-types";

import { ok } from "../../common/dto/api-response";
import {
  AllowedBackofficePermissions,
  AllowedRoles
} from "../../common/guards/allowed-roles.decorator";
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
  @AllowedBackofficePermissions("system-settings:view")
  settings(@Req() request: { authUser?: { permissions?: string[] } }) {
    return ok(this.systemSettingsService.getSettings({
      includeSensitiveValues: this.canViewSensitiveSettings(request)
    }));
  }

  @Patch()
  @AllowedBackofficePermissions("system-settings:update")
  updateSettings(
    @Body() body: SystemSettingsUpdatePayload,
    @Req() request: { authUser?: { permissions?: string[] } }
  ) {
    return ok(
      this.systemSettingsService.updateSettings(body, {
        includeSensitiveValues: this.canViewSensitiveSettings(request)
      }),
      "系统设置已保存。"
    );
  }

  private canViewSensitiveSettings(request: { authUser?: { permissions?: string[] } }) {
    return Boolean(request.authUser?.permissions?.includes("system-settings:secret:view"));
  }
}
