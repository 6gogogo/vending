import { Body, Controller, Get, Inject, Patch, Query, UseGuards } from "@nestjs/common";

import { ok } from "../../common/dto/api-response";
import { AllowedRoles } from "../../common/guards/allowed-roles.decorator";
import { RoleGuard } from "../../common/guards/role.guard";
import { AccessRulesService } from "./access-rules.service";

@Controller("access-rules")
export class AccessRulesController {
  constructor(@Inject(AccessRulesService) private readonly accessRulesService: AccessRulesService) {}

  @Get()
  @UseGuards(RoleGuard)
  @AllowedRoles("admin")
  list() {
    return ok(this.accessRulesService.list());
  }

  @Get("summary")
  summary(@Query("phone") phone: string) {
    return ok(this.accessRulesService.getQuotaSummaryByPhone(phone));
  }

  @Patch()
  @UseGuards(RoleGuard)
  @AllowedRoles("admin")
  update(
    @Query("role") role: "special" | "merchant",
    @Body() body: { dailyLimit?: number; categoryLimit?: Record<string, number> }
  ) {
    return ok(this.accessRulesService.update(role, body));
  }
}
