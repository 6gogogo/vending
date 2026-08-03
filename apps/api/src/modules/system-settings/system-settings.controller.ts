import {
  Body,
  Controller,
  Get,
  HttpCode,
  Inject,
  Patch,
  Post,
  Req,
  UseGuards
} from "@nestjs/common";
import type {
  BackofficeRole,
  InstanceRuntimeRestartPayload,
  SystemSettingsUpdatePayload,
  UserRole
} from "@vm/shared-types";

import { ok } from "../../common/dto/api-response";
import {
  AllowedBackofficePermissions,
  AllowedBackofficeRoles,
  AllowedRoles,
  TenantScopedBackofficeRoute
} from "../../common/guards/allowed-roles.decorator";
import { RoleGuard } from "../../common/guards/role.guard";
import { InstanceRuntimeControlService } from "./instance-runtime-control.service";
import { SystemSettingsService } from "./system-settings.service";

interface SystemSettingsRequest {
  authUser?: {
    id: string;
    role: UserRole;
    backofficeRole?: BackofficeRole;
    tenantId?: string;
    permissions?: string[];
  };
}

@Controller("system-settings")
@UseGuards(RoleGuard)
@AllowedRoles("admin")
export class SystemSettingsController {
  constructor(
    @Inject(SystemSettingsService)
    private readonly systemSettingsService: SystemSettingsService,
    @Inject(InstanceRuntimeControlService)
    private readonly instanceRuntimeControlService: InstanceRuntimeControlService
  ) {}

  @Get("runtime-control")
  @AllowedBackofficeRoles("super_admin")
  @AllowedBackofficePermissions("system-settings:view")
  @TenantScopedBackofficeRoute()
  runtimeControlStatus(@Req() request: SystemSettingsRequest) {
    return ok(this.instanceRuntimeControlService.getStatus(request.authUser));
  }

  @Post("runtime-control/restart")
  @HttpCode(202)
  @AllowedBackofficeRoles("super_admin")
  @AllowedBackofficePermissions("system-settings:update")
  @TenantScopedBackofficeRoute()
  restartCurrentInstance(
    @Body() body: InstanceRuntimeRestartPayload,
    @Req() request: SystemSettingsRequest
  ) {
    return ok(
      this.instanceRuntimeControlService.scheduleRestart(body, request.authUser),
      "当前实例应用已安排重启。"
    );
  }

  @Get()
  @AllowedBackofficePermissions("system-settings:view")
  settings(@Req() request: SystemSettingsRequest) {
    return ok(this.systemSettingsService.getSettings({
      includeSensitiveValues: this.canViewSensitiveSettings(request),
      actorBackofficeRole: request.authUser?.backofficeRole
    }));
  }

  @Patch()
  @AllowedBackofficePermissions("system-settings:update")
  updateSettings(
    @Body() body: SystemSettingsUpdatePayload,
    @Req() request: SystemSettingsRequest
  ) {
    return ok(
      this.systemSettingsService.updateSettings(body, {
        includeSensitiveValues: this.canViewSensitiveSettings(request),
        actorBackofficeRole: request.authUser?.backofficeRole
      }),
      "系统设置已保存。"
    );
  }

  private canViewSensitiveSettings(request: SystemSettingsRequest) {
    return Boolean(
      request.authUser?.backofficeRole === "super_admin" &&
        request.authUser.permissions?.includes("system-settings:secret:view")
    );
  }
}
