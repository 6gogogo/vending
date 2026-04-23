import { BadRequestException, Inject, Injectable, NotFoundException } from "@nestjs/common";

import type {
  AiDeviceRestockRecommendation,
  AiEventDiagnosis,
  AiFeedbackDraft,
  AiInsightConfidence,
  AiInsightUrgency,
  AiOperationsReport,
  AiOperationsReportType,
  AiPolicyOptimizationSuggestion,
  AiProviderConfigPayload,
  AiSupportAssistantReply,
  AiProviderTestResult,
  AiRestockLayoutSuggestion,
  AlertTask,
  CabinetEventRecord,
  DataMonitorRange,
  OperationLogRecord
} from "@vm/shared-types";

import { InMemoryStoreService } from "../../common/store/in-memory-store.service";
import { getBusinessDayKey } from "../../common/time/business-day";
import { AlertsService } from "../alerts/alerts.service";
import { AnalyticsService } from "../analytics/analytics.service";
import { DevicesService } from "../devices/devices.service";
import { GoodsService } from "../goods/goods.service";
import { OperationLogsService } from "../operation-logs/operation-logs.service";
import { WarehousesService } from "../warehouses/warehouses.service";
import { OpenAiCompatibleService } from "./openai-compatible.service";

@Injectable()
export class AiInsightsService {
  private readonly cache = new Map<string, { expiresAt: number; value: unknown }>();

  constructor(
    @Inject(InMemoryStoreService) private readonly store: InMemoryStoreService,
    @Inject(OpenAiCompatibleService)
    private readonly openAiCompatibleService: OpenAiCompatibleService,
    @Inject(AlertsService) private readonly alertsService: AlertsService,
    @Inject(AnalyticsService) private readonly analyticsService: AnalyticsService,
    @Inject(DevicesService) private readonly devicesService: DevicesService,
    @Inject(GoodsService) private readonly goodsService: GoodsService,
    @Inject(OperationLogsService) private readonly operationLogsService: OperationLogsService,
    @Inject(WarehousesService) private readonly warehousesService: WarehousesService
  ) {}

  status() {
    return this.openAiCompatibleService.getStatus();
  }

  saveProviderConfig(payload: AiProviderConfigPayload) {
    this.cache.clear();
    return this.openAiCompatibleService.saveConfig(payload);
  }

  testProvider(): Promise<AiProviderTestResult> {
    return this.openAiCompatibleService.testConnection();
  }

  async diagnoseEvent(payload: { eventId?: string; orderNo?: string; logId?: string }) {
    const resolved = this.resolveEventPayload(payload);
    const cacheKey = `diagnose:${resolved.event.eventId}:${resolved.relatedLog?.id ?? "-"}`;

    return this.withCache(cacheKey, async () => {
      return this.buildEventDiagnosis(resolved.event, resolved.relatedLog);
    });
  }

  async operationsReport(payload?: { dateKey?: string; reportType?: AiOperationsReportType }) {
    const dateKey = this.normalizeDateKey(payload?.dateKey);
    const reportType = this.normalizeReportType(payload?.reportType);
    const cacheKey = `ops-report:${dateKey}:${reportType}`;

    return this.withCache(cacheKey, async () => {
      return this.buildOperationsReport(dateKey, reportType);
    });
  }

  async restockLayoutSuggestions(payload?: { dateKey?: string; range?: DataMonitorRange }) {
    const dateKey = this.normalizeDateKey(payload?.dateKey);
    const range = this.normalizeRange(payload?.range);
    const cacheKey = `restock-layout:${dateKey}:${range}`;

    return this.withCache(cacheKey, async () => {
      return this.buildRestockLayoutSuggestions(dateKey, range);
    });
  }

  async feedbackDraft(payload: { alertId: string }) {
    const alert = this.store.alerts.find((entry) => entry.id === payload.alertId);

    if (!alert) {
      throw new NotFoundException("未找到对应反馈任务。");
    }

    const cacheKey = `feedback-draft:${alert.id}:${alert.status}`;
    return this.withCache(cacheKey, async () => this.buildFeedbackDraft(alert));
  }

  async supportAssistant(payload: {
    question: string;
    scene?: string;
    history?: Array<{
      role: "user" | "assistant";
      content: string;
    }>;
    role: "admin" | "merchant" | "special";
    actorUserId?: string;
  }) {
    const question = payload.question.trim();

    if (!question) {
      throw new BadRequestException("请输入需要协助的问题。");
    }

    return this.buildSupportAssistantReply({
      ...payload,
      question
    });
  }

  async policyOptimization(payload?: { dateKey?: string; range?: DataMonitorRange }) {
    const dateKey = this.normalizeDateKey(payload?.dateKey);
    const range = this.normalizeRange(payload?.range);
    const cacheKey = `policy-optimization:${dateKey}:${range}`;

    return this.withCache(cacheKey, async () => {
      return this.buildPolicyOptimization(dateKey, range);
    });
  }

  private async buildEventDiagnosis(
    event: CabinetEventRecord,
    relatedLog?: OperationLogRecord
  ): Promise<AiEventDiagnosis> {
    const monitoring = this.devicesService.monitoringDetail(event.deviceCode);
    const searchTokens = this.buildIdentityTokens({
      eventId: event.eventId,
      orderNo: event.orderNo,
      adjustmentOrderNo: event.adjustmentOrderNo,
      deviceCode: event.deviceCode,
      logId: relatedLog?.id
    });
    const relatedLogs = this.store.logs
      .filter(
        (entry) =>
          entry.relatedEventId === event.eventId ||
          entry.relatedOrderNo === event.orderNo ||
          entry.relatedOrderNo === event.adjustmentOrderNo
      )
      .sort((left, right) => left.occurredAt.localeCompare(right.occurredAt))
      .slice(-16)
      .map((entry) => this.toLogSummary(entry));
    const callbackLogs = this.findRelatedCallbackLogs(searchTokens).slice(0, 12);
    const auditLogs = this.findRelatedSystemAudits(event.deviceCode, searchTokens).slice(0, 12);
    const relatedAlerts = this.alertsService
      .list()
      .filter(
        (entry) =>
          entry.relatedEventId === event.eventId ||
          (entry.deviceCode === event.deviceCode && entry.status !== "resolved")
      )
      .slice(0, 12)
      .map((entry) => this.toAlertSummary(entry));
    const relatedInventory = this.store.inventory
      .filter(
        (entry) =>
          entry.eventId === event.eventId ||
          entry.orderNo === event.orderNo ||
          entry.sourceOrderNo === event.orderNo
      )
      .slice(0, 12)
      .map((entry) => ({
        type: entry.type,
        goodsName: entry.goodsName,
        quantity: entry.quantity,
        happenedAt: entry.happenedAt,
        unitPrice: entry.unitPrice,
        refundNo: entry.refundNo,
        transactionId: entry.transactionId
      }));
    const batchTraces = this.store.batchConsumptionTraces
      .filter((entry) => entry.eventId === event.eventId || entry.orderNo === event.orderNo)
      .slice(0, 12)
      .map((entry) => ({
        goodsName: entry.goodsName,
        quantity: entry.quantity,
        sourceUserName: entry.sourceUserName,
        consumerUserName: entry.consumerUserName,
        happenedAt: entry.happenedAt
      }));

    // AI 只基于可核验的业务证据生成建议，方便一线人员处理真正影响服务的异常。
    const context = {
      target: {
        eventId: event.eventId,
        orderNo: event.orderNo,
        deviceCode: event.deviceCode,
        deviceName: monitoring.device.name,
        status: event.status,
        createdAt: event.createdAt,
        updatedAt: event.updatedAt,
        role: event.role,
        phone: event.phone,
        amount: event.amount,
        paymentNotifyStatus: event.paymentNotifyStatus,
        paymentNotifyMessage: event.paymentNotifyMessage,
        adjustmentOrderNo: event.adjustmentOrderNo,
        adjustmentAmount: event.adjustmentAmount,
        adjustmentPaymentNotifyStatus: event.adjustmentPaymentNotifyStatus,
        adjustmentPaymentNotifyMessage: event.adjustmentPaymentNotifyMessage,
        refundNo: event.refundNo,
        refundTransactionId: event.refundTransactionId,
        refundedAt: event.refundedAt,
        goods: event.goods
      },
      runtime: {
        doorState: monitoring.runtime.doorState,
        lastCommandAt: monitoring.runtime.lastCommandAt,
        lastOpenedAt: monitoring.runtime.lastOpenedAt,
        lastClosedAt: monitoring.runtime.lastClosedAt,
        lastRefreshAt: monitoring.runtime.lastRefreshAt,
        openedAfterLastCommand: monitoring.runtime.openedAfterLastCommand
      },
      recentEvents: monitoring.recentEvents.slice(0, 5).map((entry) => ({
        eventId: entry.eventId,
        orderNo: entry.orderNo,
        status: entry.status,
        updatedAt: entry.updatedAt
      })),
      stockChanges: monitoring.stockChanges.slice(0, 8),
      relatedLogs,
      callbackLogs,
      auditLogs,
      relatedAlerts,
      relatedInventory,
      batchTraces
    };

    const generated = await this.openAiCompatibleService.completeJson<{
      summary?: unknown;
      confidence?: unknown;
      possibleCauses?: unknown;
      handlingSuggestions?: unknown;
      requiresOnsiteInspection?: unknown;
      onsiteInspectionReason?: unknown;
      referencedSignals?: unknown;
    }>({
      task: "event-diagnosis",
      systemPrompt:
        "你是社区公益智助柜系统的设备异常诊断助手。你只能基于提供的数据给出判断，不要臆造未提供的事实。请用中文输出，且只返回 JSON 对象。",
      userPrompt: [
        "请对以下单次开柜事件做异常诊断。",
        "输出字段必须严格为：",
        JSON.stringify(
          {
            summary: "一句话结论",
            confidence: "high|medium|low",
            possibleCauses: ["可能原因 1", "可能原因 2"],
            handlingSuggestions: ["处置建议 1", "处置建议 2"],
            requiresOnsiteInspection: true,
            onsiteInspectionReason: "是否需要现场巡检及原因",
            referencedSignals: ["引用到的关键证据 1", "引用到的关键证据 2"]
          },
          null,
          2
        ),
        "要求：原因和建议都要尽量具体，优先结合门状态、结算、补扣、退款、回调日志和系统审计。",
        "分析输入：",
        JSON.stringify(context, null, 2)
      ].join("\n"),
      maxTokens: 1600
    });

    const diagnosis: AiEventDiagnosis = {
      meta: {
        generatedAt: new Date().toISOString(),
        provider: "openai-compatible",
        model: generated.model
      },
      target: {
        eventId: event.eventId,
        orderNo: event.orderNo,
        deviceCode: event.deviceCode,
        deviceName: monitoring.device.name,
        status: event.status,
        relatedLogId: relatedLog?.id
      },
      summary: this.readString(
        generated.data.summary,
        `事件 ${event.eventId} 已完成自动分析，请结合建议继续排查。`
      ),
      confidence: this.readConfidence(generated.data.confidence),
      possibleCauses: this.readStringArray(generated.data.possibleCauses, [
        "当前证据不足以锁定单一故障点，建议继续结合现场巡检确认。"
      ]),
      handlingSuggestions: this.readStringArray(generated.data.handlingSuggestions, [
        "请优先核对门状态回调、结算回调和设备在线情况。"
      ]),
      requiresOnsiteInspection: this.readBoolean(generated.data.requiresOnsiteInspection),
      onsiteInspectionReason: this.readString(
        generated.data.onsiteInspectionReason,
        "暂无明确现场巡检理由，可先远程核对日志。"
      ),
      referencedSignals: this.readStringArray(generated.data.referencedSignals, [
        "已结合事件状态、相关日志和回调记录自动生成。"
      ])
    };

    this.store.logOperation({
      category: "admin",
      type: "ai-event-diagnosis",
      status: "success",
      actor: this.getAdminActor(),
      primarySubject: {
        type: "event",
        id: event.eventId,
        label: event.orderNo
      },
      secondarySubject: {
        type: "device",
        id: event.deviceCode,
        label: monitoring.device.name
      },
      metadata: {
        aiTask: "event-diagnosis",
        confidence: diagnosis.confidence,
        requiresOnsiteInspection: diagnosis.requiresOnsiteInspection,
        undoState: "not_undoable"
      }
    });

    return diagnosis;
  }

  private async buildOperationsReport(
    dateKey: string,
    reportType: AiOperationsReportType
  ): Promise<AiOperationsReport> {
    const monitor = this.analyticsService.getDataMonitor({
      date: dateKey,
      range: "today"
    });
    const goodsOverview = this.goodsService.getOverview();
    const alerts = this.alertsService.list();
    const openAlerts = alerts.filter((entry) => entry.status !== "resolved").slice(0, 20);
    const createdAlerts = alerts
      .filter((entry) => getBusinessDayKey(entry.createdAt) === dateKey)
      .slice(0, 20);

    const context = {
      dateKey,
      reportType,
      selectedDateSummary: monitor.selectedDateSummary,
      openAlerts: openAlerts.map((entry) => this.toAlertSummary(entry)),
      createdAlerts: createdAlerts.map((entry) => this.toAlertSummary(entry)),
      flaggedGoods: goodsOverview.flaggedGoods.slice(0, 20),
      recentLogs: (monitor.selectedDateSummary?.recentLogs ?? [])
        .slice(0, 12)
        .map((entry) => this.toLogSummary(entry))
    };

    const generated = await this.openAiCompatibleService.completeJson<{
      summary?: unknown;
      priorityItems?: unknown;
      stockRisks?: unknown;
      expiryRisks?: unknown;
      feedbackHighlights?: unknown;
      recommendedActions?: unknown;
    }>({
      task: "operations-report",
      systemPrompt:
        "你是社区公益智助柜系统的运维值班助手。请基于给定数据输出晨报或日报摘要。不要夸张风险，不要输出 markdown，只返回 JSON。",
      userPrompt: [
        `请为 ${dateKey} 生成${reportType === "morning" ? "晨报" : "日报"}。`,
        "输出字段必须严格为：",
        JSON.stringify(
          {
            summary: "整体摘要",
            priorityItems: ["优先处理事项 1"],
            stockRisks: ["缺货或低库存风险 1"],
            expiryRisks: ["临期风险 1"],
            feedbackHighlights: ["反馈重点 1"],
            recommendedActions: ["建议动作 1"]
          },
          null,
          2
        ),
        "请优先覆盖：待处理预警、缺货、临期、反馈、当日服务量变化。",
        "输入数据：",
        JSON.stringify(context, null, 2)
      ].join("\n"),
      maxTokens: 1500
    });

    const report: AiOperationsReport = {
      meta: {
        generatedAt: new Date().toISOString(),
        provider: "openai-compatible",
        model: generated.model
      },
      dateKey,
      reportType,
      summary: this.readString(
        generated.data.summary,
        `${dateKey} 的运维摘要已生成，请结合任务池继续处理。`
      ),
      priorityItems: this.readStringArray(generated.data.priorityItems, [
        "优先处理当前开放状态的故障与反馈任务。"
      ]),
      stockRisks: this.readStringArray(generated.data.stockRisks, [
        "请重点核对当前低库存和缺货柜机。"
      ]),
      expiryRisks: this.readStringArray(generated.data.expiryRisks, [
        "请核对当天命中的临期批次。"
      ]),
      feedbackHighlights: this.readStringArray(generated.data.feedbackHighlights, [
        "请关注当天新增的用户反馈与商户提醒。"
      ]),
      recommendedActions: this.readStringArray(generated.data.recommendedActions, [
        "建议按故障、反馈、库存、临期顺序推进处理。"
      ])
    };

    this.store.logOperation({
      category: "admin",
      type: "ai-operations-report",
      status: "success",
      actor: this.getAdminActor(),
      metadata: {
        aiTask: "operations-report",
        dateKey,
        reportType,
        undoState: "not_undoable"
      }
    });

    return report;
  }

  private async buildRestockLayoutSuggestions(
    dateKey: string,
    range: DataMonitorRange
  ): Promise<AiRestockLayoutSuggestion> {
    const monitor = this.analyticsService.getDataMonitor({
      date: dateKey,
      range
    });
    const goodsOverview = this.goodsService.getOverview();
    const warehouseInventory = this.warehousesService.getInventory();

    const context = {
      dateKey,
      range,
      periodSummary: monitor.periodSummary,
      rangeSeries: monitor.rangeSeries,
      regionBreakdown: monitor.regionBreakdown,
      flaggedGoods: goodsOverview.flaggedGoods.slice(0, 24),
      byGoods: goodsOverview.byGoods.slice(0, 20),
      byDevice: goodsOverview.byDevice.slice(0, 20),
      warehouseItems: warehouseInventory.items.slice(0, 20)
    };

    const generated = await this.openAiCompatibleService.completeJson<{
      summary?: unknown;
      deviceRecommendations?: unknown;
      regionRecommendations?: unknown;
      scheduleInsights?: unknown;
    }>({
      task: "restock-layout-suggestions",
      systemPrompt:
        "你是社区公益智助柜系统的补货与布局分析助手。请结合区域热度、时段分布、库存和仓库可用量给出具体建议。只返回 JSON。",
      userPrompt: [
        `请基于 ${dateKey} 及 ${range} 范围内的数据，生成补货与布局建议。`,
        "输出字段必须严格为：",
        JSON.stringify(
          {
            summary: "整体建议摘要",
            deviceRecommendations: [
              {
                deviceCode: "CAB-1001",
                deviceName: "示例柜机",
                goodsId: "goods-1001",
                goodsName: "示例物资",
                suggestedQuantity: 6,
                reason: "补货原因"
              }
            ],
            regionRecommendations: [
              {
                regionId: "region-001",
                regionName: "示例片区",
                suggestion: "增加饮品供给",
                reason: "布局原因"
              }
            ],
            scheduleInsights: ["时段建议 1"]
          },
          null,
          2
        ),
        "请尽量给出可执行建议，不要泛泛而谈。",
        "输入数据：",
        JSON.stringify(context, null, 2)
      ].join("\n"),
      maxTokens: 1700
    });

    const result: AiRestockLayoutSuggestion = {
      meta: {
        generatedAt: new Date().toISOString(),
        provider: "openai-compatible",
        model: generated.model
      },
      dateKey,
      range,
      summary: this.readString(
        generated.data.summary,
        "已根据区域热度、库存和仓库情况生成补货与布局建议。"
      ),
      deviceRecommendations: this.readDeviceRecommendations(generated.data.deviceRecommendations),
      regionRecommendations: this.readRegionRecommendations(generated.data.regionRecommendations),
      scheduleInsights: this.readStringArray(generated.data.scheduleInsights, [
        "建议结合高峰时段提前完成关键柜机补货。"
      ])
    };

    this.store.logOperation({
      category: "admin",
      type: "ai-restock-layout-suggestions",
      status: "success",
      actor: this.getAdminActor(),
      metadata: {
        aiTask: "restock-layout-suggestions",
        dateKey,
        range,
        undoState: "not_undoable"
      }
    });

    return result;
  }

  private async buildFeedbackDraft(alert: AlertTask): Promise<AiFeedbackDraft> {
    const deviceMonitoring = alert.deviceCode
      ? this.devicesService.monitoringDetail(alert.deviceCode)
      : undefined;
    const targetUser = alert.targetUserId
      ? this.store.users.find((entry) => entry.id === alert.targetUserId)
      : undefined;
    const relatedLogs = this.store.logs
      .filter(
        (entry) =>
          entry.primarySubject?.id === alert.id ||
          entry.secondarySubject?.id === alert.id ||
          entry.metadata?.targetUserId === alert.targetUserId ||
          (alert.deviceCode ? entry.metadata?.deviceCode === alert.deviceCode : false)
      )
      .sort((left, right) => right.occurredAt.localeCompare(left.occurredAt))
      .slice(0, 12)
      .map((entry) => this.toLogSummary(entry));
    const callbackLogs = alert.deviceCode
      ? this.findRelatedCallbackLogs(this.buildIdentityTokens({ deviceCode: alert.deviceCode })).slice(0, 8)
      : [];

    const context = {
      alert: this.toAlertSummary(alert),
      targetUser: targetUser
        ? {
            id: targetUser.id,
            name: targetUser.name,
            role: targetUser.role,
            phone: targetUser.phone,
            regionName: targetUser.regionName ?? targetUser.neighborhood,
            tags: targetUser.tags
          }
        : undefined,
      device: deviceMonitoring
        ? {
            deviceCode: deviceMonitoring.device.deviceCode,
            name: deviceMonitoring.device.name,
            status: deviceMonitoring.device.status,
            location: deviceMonitoring.device.location,
            runtime: deviceMonitoring.runtime,
            pendingTasks: deviceMonitoring.pendingTasks.slice(0, 6).map((entry) => this.toAlertSummary(entry))
          }
        : undefined,
      relatedLogs,
      callbackLogs
    };

    const generated = await this.openAiCompatibleService.completeJson<{
      title?: unknown;
      classification?: unknown;
      urgency?: unknown;
      summary?: unknown;
      dispatchRecommendation?: unknown;
      replyDraft?: unknown;
    }>({
      task: "feedback-draft",
      systemPrompt:
        "你是社区公益智助柜系统的反馈分流助手。请把反馈归类、判断紧急程度，并生成适合管理员发送的中文回复草稿。只返回 JSON。",
      userPrompt: [
        "请对以下反馈任务进行分流和回复草稿生成。",
        "输出字段必须严格为：",
        JSON.stringify(
          {
            title: "反馈标题",
            classification: "故障/服务/流程/其他",
            urgency: "high|medium|low",
            summary: "一句话摘要",
            dispatchRecommendation: "推荐交给谁处理、是否先电话联系或现场检查",
            replyDraft: "可直接回复给用户的草稿"
          },
          null,
          2
        ),
        "要求：回复草稿要礼貌、简洁、可直接发送。",
        "输入数据：",
        JSON.stringify(context, null, 2)
      ].join("\n"),
      maxTokens: 1200
    });

    const result: AiFeedbackDraft = {
      meta: {
        generatedAt: new Date().toISOString(),
        provider: "openai-compatible",
        model: generated.model
      },
      alertId: alert.id,
      title: this.readString(generated.data.title, alert.title),
      classification: this.readString(generated.data.classification, "待人工进一步确认"),
      urgency: this.readUrgency(generated.data.urgency),
      summary: this.readString(
        generated.data.summary,
        "已生成反馈分流建议，请管理员结合现场情况处理。"
      ),
      dispatchRecommendation: this.readString(
        generated.data.dispatchRecommendation,
        "建议由管理员先核实设备与日志，再决定是否派现场人员处理。"
      ),
      replyDraft: this.readString(
        generated.data.replyDraft,
        "您好，您的反馈我们已经收到，工作人员会尽快核查并处理，感谢您的反馈。"
      )
    };

    this.store.logOperation({
      category: "admin",
      type: "ai-feedback-draft",
      status: "success",
      actor: this.getAdminActor(),
      primarySubject: {
        type: "alert",
        id: alert.id,
        label: alert.title
      },
      secondarySubject: alert.deviceCode
        ? {
            type: "device",
            id: alert.deviceCode,
            label: deviceMonitoring?.device.name ?? alert.deviceCode
          }
        : undefined,
      metadata: {
        aiTask: "feedback-draft",
        urgency: result.urgency,
        undoState: "not_undoable"
      }
    });

    return result;
  }

  private async buildPolicyOptimization(
    dateKey: string,
    range: DataMonitorRange
  ): Promise<AiPolicyOptimizationSuggestion> {
    const dashboard = this.analyticsService.getDashboard();
    const monitor = this.analyticsService.getDataMonitor({
      date: dateKey,
      range
    });

    const context = {
      currentBusinessDateKey: dashboard.businessDateKey,
      targetDateKey: dateKey,
      range,
      currentRules: this.store.rules,
      specialPolicies: this.store.specialAccessPolicies.map((entry) => ({
        id: entry.id,
        name: entry.name,
        weekdays: entry.weekdays,
        startHour: entry.startHour,
        endHour: entry.endHour,
        goodsLimits: entry.goodsLimits,
        applicableUserCount: entry.applicableUserIds.length,
        status: entry.status
      })),
      serviceOverview: {
        completeUsers: dashboard.serviceOverview.completeUsers.users.slice(0, 10),
        partialUsers: dashboard.serviceOverview.partialUsers.users.slice(0, 10),
        unservedUsers: dashboard.serviceOverview.unservedUsers.users.slice(0, 10),
        totalUsers: dashboard.serviceOverview.totalUsers
      },
      dataMonitor: {
        rangeSummary: monitor.rangeSummary,
        rangeSeries: monitor.rangeSeries,
        regionBreakdown: monitor.regionBreakdown
      }
    };

    const generated = await this.openAiCompatibleService.completeJson<{
      summary?: unknown;
      underservedSignals?: unknown;
      proposedAdjustments?: unknown;
      cautionNotes?: unknown;
    }>({
      task: "policy-optimization",
      systemPrompt:
        "你是社区公益智助柜系统的策略优化助手。请基于未服务人数、领取完成率、时段分布和当前规则，提出审慎的优化建议。只返回 JSON。",
      userPrompt: [
        `请基于 ${dateKey} 与 ${range} 范围内的数据，给出发放政策优化建议。`,
        "输出字段必须严格为：",
        JSON.stringify(
          {
            summary: "整体结论",
            underservedSignals: ["未服务或服务不足信号 1"],
            proposedAdjustments: ["建议调整 1"],
            cautionNotes: ["调整时需要注意的风险 1"]
          },
          null,
          2
        ),
        "要求：建议应面向管理员，不要直接执行，只提供辅助决策意见。",
        "输入数据：",
        JSON.stringify(context, null, 2)
      ].join("\n"),
      maxTokens: 1500
    });

    const result: AiPolicyOptimizationSuggestion = {
      meta: {
        generatedAt: new Date().toISOString(),
        provider: "openai-compatible",
        model: generated.model
      },
      dateKey,
      range,
      summary: this.readString(
        generated.data.summary,
        "已根据当前服务完成率和时段使用情况生成策略优化建议。"
      ),
      underservedSignals: this.readStringArray(generated.data.underservedSignals, [
        "请重点关注未服务与部分服务用户集中的时段和片区。"
      ]),
      proposedAdjustments: this.readStringArray(generated.data.proposedAdjustments, [
        "建议先小范围试调时段、品类和数量上限，再观察效果。"
      ]),
      cautionNotes: this.readStringArray(generated.data.cautionNotes, [
        "调整前需兼顾公平性、预算约束和物资实际供给能力。"
      ])
    };

    this.store.logOperation({
      category: "admin",
      type: "ai-policy-optimization",
      status: "success",
      actor: this.getAdminActor(),
      metadata: {
        aiTask: "policy-optimization",
        dateKey,
        range,
        undoState: "not_undoable"
      }
    });

    return result;
  }

  private async buildSupportAssistantReply(payload: {
    question: string;
    scene?: string;
    history?: Array<{
      role: "user" | "assistant";
      content: string;
    }>;
    role: "admin" | "merchant" | "special";
    actorUserId?: string;
  }): Promise<AiSupportAssistantReply> {
    const guideContext = this.getSupportGuideContext(payload.role, payload.scene);
    const history = (payload.history ?? [])
      .slice(-6)
      .map((entry, index) => `${index + 1}. ${entry.role === "assistant" ? "助手" : "用户"}：${entry.content}`);

    const generated = await this.openAiCompatibleService.completeJson<{
      answer?: unknown;
      suggestedSteps?: unknown;
      followUpQuestions?: unknown;
      escalationTip?: unknown;
    }>({
      task: "support-assistant",
      systemPrompt:
        "你是社区公益智助柜 APP 的问题排查助手。请优先基于提供的流程指引和角色职责回答，给出清楚、克制、可执行的中文建议。不要承诺已经完成任何操作，不要编造系统没有给出的能力。只返回 JSON。",
      userPrompt: [
        `当前提问角色：${this.getRoleLabel(payload.role)}`,
        payload.scene ? `当前场景：${payload.scene}` : "当前场景：未指定",
        "可参考的业务指引：",
        JSON.stringify(guideContext, null, 2),
        history.length ? `最近对话：\n${history.join("\n")}` : "最近对话：无",
        "请严格输出以下 JSON 结构：",
        JSON.stringify(
          {
            answer: "先给用户一个简明结论，再说明下一步怎么做",
            suggestedSteps: ["步骤 1", "步骤 2"],
            followUpQuestions: ["如果还需要继续追问，可以建议用户继续问什么"],
            escalationTip: "什么时候应改走反馈、电话或人工处理"
          },
          null,
          2
        ),
        `用户问题：${payload.question}`
      ].join("\n"),
      maxTokens: 1400
    });

    const result: AiSupportAssistantReply = {
      meta: {
        generatedAt: new Date().toISOString(),
        provider: "openai-compatible",
        model: generated.model
      },
      role: payload.role,
      scene: payload.scene,
      answer: this.readString(
        generated.data.answer,
        "我已经整理出处理方向。建议先按页面提示核对信息，再决定是否提交反馈或联系管理员。"
      ),
      suggestedSteps: this.readStringArray(generated.data.suggestedSteps, [
        "先核对当前页面显示的账号、柜机和时间信息。",
        "按照页面流程重新操作一次，确认是否仍然出现同样的问题。",
        "如果仍未解决，请在设置里的“遇到问题”或反馈入口提交情况。"
      ]),
      followUpQuestions: this.readStringArray(generated.data.followUpQuestions, [
        "如果方便，可以继续告诉我当前停留在哪个页面、看到了什么提示。"
      ]),
      escalationTip: this.readString(
        generated.data.escalationTip,
        "涉及柜门异常、连续验证码失败、审批结果不符或库存数据明显异常时，应及时转人工处理。"
      )
    };

    this.store.logOperation({
      category: payload.role === "admin" ? "admin" : "user",
      type: "ai-support-assistant",
      status: "success",
      actor: this.getActorByRole(payload.role, payload.actorUserId),
      detail: `AI 辅助回答了${this.getRoleLabel(payload.role)}的问题：${payload.question}`,
      description: `AI 助手完成了${this.getRoleLabel(payload.role)}问题排查建议。`,
      metadata: {
        aiTask: "support-assistant",
        role: payload.role,
        scene: payload.scene,
        undoState: "not_undoable"
      }
    });

    return result;
  }

  private resolveEventPayload(payload: { eventId?: string; orderNo?: string; logId?: string }) {
    let relatedLog: OperationLogRecord | undefined;
    let event: CabinetEventRecord | undefined;

    if (payload.logId) {
      relatedLog = this.operationLogsService.detail(payload.logId);
      const relatedEventId = relatedLog.relatedEventId;
      const relatedOrderNo = relatedLog.relatedOrderNo;

      if (relatedEventId) {
        event = this.store.events.find((entry) => entry.eventId === relatedEventId);
      }

      if (!event && relatedOrderNo) {
        event = this.findEventByOrderNo(relatedOrderNo);
      }
    }

    if (!event && payload.eventId) {
      event = this.store.events.find((entry) => entry.eventId === payload.eventId);
    }

    if (!event && payload.orderNo) {
      event = this.findEventByOrderNo(payload.orderNo);
    }

    if (!event) {
      throw new NotFoundException("未找到对应开柜事件，无法生成异常诊断。");
    }

    return {
      event,
      relatedLog
    };
  }

  private findEventByOrderNo(orderNo: string) {
    return this.store.events.find(
      (entry) =>
        entry.orderNo === orderNo ||
        entry.adjustmentOrderNo === orderNo ||
        entry.adjustments?.some((adjustment) => adjustment.orderNo === orderNo)
    );
  }

  private findRelatedCallbackLogs(tokens: string[]) {
    return this.store.callbackLog
      .filter((entry) => {
        const serialized = this.stringifyForSearch(entry.payload);
        return tokens.some((token) => serialized.includes(token));
      })
      .map((entry) => ({
        type: entry.type,
        receivedAt: entry.receivedAt,
        payload: entry.payload
      }));
  }

  private findRelatedSystemAudits(deviceCode: string, tokens: string[]) {
    return this.operationLogsService
      .listSystemAudit({
        deviceCode,
        limit: 120
      })
      .filter((entry) =>
        tokens.some((token) =>
          [entry.path, entry.query, entry.params, entry.body, entry.response, entry.error, entry.metadata]
            .some((value) => this.stringifyForSearch(value).includes(token))
        )
      )
      .map((entry) => ({
        occurredAt: entry.occurredAt,
        path: entry.path,
        statusCode: entry.statusCode,
        body: entry.body,
        response: entry.response,
        error: entry.error,
        metadata: entry.metadata
      }));
  }

  private buildIdentityTokens(payload: {
    eventId?: string;
    orderNo?: string;
    adjustmentOrderNo?: string;
    deviceCode?: string;
    logId?: string;
  }) {
    return Object.values(payload).filter((value): value is string => Boolean(value));
  }

  private normalizeDateKey(dateKey?: string) {
    if (dateKey && /^\d{4}-\d{2}-\d{2}$/.test(dateKey)) {
      return dateKey;
    }

    return getBusinessDayKey(new Date());
  }

  private normalizeRange(range?: DataMonitorRange) {
    if (range === "3d" || range === "7d") {
      return range;
    }

    return "7d";
  }

  private normalizeReportType(type?: AiOperationsReportType) {
    return type === "morning" ? "morning" : "daily";
  }

  private async withCache<T>(cacheKey: string, factory: () => Promise<T>) {
    const existing = this.cache.get(cacheKey);

    if (existing && existing.expiresAt > Date.now()) {
      return existing.value as T;
    }

    const created = await factory();
    this.cache.set(cacheKey, {
      value: created,
      expiresAt: Date.now() + 10 * 60_000
    });
    return created;
  }

  private getAdminActor() {
    const admin = this.store.users.find((entry) => entry.role === "admin");

    if (admin) {
      return {
        type: "admin" as const,
        id: admin.id,
        name: admin.name,
        role: admin.role
      };
    }

    return {
      type: "system" as const,
      name: "系统"
    };
  }

  private getActorByRole(role: "admin" | "merchant" | "special", actorUserId?: string) {
    const user =
      (actorUserId ? this.store.users.find((entry) => entry.id === actorUserId) : undefined) ??
      this.store.users.find((entry) => entry.role === role);

    if (user) {
      return {
        type: user.role,
        id: user.id,
        name: user.name,
        role: user.role
      } as const;
    }

    return {
      type: "system" as const,
      name: "系统"
    };
  }

  private getRoleLabel(role: "admin" | "merchant" | "special") {
    if (role === "admin") {
      return "管理员";
    }

    if (role === "merchant") {
      return "商户";
    }

    return "普通用户";
  }

  private getSupportGuideContext(role: "admin" | "merchant" | "special", scene?: string) {
    const common = [
      {
        topic: "反馈与人工协助",
        keyPoints: [
          "遇到柜门打不开、识别异常、数据明显不一致时，优先记录页面提示，再走反馈入口。",
          "描述问题时尽量带上柜机名称、时间、页面提示和已尝试过的操作。"
        ]
      }
    ];

    const roleSpecific =
      role === "admin"
        ? [
            {
              topic: "待办事件处理",
              keyPoints: [
                "先看事件分类和数量，再按临期、用户反馈、系统提示的优先级安排处理。",
                "处理前先点详情核对柜机、商品、用户和时间信息，再决定是标记完成还是继续跟进。"
              ]
            },
            {
              topic: "柜机巡检",
              keyPoints: [
                "柜机列表卡片重点看在线状态、待处理数量和今日领取情况。",
                "待处理数量不为 0 时应优先进入详情页排查。"
              ]
            },
            {
              topic: "人员审批与日志",
              keyPoints: [
                "审批前先核对姓名、手机号和申请身份，必要时补充驳回原因。",
                "人员日志页可以继续查看人员资料、审批申请和操作日志。"
              ]
            }
          ]
        : role === "merchant"
          ? [
              {
                topic: "商品属性与补货",
                keyPoints: [
                  "先维护商品属性，再登记补货，避免后续流向统计不清楚。",
                  "补货时要核对柜机、数量和生产日期。"
                ]
              },
              {
                topic: "货物流向",
                keyPoints: [
                  "记录页会展示货物被领取情况和累计帮助数据。",
                  "发现异常去向时，先核对最近补货记录和柜机状态。"
                ]
              }
            ]
          : [
              {
                topic: "登录与验证码",
                keyPoints: [
                  "验证码发送后有 60 秒冷却，期间无需重复点击。",
                  "手机号和验证码都需要使用当前本人正在操作的号码。"
                ]
              },
              {
                topic: "验证领取",
                keyPoints: [
                  "先确认当天资格和开放时段，再去附近柜机或扫码开门。",
                  "如遇识别不一致或领取异常，应先查看提醒，再决定是否反馈。"
                ]
              },
              {
                topic: "附近柜机",
                keyPoints: [
                  "附近柜机会优先展示地图，操作按钮集中在地图下方。",
                  "如果定位不准，可先刷新位置或改为扫码进入。"
                ]
              }
            ];

    return {
      role,
      roleLabel: this.getRoleLabel(role),
      scene,
      guides: [...roleSpecific, ...common]
    };
  }

  private toLogSummary(entry: OperationLogRecord) {
    return {
      id: entry.id,
      occurredAt: entry.occurredAt,
      category: entry.category,
      type: entry.type,
      status: entry.status,
      description: entry.description,
      detail: entry.detail,
      actor: entry.actor.name,
      relatedEventId: entry.relatedEventId,
      relatedOrderNo: entry.relatedOrderNo,
      metadata: entry.metadata
    };
  }

  private toAlertSummary(entry: AlertTask) {
    return {
      id: entry.id,
      type: entry.type,
      grade: entry.grade,
      title: entry.title,
      status: entry.status,
      dueAt: entry.dueAt,
      detail: entry.detail,
      previewDetail: entry.previewDetail,
      deviceCode: entry.deviceCode,
      targetUserId: entry.targetUserId,
      relatedEventId: entry.relatedEventId
    };
  }

  private readString(value: unknown, fallback: string) {
    return typeof value === "string" && value.trim() ? value.trim() : fallback;
  }

  private readBoolean(value: unknown) {
    return value === true;
  }

  private readStringArray(value: unknown, fallback: string[]) {
    if (!Array.isArray(value)) {
      return fallback;
    }

    const normalized = value
      .map((entry) => (typeof entry === "string" ? entry.trim() : ""))
      .filter(Boolean);

    return normalized.length ? normalized : fallback;
  }

  private readConfidence(value: unknown): AiInsightConfidence {
    return value === "high" || value === "low" ? value : "medium";
  }

  private readUrgency(value: unknown): AiInsightUrgency {
    return value === "high" || value === "low" ? value : "medium";
  }

  private readDeviceRecommendations(value: unknown): AiDeviceRestockRecommendation[] {
    if (!Array.isArray(value)) {
      return [];
    }

    const normalized = value
      .map((entry) => {
        if (!entry || typeof entry !== "object") {
          return undefined;
        }

        const typed = entry as Record<string, unknown>;
        const deviceCode = this.readString(typed.deviceCode, "");
        const deviceName = this.readString(typed.deviceName, deviceCode);
        const goodsName = this.readString(typed.goodsName, "");
        const reason = this.readString(typed.reason, "");

        if (!deviceCode || !goodsName || !reason) {
          return undefined;
        }

        const recommendation: AiDeviceRestockRecommendation = {
          deviceCode,
          deviceName,
          goodsId: this.readString(typed.goodsId, "") || undefined,
          goodsName,
          suggestedQuantity:
            typeof typed.suggestedQuantity === "number" && typed.suggestedQuantity > 0
              ? Math.round(typed.suggestedQuantity)
              : undefined,
          reason
        };

        return recommendation;
      })
      .filter(Boolean);

    return normalized.slice(0, 12) as AiDeviceRestockRecommendation[];
  }

  private readRegionRecommendations(value: unknown) {
    if (!Array.isArray(value)) {
      return [];
    }

    return value
      .map((entry) => {
        if (!entry || typeof entry !== "object") {
          return undefined;
        }

        const typed = entry as Record<string, unknown>;
        const regionName = this.readString(typed.regionName, "");
        const suggestion = this.readString(typed.suggestion, "");
        const reason = this.readString(typed.reason, "");

        if (!regionName || !suggestion || !reason) {
          return undefined;
        }

        return {
          regionId: this.readString(typed.regionId, "") || undefined,
          regionName,
          suggestion,
          reason
        };
      })
      .filter(Boolean)
      .slice(0, 10) as AiRestockLayoutSuggestion["regionRecommendations"];
  }

  private stringifyForSearch(value: unknown) {
    if (value === undefined || value === null) {
      return "";
    }

    if (typeof value === "string") {
      return value;
    }

    try {
      return JSON.stringify(value);
    } catch {
      return "";
    }
  }
}
