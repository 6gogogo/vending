import { Body, Controller, Get, Inject, Patch, Post, Query, Req, UseGuards } from "@nestjs/common";

import type { AiOperationsReportType, AiProviderConfigPayload, DataMonitorRange, UserRole } from "@vm/shared-types";

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
  @AllowedRoles("admin", "merchant", "special")
  status() {
    return ok(this.aiInsightsService.status());
  }

  @Patch("config")
  saveProviderConfig(@Body() body: AiProviderConfigPayload) {
    return ok(this.aiInsightsService.saveProviderConfig(body), "配置已保存");
  }

  @Post("test")
  async testProvider() {
    return ok(await this.aiInsightsService.testProvider(), "测试完成");
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

  @Post("support-assistant")
  @AllowedRoles("admin", "merchant", "special")
  async supportAssistant(
    @Body()
    body: {
      question: string;
      scene?: string;
      history?: Array<{
        role: "user" | "assistant";
        content: string;
      }>;
    },
    @Req()
    request: {
      authUser?: { id: string; role: UserRole };
      userRole?: UserRole;
    }
  ) {
    return ok(
      await this.aiInsightsService.supportAssistant({
        question: body.question,
        scene: body.scene,
        history: body.history,
        role: request.authUser?.role ?? request.userRole ?? "special",
        actorUserId: request.authUser?.id
      }),
      "分析完成"
    );
  }

  @Post("admin-custom-query")
  async adminCustomQuery(
    @Body()
    body: {
      question: string;
      dateKey?: string;
      range?: DataMonitorRange;
      history?: Array<{
        role: "user" | "assistant";
        content: string;
      }>;
    },
    @Req() request: { authUser?: { id: string } }
  ) {
    return ok(
      await this.aiInsightsService.adminCustomQuery({
        question: body.question,
        dateKey: body.dateKey,
        range: body.range,
        history: body.history,
        actorUserId: request.authUser?.id
      }),
      "分析完成"
    );
  }

  @Get("policy-optimization")
  async policyOptimization(
    @Query("dateKey") dateKey?: string,
    @Query("range") range?: DataMonitorRange
  ) {
    return ok(await this.aiInsightsService.policyOptimization({ dateKey, range }), "分析完成");
  }
}
