import { Controller, Get, Inject, Query, Req, UseGuards } from "@nestjs/common";

import { ok } from "../../common/dto/api-response";
import {
  AllowedBackofficePermissions,
  AllowedBackofficeRoles,
  AllowedRoles
} from "../../common/guards/allowed-roles.decorator";
import { RoleGuard } from "../../common/guards/role.guard";
import { AnalyticsService } from "./analytics.service";
import type { BackofficeRole, DataMonitorRange } from "@vm/shared-types";

@Controller("analytics")
@UseGuards(RoleGuard)
@AllowedRoles("admin")
@AllowedBackofficeRoles("super_admin", "admin")
@AllowedBackofficePermissions("dashboard:view")
export class AnalyticsController {
  constructor(@Inject(AnalyticsService) private readonly analyticsService: AnalyticsService) {}

  @Get("dashboard")
  dashboard(@Req() request: { authUser?: { backofficeRole?: BackofficeRole } }) {
    return ok(this.analyticsService.getDashboard(request.authUser?.backofficeRole));
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
  @AllowedBackofficePermissions("analytics:data-monitor:view")
  dataMonitor(
    @Query("month") month?: string,
    @Query("date") date?: string,
    @Query("range") range?: DataMonitorRange
  ) {
    return ok(this.analyticsService.getDataMonitor({ month, date, range }));
  }
}
