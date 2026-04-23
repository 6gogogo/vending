<script setup lang="ts">
import { computed, onMounted, ref, watch } from "vue";
import { RouterLink, useRoute, useRouter } from "vue-router";
import type {
  AiEventDiagnosis,
  AiFeedbackDraft,
  AiOperationsReport,
  AiOperationsReportType,
  AiPolicyOptimizationSuggestion,
  AiProviderStatus,
  AiProviderTestResult,
  AiRestockLayoutSuggestion,
  AlertTask,
  DataMonitorRange
} from "@vm/shared-types";

import { adminApi } from "../api/admin";
import { formatDateTime, getTodayDateKeyInBeijing } from "../utils/datetime";

type WorkspaceTab = "report" | "diagnosis" | "restock" | "feedback" | "policy";
type WorkspaceResultPayload =
  | AiEventDiagnosis
  | AiOperationsReport
  | AiRestockLayoutSuggestion
  | AiFeedbackDraft
  | AiPolicyOptimizationSuggestion;

interface AiWorkspaceHistoryEntry {
  id: string;
  tab: WorkspaceTab;
  title: string;
  summary: string;
  generatedAt: string;
  payload: WorkspaceResultPayload;
}

interface AiWorkspaceStorage {
  lastResults: Partial<Record<WorkspaceTab, AiWorkspaceHistoryEntry>>;
  history: AiWorkspaceHistoryEntry[];
}

interface WorkspaceTabOption {
  key: WorkspaceTab;
  label: string;
  hint: string;
  icon: string;
}

interface StatusCard {
  key: string;
  label: string;
  value: string;
  hint: string;
  icon: string;
  stateClass?: string;
}

const todayDateKey = getTodayDateKeyInBeijing();
const aiWorkspaceStorageKey = "vm-admin-ai-workspace";
const maxHistoryEntries = 12;
const route = useRoute();
const router = useRouter();

const tabOptions: WorkspaceTabOption[] = [
  {
    key: "report",
    label: "运维日报",
    hint: "汇总待办、缺货、临期和反馈。",
    icon: "M4 6.75A2.75 2.75 0 0 1 6.75 4h10.5A2.75 2.75 0 0 1 20 6.75v10.5A2.75 2.75 0 0 1 17.25 20H6.75A2.75 2.75 0 0 1 4 17.25zm4.5 2.25a.75.75 0 0 0 0 1.5h7.5a.75.75 0 0 0 0-1.5zm0 4a.75.75 0 0 0 0 1.5h7.5a.75.75 0 0 0 0-1.5zm0 4a.75.75 0 0 0 0 1.5h4.5a.75.75 0 0 0 0-1.5z"
  },
  {
    key: "diagnosis",
    label: "异常诊断",
    hint: "分析单次开柜事件的门状态和回调链路。",
    icon: "M10.5 3.75a6.75 6.75 0 1 0 4.244 12l3.253 3.253a.75.75 0 1 0 1.06-1.06l-3.252-3.254A6.75 6.75 0 0 0 10.5 3.75m0 1.5a5.25 5.25 0 1 1 0 10.5a5.25 5.25 0 0 1 0-10.5m-.75 2.5a.75.75 0 0 0 0 1.5h.75v2.75c0 .414.336.75.75.75h2a.75.75 0 0 0 0-1.5H12V9a.75.75 0 0 0-.75-.75z"
  },
  {
    key: "restock",
    label: "补货布局",
    hint: "结合区域和时段热度给出建议。",
    icon: "M5.75 5A2.75 2.75 0 0 0 3 7.75v8.5A2.75 2.75 0 0 0 5.75 19h12.5A2.75 2.75 0 0 0 21 16.25v-8.5A2.75 2.75 0 0 0 18.25 5zm0 1.5h12.5c.69 0 1.25.56 1.25 1.25v1.5H4.5v-1.5c0-.69.56-1.25 1.25-1.25m-1.25 4.25h15v5.5c0 .69-.56 1.25-1.25 1.25H5.75c-.69 0-1.25-.56-1.25-1.25zm2.75 1.5a.75.75 0 0 0 0 1.5h3.5a.75.75 0 0 0 0-1.5z"
  },
  {
    key: "feedback",
    label: "反馈分流",
    hint: "分类反馈并生成回复草稿。",
    icon: "M4.75 5A2.75 2.75 0 0 0 2 7.75v6.5A2.75 2.75 0 0 0 4.75 17H7.8l2.52 2.1a1 1 0 0 0 1.28 0L14.12 17h5.13A2.75 2.75 0 0 0 22 14.25v-6.5A2.75 2.75 0 0 0 19.25 5zm2.5 4.25a.75.75 0 0 0 0 1.5h9.5a.75.75 0 0 0 0-1.5zm0 3a.75.75 0 0 0 0 1.5h6a.75.75 0 0 0 0-1.5z"
  },
  {
    key: "policy",
    label: "策略优化",
    hint: "根据完成率和未服务人数调整策略。",
    icon: "M5 18.25V8.75A2.75 2.75 0 0 1 7.75 6h8.5A2.75 2.75 0 0 1 19 8.75v9.5a.75.75 0 0 1-1.28.53l-1.97-1.97-1.97 1.97a.75.75 0 0 1-1.06 0l-1.97-1.97-1.97 1.97A.75.75 0 0 1 7.72 18L5.75 16.03 3.78 18A.75.75 0 0 1 2.5 17.47v-8.72A2.75 2.75 0 0 1 5.25 6H7v1.5H5.25c-.69 0-1.25.56-1.25 1.25v6.91l1.22-1.22a.75.75 0 0 1 1.06 0L8.25 16.4l1.97-1.97a.75.75 0 0 1 1.06 0l1.97 1.97 1.97-1.97a.75.75 0 0 1 1.06 0L17.5 15.66V8.75c0-.69-.56-1.25-1.25-1.25h-5.5V6h5.5A2.75 2.75 0 0 1 19 8.75v9.5a.75.75 0 0 1-1.28.53l-1.97-1.97-1.97 1.97a.75.75 0 0 1-1.06 0l-1.97-1.97-1.97 1.97A.75.75 0 0 1 7.72 18L5.75 16.03 3.78 18A.75.75 0 0 1 2.5 17.47z"
  }
];

const reportTypeOptions: Array<{ value: AiOperationsReportType; label: string; hint: string }> = [
  { value: "morning", label: "晨报", hint: "适合开班前巡检和排班确认。" },
  { value: "daily", label: "日报", hint: "适合复盘当天问题和闭环情况。" }
];

const rangeOptions: Array<{ value: DataMonitorRange; label: string }> = [
  { value: "today", label: "今天" },
  { value: "3d", label: "近三天" },
  { value: "7d", label: "近七天" }
];

const aiStatus = ref<AiProviderStatus>();
const statusLoading = ref(false);
const statusError = ref("");
const configDialogOpen = ref(false);
const configSaving = ref(false);
const configError = ref("");
const configForm = ref({
  apiKey: "",
  baseUrl: "https://api.openai.com/v1",
  model: "gpt-4.1-mini"
});
const testResult = ref<AiProviderTestResult>();
const testLoading = ref(false);
const testError = ref("");

const alerts = ref<AlertTask[]>([]);
const alertsLoading = ref(false);
const alertsError = ref("");

const activeTab = ref<WorkspaceTab>("report");

const diagnosisForm = ref({
  eventId: "",
  orderNo: "",
  logId: ""
});
const reportDateKey = ref(todayDateKey);
const reportType = ref<AiOperationsReportType>("morning");
const restockDateKey = ref(todayDateKey);
const restockRange = ref<DataMonitorRange>("7d");
const feedbackAlertId = ref("");
const policyDateKey = ref(todayDateKey);
const policyRange = ref<DataMonitorRange>("7d");

const diagnosisResult = ref<AiEventDiagnosis>();
const diagnosisLoading = ref(false);
const diagnosisError = ref("");

const operationsReportResult = ref<AiOperationsReport>();
const operationsReportLoading = ref(false);
const operationsReportError = ref("");

const restockResult = ref<AiRestockLayoutSuggestion>();
const restockLoading = ref(false);
const restockError = ref("");

const feedbackResult = ref<AiFeedbackDraft>();
const feedbackLoading = ref(false);
const feedbackError = ref("");

const policyResult = ref<AiPolicyOptimizationSuggestion>();
const policyLoading = ref(false);
const policyError = ref("");
const historyEntries = ref<AiWorkspaceHistoryEntry[]>([]);

const activeTabMeta = computed(() => tabOptions.find((item) => item.key === activeTab.value) ?? tabOptions[0]);
const isAiEnabled = computed(() => aiStatus.value?.enabled ?? false);
const missingConfig = computed(() => aiStatus.value?.missingConfig ?? []);
const recentHistoryEntries = computed(() => historyEntries.value.slice(0, 8));
const feedbackAlerts = computed(() =>
  alerts.value.filter((alert) => alert.grade === "feedback" || alert.type === "user_feedback")
);
const selectedFeedbackAlert = computed(() =>
  feedbackAlerts.value.find((alert) => alert.id === feedbackAlertId.value)
);
const statusCards = computed<StatusCard[]>(() => [
  {
    key: "provider",
    label: "接入方式",
    value: "OpenAI 兼容",
    hint: "后端统一处理鉴权、转发和审计。",
    icon: "M4 7.25A3.25 3.25 0 0 1 7.25 4h9.5A3.25 3.25 0 0 1 20 7.25v9.5A3.25 3.25 0 0 1 16.75 20h-9.5A3.25 3.25 0 0 1 4 16.75zm3.25-1.75c-.966 0-1.75.784-1.75 1.75v9.5c0 .966.784 1.75 1.75 1.75h9.5c.966 0 1.75-.784 1.75-1.75v-9.5c0-.966-.784-1.75-1.75-1.75zm1.5 3a.75.75 0 0 0-.75.75v1.5c0 .414.336.75.75.75h1.5v1.5a.75.75 0 0 0 1.5 0V11.5h1.5a.75.75 0 0 0 0-1.5h-1.5V8.5a.75.75 0 0 0-1.5 0V10h-1.5a.75.75 0 0 0-.75.75",
    stateClass: "ai-page__status-card--info"
  },
  {
    key: "status",
    label: "配置状态",
    value: isAiEnabled.value ? "已可调用" : "待补配置",
    hint: missingConfig.value.length ? `待补 ${missingConfig.value.join("、")}` : "API Key 已就绪，可直接发起生成。",
    icon: "M12 3.5a8.5 8.5 0 1 0 8.5 8.5A8.51 8.51 0 0 0 12 3.5m3.03 6.28a.75.75 0 1 1 1.06 1.06l-4.5 4.5a.75.75 0 0 1-1.06 0l-1.97-1.97a.75.75 0 1 1 1.06-1.06l1.44 1.44z",
    stateClass: isAiEnabled.value ? "ai-page__status-card--success" : "ai-page__status-card--warning"
  },
  {
    key: "strategy",
    label: "模型策略",
    value: aiStatus.value?.usingDefaultModel === false ? "自定义模型" : "默认模型",
    hint: aiStatus.value?.usingDefaultBaseUrl === false ? "当前已切换到自定义网关。" : "当前使用默认地址。",
    icon: "M6.75 4h10.5A2.75 2.75 0 0 1 20 6.75v10.5A2.75 2.75 0 0 1 17.25 20H6.75A2.75 2.75 0 0 1 4 17.25V6.75A2.75 2.75 0 0 1 6.75 4m0 1.5c-.69 0-1.25.56-1.25 1.25v10.5c0 .69.56 1.25 1.25 1.25h10.5c.69 0 1.25-.56 1.25-1.25V6.75c0-.69-.56-1.25-1.25-1.25zm1.5 2.75a.75.75 0 0 0 0 1.5h7.5a.75.75 0 0 0 0-1.5zm0 3.5a.75.75 0 0 0 0 1.5h4.5a.75.75 0 0 0 0-1.5z",
    stateClass: "ai-page__status-card--neutral"
  },
  {
    key: "test",
    label: "连通测试",
    value: testResult.value ? "最近通过" : "未测试",
    hint: testResult.value
      ? `${formatDateTime(testResult.value.testedAt)} · ${testResult.value.latencyMs} ms`
      : "保存配置后建议先做一次联通测试。",
    icon: "M12 4.5a7.5 7.5 0 0 0-5.88 12.16a.75.75 0 0 0 1.17-.94A6 6 0 1 1 18 12c0 .66-.11 1.3-.31 1.9a.75.75 0 1 0 1.41.52c.25-.79.4-1.61.4-2.42A7.5 7.5 0 0 0 12 4.5m0 3a.75.75 0 0 0-.75.75v3.44l-1.72 1.72a.75.75 0 1 0 1.06 1.06l1.94-1.94a.75.75 0 0 0 .22-.53V8.25A.75.75 0 0 0 12 7.5",
    stateClass: testResult.value ? "ai-page__status-card--success" : "ai-page__status-card--neutral"
  }
]);

const assistantTips = computed(() => {
  if (activeTab.value === "diagnosis") {
    return [
      "优先填事件编号，其次用订单号或日志编号辅助定位。",
      "结果会同时综合门状态、平台回调、补扣和退款链路。",
      "建议在现场巡检前先核对最近一次设备日志和门磁状态。"
    ];
  }

  if (activeTab.value === "report") {
    return [
      "晨报更适合开班前巡检，日报更适合复盘当天问题闭环。",
      "摘要会把缺货、临期、反馈和高优任务合并成一句话结论。",
      "建议每天固定时间生成，便于形成连续运维台账。"
    ];
  }

  if (activeTab.value === "restock") {
    return [
      "建议先看单柜补货，再看区域扩点，避免重复投放。",
      "近三天适合应急判断，近七天更适合做稳定布局决策。",
      "建议结合仓库库存和爱心商户供给能力一起判断。"
    ];
  }

  if (activeTab.value === "feedback") {
    return [
      "优先处理仍处于待办状态的反馈任务。",
      "分流建议适合直接派发给街道管理员或设备维护人员。",
      "回复草稿生成后仍建议人工确认措辞和承诺时限。"
    ];
  }

  return [
    "策略建议基于未服务人数、完成率和时段使用情况综合判断。",
    "调整时段时建议小步迭代，不要一次性大改全部策略。",
    "对品类上限的修改应同时观察缺货率和浪费率变化。"
  ];
});

const firstQueryValue = (value: unknown) => {
  if (Array.isArray(value)) {
    return typeof value[0] === "string" ? value[0] : "";
  }

  return typeof value === "string" ? value : "";
};

const readTab = (value: string): WorkspaceTab =>
  tabOptions.some((item) => item.key === value) ? (value as WorkspaceTab) : "report";

const readErrorMessage = (error: unknown) =>
  error instanceof Error ? error.message : "AI 请求失败，请稍后重试。";

const ensureAiEnabled = () => {
  if (!isAiEnabled.value) {
    throw new Error(
      missingConfig.value.length
        ? `请先配置 ${missingConfig.value.join("、")}。`
        : "AI 服务当前不可用。"
    );
  }
};

const confidenceLabel = (value?: AiEventDiagnosis["confidence"]) =>
  value === "high" ? "高" : value === "medium" ? "中" : "低";

const urgencyLabel = (value?: AiFeedbackDraft["urgency"]) =>
  value === "high" ? "高" : value === "medium" ? "中" : "低";

const pillClass = (value?: "high" | "medium" | "low") => {
  if (value === "high") {
    return "admin-pill--danger";
  }

  if (value === "medium") {
    return "admin-pill--warning";
  }

  return "admin-pill--neutral";
};

const createEmptyWorkspaceStorage = (): AiWorkspaceStorage => ({
  lastResults: {},
  history: []
});

const canUseWorkspaceStorage = () =>
  typeof window !== "undefined" && typeof window.localStorage !== "undefined";

const readWorkspaceStorage = (): AiWorkspaceStorage => {
  if (!canUseWorkspaceStorage()) {
    return createEmptyWorkspaceStorage();
  }

  try {
    const rawValue = window.localStorage.getItem(aiWorkspaceStorageKey);
    if (!rawValue) {
      return createEmptyWorkspaceStorage();
    }

    const parsed = JSON.parse(rawValue) as Partial<AiWorkspaceStorage>;
    return {
      lastResults:
        parsed.lastResults && typeof parsed.lastResults === "object"
          ? (parsed.lastResults as AiWorkspaceStorage["lastResults"])
          : {},
      history: Array.isArray(parsed.history)
        ? (parsed.history as AiWorkspaceHistoryEntry[]).slice(0, maxHistoryEntries)
        : []
    };
  } catch {
    return createEmptyWorkspaceStorage();
  }
};

const writeWorkspaceStorage = (storage: AiWorkspaceStorage) => {
  if (!canUseWorkspaceStorage()) {
    return;
  }

  window.localStorage.setItem(aiWorkspaceStorageKey, JSON.stringify(storage));
};

const applyHistoryPayload = (entry: AiWorkspaceHistoryEntry) => {
  switch (entry.tab) {
    case "diagnosis":
      diagnosisResult.value = entry.payload as AiEventDiagnosis;
      break;
    case "report":
      operationsReportResult.value = entry.payload as AiOperationsReport;
      break;
    case "restock":
      restockResult.value = entry.payload as AiRestockLayoutSuggestion;
      break;
    case "feedback":
      feedbackResult.value = entry.payload as AiFeedbackDraft;
      break;
    case "policy":
      policyResult.value = entry.payload as AiPolicyOptimizationSuggestion;
      break;
  }
};

const restoreSavedResults = () => {
  const storage = readWorkspaceStorage();
  historyEntries.value = storage.history;

  if (storage.lastResults.diagnosis) {
    diagnosisResult.value = storage.lastResults.diagnosis.payload as AiEventDiagnosis;
  }

  if (storage.lastResults.report) {
    operationsReportResult.value = storage.lastResults.report.payload as AiOperationsReport;
  }

  if (storage.lastResults.restock) {
    restockResult.value = storage.lastResults.restock.payload as AiRestockLayoutSuggestion;
  }

  if (storage.lastResults.feedback) {
    feedbackResult.value = storage.lastResults.feedback.payload as AiFeedbackDraft;
  }

  if (storage.lastResults.policy) {
    policyResult.value = storage.lastResults.policy.payload as AiPolicyOptimizationSuggestion;
  }
};

const recordHistoryEntry = (
  entry: Omit<AiWorkspaceHistoryEntry, "id">
) => {
  const savedEntry: AiWorkspaceHistoryEntry = {
    ...entry,
    id: `${entry.tab}-${entry.generatedAt}-${Date.now().toString(36)}`
  };
  const storage = readWorkspaceStorage();
  const nextStorage: AiWorkspaceStorage = {
    lastResults: {
      ...storage.lastResults,
      [savedEntry.tab]: savedEntry
    },
    history: [
      savedEntry,
      ...storage.history.filter(
        (item) =>
          !(
            item.tab === savedEntry.tab &&
            item.generatedAt === savedEntry.generatedAt &&
            item.title === savedEntry.title
          )
      )
    ].slice(0, maxHistoryEntries)
  };

  historyEntries.value = nextStorage.history;
  writeWorkspaceStorage(nextStorage);
};

const workspaceTabLabel = (tab: WorkspaceTab) =>
  tabOptions.find((item) => item.key === tab)?.label ?? "AI 内容";

const openHistoryEntry = async (entry: AiWorkspaceHistoryEntry) => {
  applyHistoryPayload(entry);
  activeTab.value = entry.tab;
  await setTab(entry.tab);
};

const clearSavedHistory = () => {
  historyEntries.value = [];
  writeWorkspaceStorage(createEmptyWorkspaceStorage());
};

const syncRouteQuery = () => {
  activeTab.value = readTab(firstQueryValue(route.query.tab));

  const eventId = firstQueryValue(route.query.eventId);
  const orderNo = firstQueryValue(route.query.orderNo);
  const logId = firstQueryValue(route.query.logId);
  const alertId = firstQueryValue(route.query.alertId);

  if (eventId) {
    diagnosisForm.value.eventId = eventId;
  }

  if (orderNo) {
    diagnosisForm.value.orderNo = orderNo;
  }

  if (logId) {
    diagnosisForm.value.logId = logId;
  }

  if (alertId) {
    feedbackAlertId.value = alertId;
  }
};

watch(
  () => [route.query.tab, route.query.eventId, route.query.orderNo, route.query.logId, route.query.alertId],
  syncRouteQuery,
  { immediate: true }
);

const setTab = async (tab: WorkspaceTab) => {
  await router.replace({
    path: "/ai",
    query: {
      ...route.query,
      tab
    }
  });
};

const loadStatus = async () => {
  statusLoading.value = true;
  statusError.value = "";
  try {
    aiStatus.value = await adminApi.aiStatus();
  } catch (error) {
    statusError.value = readErrorMessage(error);
  } finally {
    statusLoading.value = false;
  }
};

const resetConfigForm = () => {
  configForm.value = {
    apiKey: "",
    baseUrl: aiStatus.value?.baseUrl ?? "https://api.openai.com/v1",
    model: aiStatus.value?.model ?? "gpt-4.1-mini"
  };
  configError.value = "";
};

const openConfigDialog = () => {
  resetConfigForm();
  configDialogOpen.value = true;
};

const closeConfigDialog = () => {
  configDialogOpen.value = false;
  configError.value = "";
};

const saveConfig = async () => {
  configError.value = "";
  testError.value = "";

  if (!configForm.value.baseUrl.trim()) {
    configError.value = "请输入 Base URL。";
    return;
  }

  if (!configForm.value.model.trim()) {
    configError.value = "请输入模型名称。";
    return;
  }

  if (!aiStatus.value?.apiKeyConfigured && !configForm.value.apiKey.trim()) {
    configError.value = "首次启用时需要填写 API Key。";
    return;
  }

  try {
    configSaving.value = true;
    aiStatus.value = await adminApi.saveAiConfig({
      baseUrl: configForm.value.baseUrl.trim(),
      model: configForm.value.model.trim(),
      ...(configForm.value.apiKey.trim() ? { apiKey: configForm.value.apiKey.trim() } : {})
    });
    testResult.value = undefined;
    closeConfigDialog();
  } catch (error) {
    configError.value = readErrorMessage(error);
  } finally {
    configSaving.value = false;
  }
};

const testProvider = async () => {
  testError.value = "";

  if (!isAiEnabled.value) {
    testError.value = "请先在模型配置中填写可用的 API Key，再执行连通测试。";
    openConfigDialog();
    return;
  }

  try {
    testLoading.value = true;
    testResult.value = await adminApi.testAiConfig();
  } catch (error) {
    testError.value = readErrorMessage(error);
  } finally {
    testLoading.value = false;
  }
};

const loadAlerts = async () => {
  alertsLoading.value = true;
  alertsError.value = "";
  try {
    alerts.value = await adminApi.alerts();
  } catch (error) {
    alertsError.value = readErrorMessage(error);
  } finally {
    alertsLoading.value = false;
  }
};

const loadBootstrap = async () => {
  await Promise.all([loadStatus(), loadAlerts()]);
};

const runDiagnosis = async () => {
  diagnosisError.value = "";
  diagnosisResult.value = undefined;

  if (
    !diagnosisForm.value.eventId.trim() &&
    !diagnosisForm.value.orderNo.trim() &&
    !diagnosisForm.value.logId.trim()
  ) {
    diagnosisError.value = "请至少填写事件编号、订单号或日志编号中的一项。";
    return;
  }

  try {
    ensureAiEnabled();
    diagnosisLoading.value = true;
    const result = await adminApi.aiEventDiagnosis({
      eventId: diagnosisForm.value.eventId.trim() || undefined,
      orderNo: diagnosisForm.value.orderNo.trim() || undefined,
      logId: diagnosisForm.value.logId.trim() || undefined
    });
    diagnosisResult.value = result;
    recordHistoryEntry({
      tab: "diagnosis",
      title: `异常诊断 · ${result.target.orderNo || result.target.eventId || result.target.deviceCode}`,
      summary: result.summary,
      generatedAt: result.meta.generatedAt,
      payload: result
    });
  } catch (error) {
    diagnosisError.value = readErrorMessage(error);
  } finally {
    diagnosisLoading.value = false;
  }
};

const runOperationsReport = async () => {
  operationsReportError.value = "";
  operationsReportResult.value = undefined;

  try {
    ensureAiEnabled();
    operationsReportLoading.value = true;
    const result = await adminApi.aiOperationsReport({
      dateKey: reportDateKey.value,
      reportType: reportType.value
    });
    operationsReportResult.value = result;
    recordHistoryEntry({
      tab: "report",
      title: `${result.reportType === "morning" ? "晨报" : "日报"} · ${result.dateKey}`,
      summary: result.summary,
      generatedAt: result.meta.generatedAt,
      payload: result
    });
  } catch (error) {
    operationsReportError.value = readErrorMessage(error);
  } finally {
    operationsReportLoading.value = false;
  }
};

const runRestockSuggestions = async () => {
  restockError.value = "";
  restockResult.value = undefined;

  try {
    ensureAiEnabled();
    restockLoading.value = true;
    const result = await adminApi.aiRestockLayoutSuggestions({
      dateKey: restockDateKey.value,
      range: restockRange.value
    });
    restockResult.value = result;
    recordHistoryEntry({
      tab: "restock",
      title: `补货布局 · ${restockDateKey.value}`,
      summary: result.summary,
      generatedAt: result.meta.generatedAt,
      payload: result
    });
  } catch (error) {
    restockError.value = readErrorMessage(error);
  } finally {
    restockLoading.value = false;
  }
};

const runFeedbackDraft = async () => {
  feedbackError.value = "";
  feedbackResult.value = undefined;

  if (!feedbackAlertId.value) {
    feedbackError.value = "请先选择一条反馈任务。";
    return;
  }

  try {
    ensureAiEnabled();
    feedbackLoading.value = true;
    const result = await adminApi.aiFeedbackDraft({
      alertId: feedbackAlertId.value
    });
    feedbackResult.value = result;
    recordHistoryEntry({
      tab: "feedback",
      title: `反馈分流 · ${result.title}`,
      summary: result.summary,
      generatedAt: result.meta.generatedAt,
      payload: result
    });
  } catch (error) {
    feedbackError.value = readErrorMessage(error);
  } finally {
    feedbackLoading.value = false;
  }
};

const runPolicyOptimization = async () => {
  policyError.value = "";
  policyResult.value = undefined;

  try {
    ensureAiEnabled();
    policyLoading.value = true;
    const result = await adminApi.aiPolicyOptimization({
      dateKey: policyDateKey.value,
      range: policyRange.value
    });
    policyResult.value = result;
    recordHistoryEntry({
      tab: "policy",
      title: `策略优化 · ${policyDateKey.value}`,
      summary: result.summary,
      generatedAt: result.meta.generatedAt,
      payload: result
    });
  } catch (error) {
    policyError.value = readErrorMessage(error);
  } finally {
    policyLoading.value = false;
  }
};

onMounted(() => {
  restoreSavedResults();
  void loadBootstrap();
});
</script>

<template>
  <section class="admin-page ai-page">
    <section class="admin-page__section">
      <div class="admin-page__section-head ai-page__section-head">
        <div class="ai-page__section-copy">
          <p class="admin-kicker">模型接入状态</p>
          <h3 class="admin-page__section-title">AI 接入控制台</h3>
          <p class="admin-copy">把状态查看、连通测试和模型配置集中在这一块处理。</p>
        </div>
        <div class="admin-toolbar ai-page__status-actions">
          <span class="admin-pill" :class="isAiEnabled ? 'admin-pill--success' : 'admin-pill--warning'">
            {{ isAiEnabled ? "已启用" : "待配置" }}
          </span>
          <button
            type="button"
            class="admin-button admin-button--ghost ai-page__action-button"
            :disabled="statusLoading"
            @click="loadStatus"
          >
            <span class="ai-page__button-icon" aria-hidden="true">
              <svg viewBox="0 0 24 24">
                <path
                  d="M12 5a7 7 0 0 1 6.93 5.93a.75.75 0 1 1-1.48.24A5.5 5.5 0 1 0 16.07 16H14.5a.75.75 0 0 1 0-1.5H18a.75.75 0 0 1 .75.75v3.5a.75.75 0 0 1-1.5 0v-1.47A7 7 0 1 1 12 5"
                />
              </svg>
            </span>
            <span>{{ statusLoading ? "刷新中" : "刷新状态" }}</span>
          </button>
          <button
            type="button"
            class="admin-button admin-button--ghost ai-page__action-button"
            :disabled="testLoading"
            @click="testProvider"
          >
            <span class="ai-page__button-icon" aria-hidden="true">
              <svg viewBox="0 0 24 24">
                <path
                  d="M9.75 4.5a.75.75 0 0 1 .75-.75h3a.75.75 0 0 1 .75.75V6h2.25a.75.75 0 0 1 .53 1.28l-1.8 1.8 3.1 7.76a2 2 0 0 1-1.86 2.74H7.48a2 2 0 0 1-1.86-2.74l3.1-7.76-1.8-1.8A.75.75 0 0 1 7.45 6H9.75zm-.52 13.5h6.54l-2.61-6.53a.75.75 0 0 1 .16-.82l1.37-1.37H9.3l1.37 1.37a.75.75 0 0 1 .16.82z"
                />
              </svg>
            </span>
            <span>{{ testLoading ? "测试中" : "测试功能" }}</span>
          </button>
          <button type="button" class="admin-button ai-page__action-button" @click="openConfigDialog">
            <span class="ai-page__button-icon" aria-hidden="true">
              <svg viewBox="0 0 24 24">
                <path
                  d="M10.29 3.86a1.75 1.75 0 0 1 3.42 0l.18.86a7.85 7.85 0 0 1 1.7.7l.76-.45a1.75 1.75 0 0 1 2.33.63l.42.74a1.75 1.75 0 0 1-.44 2.26l-.68.57q.08.4.08.83t-.08.83l.68.57a1.75 1.75 0 0 1 .44 2.26l-.42.74a1.75 1.75 0 0 1-2.33.63l-.76-.45a7.9 7.9 0 0 1-1.7.7l-.18.86a1.75 1.75 0 0 1-3.42 0l-.18-.86a7.84 7.84 0 0 1-1.7-.7l-.76.45a1.75 1.75 0 0 1-2.33-.63l-.42-.74a1.75 1.75 0 0 1 .44-2.26l.68-.57A4.3 4.3 0 0 1 5.75 12q0-.43.08-.83l-.68-.57a1.75 1.75 0 0 1-.44-2.26l.42-.74a1.75 1.75 0 0 1 2.33-.63l.76.45c.54-.3 1.11-.53 1.7-.7zm1.71 5.39a2.75 2.75 0 1 0 0 5.5a2.75 2.75 0 0 0 0-5.5"
                />
              </svg>
            </span>
            <span>模型配置</span>
          </button>
        </div>
      </div>

      <div class="admin-grid admin-grid--stats-4 ai-page__status-grid">
        <article
          v-for="card in statusCards"
          :key="card.key"
          class="admin-panel admin-panel-block admin-panel-block--tight ai-page__status-card"
          :class="card.stateClass"
        >
          <span class="ai-page__card-icon" aria-hidden="true">
            <svg viewBox="0 0 24 24">
              <path :d="card.icon" />
            </svg>
          </span>
          <span class="admin-kicker">{{ card.label }}</span>
          <h3 class="admin-page__section-title">{{ card.value }}</h3>
          <p class="admin-copy">{{ card.hint }}</p>
        </article>
      </div>

      <div v-if="statusError" class="admin-note ai-page__note ai-page__note--danger">{{ statusError }}</div>
      <div v-if="testError" class="admin-note ai-page__note ai-page__note--danger">{{ testError }}</div>
      <div v-if="testResult" class="admin-note ai-page__note ai-page__note--success">
        最近一次测试已通过，{{ formatDateTime(testResult.testedAt) }} 完成，耗时 {{ testResult.latencyMs }} ms。
      </div>
      <div v-if="!isAiEnabled" class="admin-note ai-page__note">
        请在“模型配置”里录入 API Key。默认地址和默认模型已经预置，只有切换兼容网关时才需要改动。
      </div>
    </section>

    <section class="admin-page__section">
      <article class="admin-panel admin-panel-block ai-page__tab-shell">
        <div class="admin-panel__head">
          <div>
            <span class="admin-kicker">功能选择</span>
            <h3 class="admin-panel__title">先选当前要生成的 AI 能力</h3>
          </div>
          <span class="admin-copy">当前页签：{{ activeTabMeta.label }}</span>
        </div>

        <div class="ai-page__tabs">
          <button
            v-for="tab in tabOptions"
            :key="tab.key"
            type="button"
            class="ai-page__tab"
            :class="{ 'ai-page__tab--active': activeTab === tab.key }"
            @click="setTab(tab.key)"
          >
            <span class="ai-page__tab-icon" aria-hidden="true">
              <svg viewBox="0 0 24 24">
                <path :d="tab.icon" />
              </svg>
            </span>
            <span class="ai-page__tab-copy">
              <span class="ai-page__tab-title">{{ tab.label }}</span>
              <span class="ai-page__tab-hint">{{ tab.hint }}</span>
            </span>
          </button>
        </div>
      </article>
    </section>

    <section class="admin-grid admin-grid--main-aside">
      <article class="admin-panel admin-panel-block">
        <div class="admin-panel__head ai-page__workspace-head">
          <div class="ai-page__workspace-title">
            <span class="ai-page__headline-icon" aria-hidden="true">
              <svg viewBox="0 0 24 24">
                <path :d="activeTabMeta.icon" />
              </svg>
            </span>
            <div>
              <span class="admin-kicker">当前工作台</span>
              <h3 class="admin-panel__title">{{ activeTabMeta.label }}</h3>
            </div>
          </div>
          <span class="admin-copy">{{ activeTabMeta.hint }}</span>
        </div>

        <form v-if="activeTab === 'diagnosis'" class="ai-page__form" @submit.prevent="runDiagnosis">
          <div class="admin-grid admin-grid--two">
            <label class="admin-field">
              <span class="admin-field__label">事件编号</span>
              <input v-model.trim="diagnosisForm.eventId" class="admin-input admin-code" placeholder="evt-001" />
            </label>
            <label class="admin-field">
              <span class="admin-field__label">订单号</span>
              <input v-model.trim="diagnosisForm.orderNo" class="admin-input admin-code" placeholder="ord-001" />
            </label>
          </div>

          <label class="admin-field">
            <span class="admin-field__label">日志编号</span>
            <input v-model.trim="diagnosisForm.logId" class="admin-input admin-code" placeholder="log-001" />
          </label>

          <div class="admin-toolbar">
            <button class="admin-button" :disabled="diagnosisLoading">
              {{ diagnosisLoading ? "分析中" : "生成异常诊断" }}
            </button>
            <span class="admin-copy">至少填写一项编号即可。</span>
          </div>

          <div v-if="diagnosisError" class="admin-note ai-page__note ai-page__note--danger">{{ diagnosisError }}</div>

          <div v-if="diagnosisResult" class="ai-page__result">
            <div class="ai-page__meta">
              <span class="admin-pill" :class="pillClass(diagnosisResult.confidence)">
                置信度 {{ confidenceLabel(diagnosisResult.confidence) }}
              </span>
              <span class="admin-copy">
                {{ diagnosisResult.meta.model }} · {{ formatDateTime(diagnosisResult.meta.generatedAt) }}
              </span>
            </div>

            <div class="admin-kv">
              <div class="admin-kv__row">
                <span class="admin-kv__label">目标事件</span>
                <span class="admin-kv__value admin-code">
                  {{ diagnosisResult.target.eventId }} / {{ diagnosisResult.target.orderNo }}
                </span>
              </div>
              <div class="admin-kv__row">
                <span class="admin-kv__label">柜机</span>
                <span class="admin-kv__value">
                  {{ diagnosisResult.target.deviceName || diagnosisResult.target.deviceCode }}
                  <span class="admin-table__subtext admin-code">{{ diagnosisResult.target.deviceCode }}</span>
                </span>
              </div>
              <div class="admin-kv__row">
                <span class="admin-kv__label">事件状态</span>
                <span class="admin-kv__value">{{ diagnosisResult.target.status }}</span>
              </div>
              <div class="admin-kv__row">
                <span class="admin-kv__label">诊断摘要</span>
                <span class="admin-kv__value">{{ diagnosisResult.summary }}</span>
              </div>
              <div class="admin-kv__row">
                <span class="admin-kv__label">现场巡检</span>
                <span class="admin-kv__value">
                  {{ diagnosisResult.requiresOnsiteInspection ? "需要" : "暂不需要" }}
                  <span class="admin-table__subtext">{{ diagnosisResult.onsiteInspectionReason }}</span>
                </span>
              </div>
            </div>

            <div class="admin-grid admin-grid--two">
              <div class="ai-page__list-block">
                <span class="admin-field__label">可能原因</span>
                <ul class="ai-page__list">
                  <li v-for="(item, index) in diagnosisResult.possibleCauses" :key="`cause-${index}`">{{ item }}</li>
                </ul>
              </div>
              <div class="ai-page__list-block">
                <span class="admin-field__label">处置建议</span>
                <ul class="ai-page__list">
                  <li v-for="(item, index) in diagnosisResult.handlingSuggestions" :key="`suggestion-${index}`">
                    {{ item }}
                  </li>
                </ul>
              </div>
            </div>

            <div class="ai-page__list-block">
              <span class="admin-field__label">引用信号</span>
              <ul class="ai-page__list">
                <li v-for="(item, index) in diagnosisResult.referencedSignals" :key="`signal-${index}`">{{ item }}</li>
              </ul>
            </div>
          </div>

          <div v-else-if="!diagnosisError" class="admin-empty">
            <div class="admin-empty__title">输入编号后生成单次开柜异常诊断</div>
            <div class="admin-empty__body">适合定位门状态异常、结算未闭环、补扣或退款链路问题。</div>
          </div>
        </form>

        <form v-else-if="activeTab === 'report'" class="ai-page__form" @submit.prevent="runOperationsReport">
          <section class="ai-page__selector-block">
            <div class="ai-page__selector-head">
              <div>
                <span class="admin-kicker">功能选择</span>
                <h4 class="ai-page__selector-title">先确定业务日和日报口径</h4>
              </div>
              <span class="admin-copy">
                {{ reportType === "morning" ? "适合开班前巡检。" : "适合复盘当天问题和闭环。" }}
              </span>
            </div>

            <div class="admin-grid admin-grid--two">
              <label class="admin-field">
                <span class="admin-field__label">业务日</span>
                <input v-model="reportDateKey" class="admin-input admin-code" type="date" />
              </label>

              <div class="admin-field">
                <span class="admin-field__label">报告类型</span>
                <div class="ai-page__choice-grid">
                  <button
                    v-for="item in reportTypeOptions"
                    :key="item.value"
                    type="button"
                    class="ai-page__choice-card"
                    :class="{ 'ai-page__choice-card--active': reportType === item.value }"
                    @click="reportType = item.value"
                  >
                    <span class="ai-page__choice-title">{{ item.label }}</span>
                    <span class="ai-page__choice-hint">{{ item.hint }}</span>
                  </button>
                </div>
              </div>
            </div>

            <div class="admin-toolbar">
              <button class="admin-button" :disabled="operationsReportLoading">
                {{ operationsReportLoading ? "生成中" : "生成运维日报" }}
              </button>
              <span class="admin-copy">AI 会整合待办、缺货、临期和反馈摘要。</span>
            </div>
          </section>

          <div v-if="operationsReportError" class="admin-note ai-page__note ai-page__note--danger">
            {{ operationsReportError }}
          </div>

          <div v-if="operationsReportResult" class="ai-page__result">
            <div class="ai-page__meta">
              <span class="admin-pill admin-pill--success">
                {{ operationsReportResult.reportType === "morning" ? "晨报" : "日报" }}
              </span>
              <span class="admin-copy">
                {{ operationsReportResult.meta.model }} · {{ formatDateTime(operationsReportResult.meta.generatedAt) }}
              </span>
            </div>

            <div class="admin-kv">
              <div class="admin-kv__row">
                <span class="admin-kv__label">业务日</span>
                <span class="admin-kv__value admin-code">{{ operationsReportResult.dateKey }}</span>
              </div>
              <div class="admin-kv__row">
                <span class="admin-kv__label">摘要</span>
                <span class="admin-kv__value">{{ operationsReportResult.summary }}</span>
              </div>
            </div>

            <div class="admin-grid admin-grid--two">
              <div class="ai-page__list-block">
                <span class="admin-field__label">优先事项</span>
                <ul class="ai-page__list">
                  <li v-for="(item, index) in operationsReportResult.priorityItems" :key="`priority-${index}`">
                    {{ item }}
                  </li>
                </ul>
              </div>
              <div class="ai-page__list-block">
                <span class="admin-field__label">建议动作</span>
                <ul class="ai-page__list">
                  <li
                    v-for="(item, index) in operationsReportResult.recommendedActions"
                    :key="`action-${index}`"
                  >
                    {{ item }}
                  </li>
                </ul>
              </div>
            </div>

            <div class="admin-grid admin-grid--two">
              <div class="ai-page__list-block">
                <span class="admin-field__label">缺货风险</span>
                <ul class="ai-page__list">
                  <li v-for="(item, index) in operationsReportResult.stockRisks" :key="`stock-${index}`">
                    {{ item }}
                  </li>
                </ul>
              </div>
              <div class="ai-page__list-block">
                <span class="admin-field__label">临期风险</span>
                <ul class="ai-page__list">
                  <li v-for="(item, index) in operationsReportResult.expiryRisks" :key="`expiry-${index}`">
                    {{ item }}
                  </li>
                </ul>
              </div>
            </div>

            <div class="ai-page__list-block">
              <span class="admin-field__label">反馈摘要</span>
              <ul class="ai-page__list">
                <li
                  v-for="(item, index) in operationsReportResult.feedbackHighlights"
                  :key="`feedback-highlight-${index}`"
                >
                  {{ item }}
                </li>
              </ul>
            </div>
          </div>

          <div v-else-if="!operationsReportError" class="admin-empty">
            <div class="admin-empty__title">选择业务日和报告类型后生成摘要</div>
            <div class="admin-empty__body">结果会自动整理待办、风险和当天建议动作。</div>
          </div>
        </form>

        <form v-else-if="activeTab === 'restock'" class="ai-page__form" @submit.prevent="runRestockSuggestions">
          <div class="admin-grid admin-grid--two">
            <label class="admin-field">
              <span class="admin-field__label">参考业务日</span>
              <input v-model="restockDateKey" class="admin-input admin-code" type="date" />
            </label>
            <label class="admin-field">
              <span class="admin-field__label">观察范围</span>
              <select v-model="restockRange" class="admin-select">
                <option v-for="item in rangeOptions" :key="item.value" :value="item.value">
                  {{ item.label }}
                </option>
              </select>
            </label>
          </div>

          <div class="admin-toolbar">
            <button class="admin-button" :disabled="restockLoading">
              {{ restockLoading ? "分析中" : "生成补货与布局建议" }}
            </button>
            <RouterLink class="admin-link" to="/data-monitor">查看原始监控数据</RouterLink>
          </div>

          <div v-if="restockError" class="admin-note ai-page__note ai-page__note--danger">{{ restockError }}</div>

          <div v-if="restockResult" class="ai-page__result">
            <div class="ai-page__meta">
              <span class="admin-pill admin-pill--success">{{ restockResult.range }}</span>
              <span class="admin-copy">
                {{ restockResult.meta.model }} · {{ formatDateTime(restockResult.meta.generatedAt) }}
              </span>
            </div>

            <div class="admin-kv">
              <div class="admin-kv__row">
                <span class="admin-kv__label">摘要</span>
                <span class="admin-kv__value">{{ restockResult.summary }}</span>
              </div>
            </div>

            <div class="ai-page__list-block">
              <span class="admin-field__label">单柜补货建议</span>
              <div class="admin-list">
                <div
                  v-for="item in restockResult.deviceRecommendations"
                  :key="`${item.deviceCode}-${item.goodsId ?? item.goodsName}`"
                  class="admin-list__row"
                >
                  <div class="admin-list__main">
                    <span class="admin-list__title">
                      {{ item.deviceName }} · {{ item.goodsName }}
                      <span v-if="item.suggestedQuantity !== undefined" class="admin-table__subtext">
                        建议补货 {{ item.suggestedQuantity }} 件
                      </span>
                    </span>
                    <span class="admin-list__meta">{{ item.reason }}</span>
                  </div>
                  <span class="admin-pill admin-pill--warning admin-code">{{ item.deviceCode }}</span>
                </div>
              </div>
            </div>

            <div class="ai-page__list-block">
              <span class="admin-field__label">区域布局建议</span>
              <div class="admin-list">
                <div
                  v-for="item in restockResult.regionRecommendations"
                  :key="`${item.regionId ?? item.regionName}-${item.suggestion}`"
                  class="admin-list__row"
                >
                  <div class="admin-list__main">
                    <span class="admin-list__title">{{ item.regionName }}</span>
                    <span class="admin-list__meta">{{ item.suggestion }}</span>
                    <span class="admin-list__meta">{{ item.reason }}</span>
                  </div>
                </div>
              </div>
            </div>

            <div class="ai-page__list-block">
              <span class="admin-field__label">时段热度洞察</span>
              <ul class="ai-page__list">
                <li v-for="(item, index) in restockResult.scheduleInsights" :key="`schedule-${index}`">{{ item }}</li>
              </ul>
            </div>
          </div>

          <div v-else-if="!restockError" class="admin-empty">
            <div class="admin-empty__title">选择观察范围后生成补货与布局建议</div>
            <div class="admin-empty__body">结果会同时覆盖单柜补货、区域布局和时段热度。</div>
          </div>
        </form>

        <form v-else-if="activeTab === 'feedback'" class="ai-page__form" @submit.prevent="runFeedbackDraft">
          <label class="admin-field">
            <span class="admin-field__label">反馈任务</span>
            <select v-model="feedbackAlertId" class="admin-select">
              <option value="">请选择反馈任务</option>
              <option v-for="item in feedbackAlerts" :key="item.id" :value="item.id">
                {{ item.title }} · {{ item.deviceCode || "未绑定柜机" }} · {{ item.status }}
              </option>
            </select>
          </label>

          <div class="admin-toolbar">
            <button class="admin-button" :disabled="feedbackLoading || alertsLoading">
              {{ feedbackLoading ? "生成中" : "生成分流建议与回复草稿" }}
            </button>
            <button class="admin-button admin-button--ghost" type="button" :disabled="alertsLoading" @click="loadAlerts">
              {{ alertsLoading ? "刷新中" : "刷新反馈任务" }}
            </button>
          </div>

          <div v-if="alertsError" class="admin-note ai-page__note ai-page__note--danger">{{ alertsError }}</div>
          <div v-if="feedbackError" class="admin-note ai-page__note ai-page__note--danger">{{ feedbackError }}</div>

          <div v-if="selectedFeedbackAlert" class="admin-note ai-page__note">
            {{ selectedFeedbackAlert.detail }}
          </div>

          <div v-if="feedbackResult" class="ai-page__result">
            <div class="ai-page__meta">
              <span class="admin-pill" :class="pillClass(feedbackResult.urgency)">
                紧急度 {{ urgencyLabel(feedbackResult.urgency) }}
              </span>
              <span class="admin-copy">
                {{ feedbackResult.meta.model }} · {{ formatDateTime(feedbackResult.meta.generatedAt) }}
              </span>
            </div>

            <div class="admin-kv">
              <div class="admin-kv__row">
                <span class="admin-kv__label">反馈标题</span>
                <span class="admin-kv__value">{{ feedbackResult.title }}</span>
              </div>
              <div class="admin-kv__row">
                <span class="admin-kv__label">分类</span>
                <span class="admin-kv__value">{{ feedbackResult.classification }}</span>
              </div>
              <div class="admin-kv__row">
                <span class="admin-kv__label">问题摘要</span>
                <span class="admin-kv__value">{{ feedbackResult.summary }}</span>
              </div>
              <div class="admin-kv__row">
                <span class="admin-kv__label">分流建议</span>
                <span class="admin-kv__value">{{ feedbackResult.dispatchRecommendation }}</span>
              </div>
            </div>

            <div class="ai-page__list-block">
              <span class="admin-field__label">回复草稿</span>
              <pre class="ai-page__pre">{{ feedbackResult.replyDraft }}</pre>
            </div>
          </div>

          <div v-else-if="!feedbackError" class="admin-empty">
            <div class="admin-empty__title">从反馈任务池中选择一条记录后生成分流建议</div>
            <div class="admin-empty__body">适合先做分类、判定紧急程度，再生成管理员回复草稿。</div>
          </div>
        </form>

        <form v-else class="ai-page__form" @submit.prevent="runPolicyOptimization">
          <div class="admin-grid admin-grid--two">
            <label class="admin-field">
              <span class="admin-field__label">参考业务日</span>
              <input v-model="policyDateKey" class="admin-input admin-code" type="date" />
            </label>
            <label class="admin-field">
              <span class="admin-field__label">观察范围</span>
              <select v-model="policyRange" class="admin-select">
                <option v-for="item in rangeOptions" :key="item.value" :value="item.value">
                  {{ item.label }}
                </option>
              </select>
            </label>
          </div>

          <div class="admin-toolbar">
            <button class="admin-button" :disabled="policyLoading">
              {{ policyLoading ? "分析中" : "生成策略优化建议" }}
            </button>
            <RouterLink class="admin-link" to="/users">查看人员台账</RouterLink>
          </div>

          <div v-if="policyError" class="admin-note ai-page__note ai-page__note--danger">{{ policyError }}</div>

          <div v-if="policyResult" class="ai-page__result">
            <div class="ai-page__meta">
              <span class="admin-pill admin-pill--success">{{ policyResult.range }}</span>
              <span class="admin-copy">
                {{ policyResult.meta.model }} · {{ formatDateTime(policyResult.meta.generatedAt) }}
              </span>
            </div>

            <div class="admin-kv">
              <div class="admin-kv__row">
                <span class="admin-kv__label">摘要</span>
                <span class="admin-kv__value">{{ policyResult.summary }}</span>
              </div>
            </div>

            <div class="admin-grid admin-grid--two">
              <div class="ai-page__list-block">
                <span class="admin-field__label">未充分服务信号</span>
                <ul class="ai-page__list">
                  <li v-for="(item, index) in policyResult.underservedSignals" :key="`underserved-${index}`">
                    {{ item }}
                  </li>
                </ul>
              </div>
              <div class="ai-page__list-block">
                <span class="admin-field__label">拟调整项</span>
                <ul class="ai-page__list">
                  <li v-for="(item, index) in policyResult.proposedAdjustments" :key="`adjustment-${index}`">
                    {{ item }}
                  </li>
                </ul>
              </div>
            </div>

            <div class="ai-page__list-block">
              <span class="admin-field__label">注意事项</span>
              <ul class="ai-page__list">
                <li v-for="(item, index) in policyResult.cautionNotes" :key="`caution-${index}`">{{ item }}</li>
              </ul>
            </div>
          </div>

          <div v-else-if="!policyError" class="admin-empty">
            <div class="admin-empty__title">选择日期和范围后生成策略优化建议</div>
            <div class="admin-empty__body">适合辅助调整时段、品类和数量上限。</div>
          </div>
        </form>
      </article>

      <aside class="admin-grid">
        <article class="admin-panel admin-panel-block">
          <div class="admin-panel__head">
            <div>
              <span class="admin-kicker">使用提示</span>
              <h3 class="admin-panel__title">当前页签建议</h3>
            </div>
          </div>
          <div class="admin-list">
            <div v-for="(tip, index) in assistantTips" :key="`tip-${index}`" class="admin-note">{{ tip }}</div>
          </div>
        </article>

        <article class="admin-panel admin-panel-block">
          <div class="admin-panel__head">
            <div>
              <span class="admin-kicker">本地记录</span>
              <h3 class="admin-panel__title">最近生成内容</h3>
            </div>
            <button
              v-if="recentHistoryEntries.length"
              class="admin-button admin-button--ghost"
              type="button"
              @click="clearSavedHistory"
            >
              清空记录
            </button>
          </div>

          <div v-if="recentHistoryEntries.length" class="admin-list">
            <div
              v-for="item in recentHistoryEntries"
              :key="item.id"
              class="admin-list__row ai-page__clickable-row"
              @click="openHistoryEntry(item)"
            >
              <div class="admin-list__main">
                <span class="admin-list__title">
                  {{ item.title }}
                  <span class="admin-table__subtext">{{ workspaceTabLabel(item.tab) }}</span>
                </span>
                <span class="admin-list__meta">{{ item.summary }}</span>
                <span class="admin-list__meta ai-page__history-time">
                  {{ formatDateTime(item.generatedAt) }}
                </span>
              </div>
            </div>
          </div>

          <div v-else class="admin-empty">
            <div class="admin-empty__title">还没有已保存的 AI 结果</div>
            <div class="admin-empty__body">每次生成成功后，最近内容会保存在当前浏览器里。</div>
          </div>

          <div class="admin-note ai-page__note">
            这些记录只保存在当前浏览器，用来避免页面跳转后内容丢失，不会自动写入业务台账。
          </div>
        </article>

        <article class="admin-panel admin-panel-block">
          <div class="admin-panel__head">
            <div>
              <span class="admin-kicker">关联入口</span>
              <h3 class="admin-panel__title">继续追踪原始数据</h3>
            </div>
          </div>

          <div v-if="activeTab === 'feedback'" class="admin-list">
            <div
              v-for="item in feedbackAlerts.slice(0, 6)"
              :key="item.id"
              class="admin-list__row ai-page__clickable-row"
              @click="feedbackAlertId = item.id"
            >
              <div class="admin-list__main">
                <span class="admin-list__title">{{ item.title }}</span>
                <span class="admin-list__meta">{{ item.previewDetail || item.detail }}</span>
              </div>
              <span class="admin-pill" :class="item.status === 'open' ? 'admin-pill--warning' : 'admin-pill--neutral'">
                {{ item.status }}
              </span>
            </div>
            <div v-if="!feedbackAlerts.length" class="admin-empty">
              <div class="admin-empty__title">当前没有反馈任务</div>
              <div class="admin-empty__body">反馈任务会从告警池自动汇入这里。</div>
            </div>
          </div>

          <div v-else class="admin-list">
            <div class="admin-list__row">
              <div class="admin-list__main">
                <span class="admin-list__title">日志总览</span>
                <span class="admin-list__meta">查看事件、设备和告警的原始日志链路。</span>
              </div>
              <RouterLink class="admin-link" to="/logs">进入</RouterLink>
            </div>
            <div class="admin-list__row">
              <div class="admin-list__main">
                <span class="admin-list__title">数据监控</span>
                <span class="admin-list__meta">核对区域分布、时段热度和近期走势。</span>
              </div>
              <RouterLink class="admin-link" to="/data-monitor">进入</RouterLink>
            </div>
            <div class="admin-list__row">
              <div class="admin-list__main">
                <span class="admin-list__title">柜机监控</span>
                <span class="admin-list__meta">查看门状态、库存、回调和现场设备情况。</span>
              </div>
              <RouterLink class="admin-link" to="/operations">进入</RouterLink>
            </div>
          </div>
        </article>
      </aside>
    </section>

    <div v-if="configDialogOpen" class="ai-page__modal-backdrop" @click.self="closeConfigDialog">
      <section class="ai-page__modal admin-panel">
        <div class="admin-panel__head">
          <div>
            <span class="admin-kicker">模型配置</span>
            <h3 class="admin-panel__title">编辑 AI 接入参数</h3>
          </div>
          <button type="button" class="admin-button admin-button--ghost" @click="closeConfigDialog">取消</button>
        </div>

        <form class="ai-page__modal-form" @submit.prevent="saveConfig">
          <div class="ai-page__modal-pills">
            <span class="admin-pill" :class="aiStatus?.apiKeyConfigured ? 'admin-pill--success' : 'admin-pill--warning'">
              {{ aiStatus?.apiKeyConfigured ? "API Key 已保存" : "需要 API Key" }}
            </span>
            <span class="admin-pill">{{ aiStatus?.usingDefaultBaseUrl === false ? "自定义地址" : "默认地址" }}</span>
            <span class="admin-pill">{{ aiStatus?.usingDefaultModel === false ? "自定义模型" : "默认模型" }}</span>
          </div>

          <div class="admin-note ai-page__note">
            API Key 不回显。已有 Key 留空即可保持不变，只有准备切换账号或网关时再重新填写。
          </div>

          <label class="admin-field">
            <span class="admin-field__label">API Key</span>
            <input
              v-model="configForm.apiKey"
              class="admin-input admin-code"
              type="password"
              autocomplete="off"
              :placeholder="aiStatus?.apiKeyConfigured ? '已配置，留空则保持不变' : '请输入可用的 API Key'"
            />
          </label>

          <label class="admin-field">
            <span class="admin-field__label">Base URL</span>
            <input
              v-model.trim="configForm.baseUrl"
              class="admin-input admin-code"
              placeholder="https://api.openai.com/v1"
            />
          </label>

          <label class="admin-field">
            <span class="admin-field__label">模型名称</span>
            <input v-model.trim="configForm.model" class="admin-input admin-code" placeholder="gpt-4.1-mini" />
          </label>

          <div v-if="configError" class="admin-note ai-page__note ai-page__note--danger">{{ configError }}</div>

          <div class="admin-toolbar ai-page__modal-actions">
            <button type="button" class="admin-button admin-button--ghost" @click="closeConfigDialog">取消</button>
            <button class="admin-button" :disabled="configSaving">{{ configSaving ? "保存中" : "保存配置" }}</button>
          </div>
        </form>
      </section>
    </div>
  </section>
</template>

<style scoped>
.ai-page__section-head {
  align-items: flex-start;
}

.ai-page__section-copy {
  display: grid;
  gap: 6px;
}

.ai-page__status-actions {
  flex-wrap: wrap;
  justify-content: flex-end;
}

.ai-page__action-button {
  display: inline-flex;
  align-items: center;
  gap: 8px;
}

.ai-page__button-icon,
.ai-page__card-icon,
.ai-page__tab-icon,
.ai-page__headline-icon {
  display: inline-flex;
  align-items: center;
  justify-content: center;
}

.ai-page__button-icon svg,
.ai-page__card-icon svg,
.ai-page__tab-icon svg,
.ai-page__headline-icon svg {
  width: 18px;
  height: 18px;
  fill: currentColor;
}

.ai-page__status-grid {
  align-items: stretch;
}

.ai-page__status-card {
  display: grid;
  gap: 8px;
  align-content: start;
  border-radius: 12px;
}

.ai-page__status-card--info {
  background: linear-gradient(180deg, #ffffff 0%, #f7fbff 100%);
}

.ai-page__status-card--success {
  border-color: #b9dec6;
  background: linear-gradient(180deg, #ffffff 0%, #eff8f2 100%);
}

.ai-page__status-card--warning {
  border-color: #efcf8d;
  background: linear-gradient(180deg, #ffffff 0%, #fff8ea 100%);
}

.ai-page__status-card--neutral {
  background: linear-gradient(180deg, #ffffff 0%, #f7f9fc 100%);
}

.ai-page__card-icon {
  width: 36px;
  height: 36px;
  border-radius: 10px;
  background: rgba(29, 79, 145, 0.1);
  color: var(--admin-accent-strong);
}

.ai-page__note {
  white-space: pre-wrap;
}

.ai-page__note--danger {
  border-left-color: #d9a6a1;
  background: #fff3f1;
  color: #8d342e;
}

.ai-page__note--success {
  border-left-color: #a9d2b5;
  background: #effaf2;
  color: #1d6b3d;
}

.ai-page__tab-shell {
  gap: 10px;
  border-radius: 14px;
  background: linear-gradient(180deg, #ffffff 0%, #f7f9fc 100%);
}

.ai-page__tabs {
  display: grid;
  grid-template-columns: repeat(5, minmax(0, 1fr));
  gap: 10px;
}

.ai-page__tab {
  display: flex;
  align-items: flex-start;
  gap: 10px;
  padding: 14px 12px;
  border: 1px solid var(--admin-line);
  border-radius: 12px;
  background: var(--admin-panel);
  text-align: left;
  cursor: pointer;
  transition: border-color 160ms ease, background-color 160ms ease, box-shadow 160ms ease;
}

.ai-page__tab:hover {
  border-color: #aebfe1;
  background: var(--admin-panel-muted);
  box-shadow: inset 0 0 0 1px rgba(29, 79, 145, 0.06);
}

.ai-page__tab--active {
  border-color: #aebfe1;
  background: var(--admin-accent-soft);
}

.ai-page__tab-icon {
  width: 34px;
  height: 34px;
  flex: 0 0 34px;
  border-radius: 10px;
  background: rgba(29, 79, 145, 0.1);
  color: var(--admin-accent-strong);
}

.ai-page__tab-copy {
  display: grid;
  gap: 4px;
}

.ai-page__tab-title {
  font-weight: 700;
}

.ai-page__tab-hint {
  color: var(--admin-muted);
  line-height: 1.45;
  font-size: 0.82rem;
}

.ai-page__workspace-head {
  align-items: flex-start;
}

.ai-page__workspace-title {
  display: flex;
  align-items: center;
  gap: 12px;
}

.ai-page__headline-icon {
  width: 40px;
  height: 40px;
  border-radius: 12px;
  background: rgba(29, 79, 145, 0.1);
  color: var(--admin-accent-strong);
}

.ai-page__form,
.ai-page__result,
.ai-page__list-block,
.ai-page__modal-form {
  display: grid;
  gap: 12px;
}

.ai-page__selector-block {
  display: grid;
  gap: 12px;
  padding: 14px;
  border: 1px solid var(--admin-line);
  border-radius: 12px;
  background: linear-gradient(180deg, #ffffff 0%, #f8fbff 100%);
}

.ai-page__selector-head {
  display: flex;
  justify-content: space-between;
  gap: 12px;
  align-items: flex-start;
}

.ai-page__selector-title {
  margin: 4px 0 0;
  font-size: 0.98rem;
  line-height: 1.35;
}

.ai-page__choice-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 8px;
}

.ai-page__choice-card {
  display: grid;
  gap: 4px;
  padding: 12px;
  border: 1px solid var(--admin-line);
  border-radius: 10px;
  background: var(--admin-panel);
  color: var(--admin-text);
  text-align: left;
  cursor: pointer;
  transition: border-color 160ms ease, background-color 160ms ease;
}

.ai-page__choice-card:hover {
  border-color: #aebfe1;
  background: var(--admin-panel-muted);
}

.ai-page__choice-card--active {
  border-color: #94afd8;
  background: var(--admin-accent-soft);
}

.ai-page__choice-title {
  font-weight: 700;
}

.ai-page__choice-hint {
  color: var(--admin-muted);
  font-size: 0.82rem;
  line-height: 1.45;
}

.ai-page__meta {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
}

.ai-page__list {
  display: grid;
  gap: 8px;
  margin: 0;
  padding-left: 18px;
  line-height: 1.55;
}

.ai-page__pre {
  margin: 0;
  padding: 12px;
  border: 1px solid var(--admin-line);
  border-radius: 8px;
  background: var(--admin-panel-muted);
  white-space: pre-wrap;
  word-break: break-word;
  line-height: 1.6;
}

.ai-page__clickable-row {
  cursor: pointer;
}

.ai-page__clickable-row:hover {
  background: #f8fbff;
}

.ai-page__history-time {
  font-size: 0.8rem;
}

.ai-page__modal-backdrop {
  position: fixed;
  inset: 0;
  z-index: 30;
  display: grid;
  place-items: center;
  padding: 24px;
  background: rgba(15, 23, 42, 0.32);
}

.ai-page__modal {
  width: min(680px, 100%);
  padding: 16px;
}

.ai-page__modal-pills {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}

.ai-page__modal-actions {
  justify-content: flex-end;
}

@media (max-width: 980px) {
  .ai-page__tabs,
  .ai-page__choice-grid {
    grid-template-columns: 1fr;
  }

  .ai-page__selector-head {
    display: grid;
  }
}
</style>
