import { Body, Controller, Get, Inject, Patch, Query, Req, UseGuards } from "@nestjs/common";

import { ok } from "../../common/dto/api-response";
import {
  AllowedBackofficePermissions,
  AllowedBackofficeSessionPermissions,
  AllowedRoles
} from "../../common/guards/allowed-roles.decorator";
import { RoleGuard } from "../../common/guards/role.guard";
import { AccessRulesService } from "./access-rules.service";

@Controller("access-rules")
export class AccessRulesController {
  constructor(@Inject(AccessRulesService) private readonly accessRulesService: AccessRulesService) {}

  @Get()
  @UseGuards(RoleGuard)
  @AllowedRoles("admin")
  @AllowedBackofficePermissions("users:view")
  list() {
    return ok(this.accessRulesService.list());
  }

  @Get("summary")
  @UseGuards(RoleGuard)
  @AllowedRoles("admin", "merchant", "special")
  @AllowedBackofficeSessionPermissions("users:view")
  summary(
    @Query("phone") phone: string | undefined,
    @Req() request?: { authUser?: { id: string; role: "admin" | "merchant" | "special" } }
  ) {
    const actor = request?.authUser;
    return ok(
      actor?.role === "admin"
        ? this.accessRulesService.getQuotaSummaryByPhone(phone ?? "")
        : this.accessRulesService.getQuotaSummaryByUserId(actor?.id)
    );
  }

  @Patch()
  @UseGuards(RoleGuard)
  @AllowedRoles("admin")
  @AllowedBackofficePermissions("users:rules:manage")
  update(
    @Query("role") role: "special" | "merchant",
    @Body() body: { dailyLimit?: number; categoryLimit?: Record<string, number> }
  ) {
    return ok(this.accessRulesService.update(role, body));
  }
}
