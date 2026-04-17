import { Body, Controller, Get, Inject, Post, Query, UseGuards } from "@nestjs/common";

import type { AiOperationsReportType, DataMonitorRange } from "@vm/shared-types";

import { ok } from "../../common/dto/api-response";
import { AllowedRoles } from "../../common/guards/allowed-roles.decorator";
import { RoleGuard } from "../../common/guards/role.guard";
import { AiInsightsService } from "./ai-insights.service";

@Controller("ai-insights")
@UseGuards(RoleGuard)
@AllowedRoles("admin")
export class AiInsightsController {
  constructor(@Inject(AiInsightsService) private readonly aiInsightsService: AiInsightsService) {}

  @Get("status")
  status() {
    return ok(this.aiInsightsService.status());
  }

  @Post("event-diagnosis")
  async eventDiagnosis(
    @Body()
    body: {
      eventId?: string;
      orderNo?: string;
      logId?: string;
    }
  ) {
    return ok(await this.aiInsightsService.diagnoseEvent(body), "分析完成");
  }

  @Get("operations-report")
  async operationsReport(
    @Query("dateKey") dateKey?: string,
    @Query("reportType") reportType?: AiOperationsReportType
  ) {
    return ok(await this.aiInsightsService.operationsReport({ dateKey, reportType }), "分析完成");
  }

  @Get("restock-layout-suggestions")
  async restockLayoutSuggestions(
    @Query("dateKey") dateKey?: string,
    @Query("range") range?: DataMonitorRange
  ) {
    return ok(await this.aiInsightsService.restockLayoutSuggestions({ dateKey, range }), "分析完成");
  }

  @Post("feedback-draft")
  async feedbackDraft(
    @Body()
    body: {
      alertId: string;
    }
  ) {
    return ok(await this.aiInsightsService.feedbackDraft(body), "分析完成");
  }

  @Get("policy-optimization")
  async policyOptimization(
    @Query("dateKey") dateKey?: string,
    @Query("range") range?: DataMonitorRange
  ) {
    return ok(await this.aiInsightsService.policyOptimization({ dateKey, range }), "分析完成");
  }
}
