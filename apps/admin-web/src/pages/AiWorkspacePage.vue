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
  AiRestockLayoutSuggestion,
  AlertTask,
  DataMonitorRange
} from "@vm/shared-types";

import { adminApi } from "../api/admin";
import { formatDateTime, getTodayDateKeyInBeijing } from "../utils/datetime";

type WorkspaceTab = "report" | "diagnosis" | "restock" | "feedback" | "policy";

const todayDateKey = getTodayDateKeyInBeijing();
const route = useRoute();
const router = useRouter();

const tabOptions: Array<{ key: WorkspaceTab; label: string; hint: string }> = [
  { key: "report", label: "运维日报", hint: "汇总待办、缺货、临期和反馈。" },
  { key: "diagnosis", label: "异常诊断", hint: "分析单次开柜事件的门状态和回调链路。" },
  { key: "restock", label: "补货布局", hint: "结合区域和时段热度给出建议。" },
  { key: "feedback", label: "反馈分流", hint: "分类反馈并生成回复草稿。" },
  { key: "policy", label: "策略优化", hint: "根据完成率和未服务人数调整策略。" }
];

const reportTypeOptions: Array<{ value: AiOperationsReportType; label: string }> = [
  { value: "morning", label: "晨报" },
  { value: "daily", label: "日报" }
];

const rangeOptions: Array<{ value: DataMonitorRange; label: string }> = [
  { value: "today", label: "今天" },
  { value: "3d", label: "近三天" },
  { value: "7d", label: "近七天" }
];

const aiStatus = ref<AiProviderStatus>();
const statusLoading = ref(false);
const statusError = ref("");

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

const activeTabMeta = computed(() => tabOptions.find((item) => item.key === activeTab.value) ?? tabOptions[0]);
const isAiEnabled = computed(() => aiStatus.value?.enabled ?? false);
const missingConfig = computed(() => aiStatus.value?.missingConfig ?? []);
const feedbackAlerts = computed(() =>
  alerts.value.filter((alert) => alert.grade === "feedback" || alert.type === "user_feedback")
);
const selectedFeedbackAlert = computed(() =>
  feedbackAlerts.value.find((alert) => alert.id === feedbackAlertId.value)
);

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
    diagnosisResult.value = await adminApi.aiEventDiagnosis({
      eventId: diagnosisForm.value.eventId.trim() || undefined,
      orderNo: diagnosisForm.value.orderNo.trim() || undefined,
      logId: diagnosisForm.value.logId.trim() || undefined
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
    operationsReportResult.value = await adminApi.aiOperationsReport({
      dateKey: reportDateKey.value,
      reportType: reportType.value
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
    restockResult.value = await adminApi.aiRestockLayoutSuggestions({
      dateKey: restockDateKey.value,
      range: restockRange.value
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
    feedbackResult.value = await adminApi.aiFeedbackDraft({
      alertId: feedbackAlertId.value
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
    policyResult.value = await adminApi.aiPolicyOptimization({
      dateKey: policyDateKey.value,
      range: policyRange.value
    });
  } catch (error) {
    policyError.value = readErrorMessage(error);
  } finally {
    policyLoading.value = false;
  }
};

onMounted(() => {
  void loadBootstrap();
});
</script>

<template>
  <section class="admin-page ai-page">
    <section class="admin-page__section">
      <div class="admin-page__section-head">
        <div>
          <p class="admin-kicker">模型接入状态</p>
          <h3 class="admin-page__section-title">OpenAI 兼容接口只需填入 API Key 即可启用</h3>
        </div>
        <div class="admin-toolbar">
          <span class="admin-pill" :class="isAiEnabled ? 'admin-pill--success' : 'admin-pill--warning'">
            {{ isAiEnabled ? "已启用" : "待配置" }}
          </span>
          <button class="admin-button admin-button--ghost" :disabled="statusLoading" @click="loadStatus">
            {{ statusLoading ? "刷新中" : "刷新状态" }}
          </button>
        </div>
      </div>

      <div class="admin-grid admin-grid--stats-4">
        <article class="admin-panel admin-panel-block admin-panel-block--tight">
          <span class="admin-kicker">Provider</span>
          <h3 class="admin-page__section-title">{{ aiStatus?.provider ?? "openai-compatible" }}</h3>
          <p class="admin-copy">后端统一负责鉴权与请求转发。</p>
        </article>
        <article class="admin-panel admin-panel-block admin-panel-block--tight">
          <span class="admin-kicker">模型</span>
          <h3 class="admin-page__section-title admin-code">{{ aiStatus?.model ?? "gpt-4.1-mini" }}</h3>
          <p class="admin-copy">默认模型可直接使用，也可在环境变量中替换。</p>
        </article>
        <article class="admin-panel admin-panel-block admin-panel-block--tight">
          <span class="admin-kicker">Base URL</span>
          <h3 class="admin-page__section-title admin-code ai-page__code-title">
            {{ aiStatus?.baseUrl ?? "https://api.openai.com/v1" }}
          </h3>
          <p class="admin-copy">默认对接 OpenAI 官方格式。</p>
        </article>
        <article class="admin-panel admin-panel-block admin-panel-block--tight">
          <span class="admin-kicker">缺失配置</span>
          <h3 class="admin-page__section-title">{{ missingConfig.length }}</h3>
          <p class="admin-copy">{{ missingConfig.length ? missingConfig.join("、") : "配置完整" }}</p>
        </article>
      </div>

      <div v-if="statusError" class="admin-note ai-page__note ai-page__note--danger">{{ statusError }}</div>
      <div v-if="!isAiEnabled" class="admin-note ai-page__note">
        默认只需在后端 `.env` 中填写 `OPENAI_API_KEY`，就可以直接使用 OpenAI 官方地址和默认模型；只有切换兼容网关时才需要再改
        `OPENAI_BASE_URL` 和 `OPENAI_MODEL`。
      </div>
    </section>

    <section class="admin-page__section">
      <div class="ai-page__tabs">
        <button
          v-for="tab in tabOptions"
          :key="tab.key"
          type="button"
          class="ai-page__tab"
          :class="{ 'ai-page__tab--active': activeTab === tab.key }"
          @click="setTab(tab.key)"
        >
          <span class="ai-page__tab-title">{{ tab.label }}</span>
          <span class="ai-page__tab-hint">{{ tab.hint }}</span>
        </button>
      </div>
    </section>

    <section class="admin-grid admin-grid--main-aside">
      <article class="admin-panel admin-panel-block">
        <div class="admin-panel__head">
          <div>
            <span class="admin-kicker">当前工作台</span>
            <h3 class="admin-panel__title">{{ activeTabMeta.label }}</h3>
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
          <div class="admin-grid admin-grid--two">
            <label class="admin-field">
              <span class="admin-field__label">业务日</span>
              <input v-model="reportDateKey" class="admin-input admin-code" type="date" />
            </label>
            <label class="admin-field">
              <span class="admin-field__label">报告类型</span>
              <select v-model="reportType" class="admin-select">
                <option v-for="item in reportTypeOptions" :key="item.value" :value="item.value">
                  {{ item.label }}
                </option>
              </select>
            </label>
          </div>

          <div class="admin-toolbar">
            <button class="admin-button" :disabled="operationsReportLoading">
              {{ operationsReportLoading ? "生成中" : "生成运维日报" }}
            </button>
            <span class="admin-copy">晨报适合开班前巡检，日报适合复盘。</span>
          </div>

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
  </section>
</template>

<style scoped>
.ai-page__code-title {
  font-size: 0.94rem;
  line-height: 1.3;
  word-break: break-all;
}

.ai-page__tabs {
  display: grid;
  grid-template-columns: repeat(5, minmax(0, 1fr));
  gap: 8px;
}

.ai-page__tab {
  display: grid;
  gap: 4px;
  padding: 12px;
  border: 1px solid var(--admin-line);
  border-radius: 10px;
  background: var(--admin-panel);
  text-align: left;
  cursor: pointer;
}

.ai-page__tab:hover {
  border-color: #aebfe1;
  background: var(--admin-panel-muted);
}

.ai-page__tab--active {
  border-color: #aebfe1;
  background: var(--admin-accent-soft);
}

.ai-page__tab-title {
  font-weight: 700;
}

.ai-page__tab-hint {
  color: var(--admin-muted);
  line-height: 1.45;
  font-size: 0.82rem;
}

.ai-page__form {
  display: grid;
  gap: 12px;
}

.ai-page__note {
  white-space: pre-wrap;
}

.ai-page__note--danger {
  border-left-color: #d9a6a1;
  background: #fff3f1;
  color: #8d342e;
}

.ai-page__result {
  display: grid;
  gap: 12px;
}

.ai-page__meta {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
}

.ai-page__list-block {
  display: grid;
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

@media (max-width: 980px) {
  .ai-page__tabs {
    grid-template-columns: 1fr;
  }
}
</style>
