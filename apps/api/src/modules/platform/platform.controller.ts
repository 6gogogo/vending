import {
  Body,
  Controller,
  Get,
  Headers,
  Inject,
  Param,
  Post,
  Req,
  UseGuards
} from "@nestjs/common";

import type { PlatformTenantCreatePayload } from "@vm/shared-types";

import { ok } from "../../common/dto/api-response";
import {
  AllowedBackofficePermissions,
  AllowedBackofficeRoles,
  AllowedRoles,
  TenantScopedBackofficeRoute
} from "../../common/guards/allowed-roles.decorator";
import { RoleGuard } from "../../common/guards/role.guard";
import { AuthService } from "../auth/auth.service";
import { PlatformService } from "./platform.service";

@Controller("platform")
@UseGuards(RoleGuard)
@AllowedRoles("admin")
export class PlatformController {
  constructor(
    @Inject(PlatformService) private readonly platformService: PlatformService,
    @Inject(AuthService) private readonly authService: AuthService
  ) {}

  @Get("overview")
  @AllowedBackofficePermissions("platform-overview:view")
  overview() {
    return ok(this.platformService.getOverview());
  }

  @Get("tenants")
  @AllowedBackofficePermissions("platform-tenants:view")
  tenants() {
    return ok(this.platformService.listTenants());
  }

  @Post("tenants")
  @AllowedBackofficePermissions("platform-tenants:manage")
  createTenant(
    @Body() body: PlatformTenantCreatePayload,
    @Req() request: { authUser?: { id: string; name: string } }
  ) {
    return ok(
      this.platformService.createTenantWithFirstAdmin(body, request.authUser),
      "客户实例及首管理员已创建。"
    );
  }

  @Post("tenants/:tenantId/enter")
  @AllowedBackofficeRoles("super_admin")
  @AllowedBackofficePermissions("platform-tenants:view")
  enterTenant(
    @Param("tenantId") tenantId: string,
    @Headers("authorization") authorization?: string
  ) {
    return ok(
      this.authService.enterPlatformTenant(
        this.extractBearerToken(authorization),
        tenantId
      ),
      "已进入客户实例。"
    );
  }

  @Post("exit-instance")
  @AllowedBackofficeRoles("super_admin")
  @TenantScopedBackofficeRoute()
  exitInstance(@Headers("authorization") authorization?: string) {
    return ok(
      this.authService.exitPlatformTenant(this.extractBearerToken(authorization)),
      "已退出客户实例。"
    );
  }

  private extractBearerToken(authorization?: string) {
    return authorization?.startsWith("Bearer ")
      ? authorization.slice("Bearer ".length)
      : undefined;
  }
}
