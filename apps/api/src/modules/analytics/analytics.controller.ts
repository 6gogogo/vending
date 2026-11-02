import { Controller, Get, Inject, Query, Req, Res, UseGuards } from "@nestjs/common";

import { ok } from "../../common/dto/api-response";
import {
  AllowedBackofficePermissions,
  AllowedBackofficeSessionPermissions,
  AllowedRoles,
  AllowedBackofficeAllPermissions,
  TenantScopedBackofficeRoute
} from "../../common/guards/allowed-roles.decorator";
import { RoleGuard } from "../../common/guards/role.guard";
import { AnalyticsService } from "./analytics.service";
import type { BackofficeRole, DataMonitorRange, ServiceVisitDayQuery, ServiceVisitQuery } from "@vm/shared-types";

import type { PickupReportQuery } from "./pickup-report.model";

@Controller("analytics")
@UseGuards(RoleGuard)
@AllowedRoles("admin")
@AllowedBackofficePermissions("dashboard:view")
export class AnalyticsController {
  constructor(@Inject(AnalyticsService) private readonly analyticsService: AnalyticsService) {}

  @Get("pickups/export")
  @AllowedBackofficeAllPermissions("analytics:data-monitor:view", "operation-logs:export")
  @AllowedBackofficePermissions("analytics:data-monitor:view")
  @TenantScopedBackofficeRoute()
  async exportPickups(
    @Query() query: PickupReportQuery,
    @Req() request: { authUser?: { tenantId?: string } },
    @Res() response: { setHeader(name: string, value: string): void; send(body: Buffer): void }
  ) {
    const file = await this.analyticsService.exportPickups(query, request.authUser?.tenantId);
    response.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    response.setHeader("Content-Disposition", `attachment; filename*=UTF-8''${encodeURIComponent(file.filename)}`);
    response.setHeader("Cache-Control", "no-store");
    response.send(file.body);
  }

  @Get("dashboard")
  dashboard(@Req() request: { authUser?: { backofficeRole?: BackofficeRole } }) {
    return ok(this.analyticsService.getDashboard(request.authUser?.backofficeRole));
  }

  @Get("service-visits/daily")
  @TenantScopedBackofficeRoute()
  @AllowedBackofficePermissions("analytics:data-monitor:view")
  serviceVisitDay(@Req() request: { authUser?: { tenantId?: string } }, @Query() query: ServiceVisitDayQuery) {
    return ok(this.analyticsService.getServiceVisitDay(request.authUser?.tenantId, query));
  }

  @Get("service-visits")
  @TenantScopedBackofficeRoute()
  @AllowedBackofficePermissions("analytics:data-monitor:view")
  serviceVisits(@Req() request: { authUser?: { tenantId?: string } }, @Query() query: ServiceVisitQuery) {
    return ok(this.analyticsService.getServiceVisits(request.authUser?.tenantId, query));
  }

  @Get("personas")
  personas() {
    return ok(this.analyticsService.getPersonaPlaceholders());
  }

  @Get("pickup-summary")
  @AllowedBackofficePermissions()
  @AllowedBackofficeSessionPermissions("analytics:data-monitor:view")
  pickupSummary(@Query("date") date?: string) {
    return ok(this.analyticsService.getDailyPickupSummary(date));
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
