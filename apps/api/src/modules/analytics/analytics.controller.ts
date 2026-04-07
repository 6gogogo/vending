import { Controller, Get, Inject, UseGuards } from "@nestjs/common";

import { ok } from "../../common/dto/api-response";
import { AllowedRoles } from "../../common/guards/allowed-roles.decorator";
import { RoleGuard } from "../../common/guards/role.guard";
import { AnalyticsService } from "./analytics.service";

@Controller("analytics")
@UseGuards(RoleGuard)
@AllowedRoles("admin")
export class AnalyticsController {
  constructor(@Inject(AnalyticsService) private readonly analyticsService: AnalyticsService) {}

  @Get("dashboard")
  dashboard() {
    return ok(this.analyticsService.getDashboard());
  }

  @Get("personas")
  personas() {
    return ok(this.analyticsService.getPersonaPlaceholders());
  }

  @Get("layout-suggestions")
  layoutSuggestions() {
    return ok(this.analyticsService.getLayoutSuggestions());
  }
}
