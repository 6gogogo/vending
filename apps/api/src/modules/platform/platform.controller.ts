import { Controller, Get, Inject, UseGuards } from "@nestjs/common";

import { ok } from "../../common/dto/api-response";
import {
  AllowedBackofficePermissions,
  AllowedRoles
} from "../../common/guards/allowed-roles.decorator";
import { RoleGuard } from "../../common/guards/role.guard";
import { PlatformService } from "./platform.service";

@Controller("platform")
@UseGuards(RoleGuard)
@AllowedRoles("admin")
export class PlatformController {
  constructor(@Inject(PlatformService) private readonly platformService: PlatformService) {}

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
}
