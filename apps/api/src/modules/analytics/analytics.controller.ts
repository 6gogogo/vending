import { Controller, Get, Inject, Query, UseGuards } from "@nestjs/common";

import { ok } from "../../common/dto/api-response";
import { AllowedRoles } from "../../common/guards/allowed-roles.decorator";
import { RoleGuard } from "../../common/guards/role.guard";
import { AnalyticsService } from "./analytics.service";
import type { DataMonitorRange } from "@vm/shared-types";

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

  @Get("data-monitor")
  dataMonitor(
    @Query("month") month?: string,
    @Query("date") date?: string,
    @Query("range") range?: DataMonitorRange
  ) {
    return ok(this.analyticsService.getDataMonitor({ month, date, range }));
  }
}
