<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from "vue";
import { RouterLink } from "vue-router";
import type { DashboardSnapshot, OperationLogRecord } from "@vm/shared-types";

import { adminApi } from "../api/admin";
import StatTile from "../components/StatTile.vue";
import { useAdminSessionStore } from "../stores/session";
import { resolveActorLink, resolveSubjectLink } from "../utils/entity-links";
import { formatDateTime } from "../utils/datetime";
import {
  buildAlertContextSummary,
  buildAlertIdentitySummary,
  buildAlertReferenceSummary,
  buildLogContextSummary,
  buildLogReferenceSummary,
  buildLogSubjectSummary,
  formatActorTypeLabel,
  formatLogCategoryLabel
} from "../utils/business-context";

type BucketKey = "completeUsers" | "partialUsers" | "unservedUsers";
type TrendMarker = {
  x: number;
  y: number;
  value: number;
  label: string;
};

const dashboard = ref<DashboardSnapshot>();
const sessionStore = useAdminSessionStore();
const canManageAlerts = computed(() => sessionStore.can("alerts:manage"));
const loading = ref(false);
const loadError = ref("");
const actionMessage = ref<{ type: "success" | "error"; text: string }>();
const activeBucket = ref<BucketKey>();
const resolvingTaskId = ref<string>();
const activeTask = ref<NonNullable<typeof pendingTasks.value>[number]>();
let timer: ReturnType<typeof setInterval> | undefined;
let visibilityHandler: (() => void) | undefined;

const summaryLogs = computed(() => dashboard.value?.summaryLogs ?? []);
const pendingTasks = computed(() => dashboard.value?.pendingTasks ?? []);
const serviceFollowUpCount = computed(() => {
  const overview = dashboard.value?.serviceOverview;

  return (overview?.partialUsers.count ?? 0) + (overview?.unservedUsers.count ?? 0);
});
const serviceTotalCount = computed(() => {
  const overview = dashboard.value?.serviceOverview;

  return (
    (overview?.completeUsers.count ?? 0) +
    (overview?.partialUsers.count ?? 0) +
    (overview?.unservedUsers.count ?? 0)
  );
});
const serviceMixStyle = computed(() => {
  const overview = dashboard.value?.serviceOverview;
  const total = Math.max(1, serviceTotalCount.value);
  const complete = ((overview?.completeUsers.count ?? 0) / total) * 100;
  const partial = complete + ((overview?.partialUsers.count ?? 0) / total) * 100;

  return {
    "--service-complete": `${complete}%`,
    "--service-partial": `${partial}%`
  };
});
const highPriorityTasks = computed(() =>
  pendingTasks.value
    .filter((task) => task.grade === "fault" || task.grade === "warning")
    .slice(0, 4)
);
const serviceTrend = computed(() => dashboard.value?.serviceTrend ?? []);
const completeUsersTrend = computed(() => serviceTrend.value.map((point) => point.completeUsers));
const partialUsersTrend = computed(() => serviceTrend.value.map((point) => point.partialUsers));
const unservedUsersTrend = computed(() => serviceTrend.value.map((point) => point.unservedUsers));
const pendingTasksTrend = computed(() => serviceTrend.value.map((point) => point.pendingTasks));
const servedUsersTrend = computed(() =>
  serviceTrend.value.map((point) => point.completeUsers + point.partialUsers)
);
const followUpUsersTrend = computed(() =>
  serviceTrend.value.map((point) => point.partialUsers + point.unservedUsers)
);

const trendChartBounds = {
  left: 24,
  right: 438,
  top: 28,
  bottom: 152
};

const trendMaxValue = computed(() => {
  const values = [...servedUsersTrend.value, ...followUpUsersTrend.value].filter((value) =>
    Number.isFinite(value)
  );

  return Math.max(1, ...values);
});

const hasServiceTrendChart = computed(() => serviceTrend.value.length >= 2);
const createTrendPlot = (
  values: number[],
  trend: DashboardSnapshot["serviceTrend"],
  maxValue: number
): { points: string; markers: TrendMarker[] } => {
  if (values.length < 2) {
    return { points: "", markers: [] };
  }

  const width = trendChartBounds.right - trendChartBounds.left;
  const height = trendChartBounds.bottom - trendChartBounds.top;
  const markers = values.map((rawValue, index) => {
    const value = Number.isFinite(rawValue) ? rawValue : 0;
    const x = trendChartBounds.left + (index / (values.length - 1)) * width;
    const y = trendChartBounds.bottom - (value / maxValue) * height;

    return {
      x,
      y,
      value,
      label: trend[index]?.label ?? ""
    };
  });

  return {
    points: markers.map((point) => `${point.x.toFixed(1)},${point.y.toFixed(1)}`).join(" "),
    markers
  };
};
const servedTrendPlot = computed(() =>
  createTrendPlot(servedUsersTrend.value, serviceTrend.value, trendMaxValue.value)
);
const followUpTrendPlot = computed(() =>
  createTrendPlot(followUpUsersTrend.value, serviceTrend.value, trendMaxValue.value)
);
const trendChartLabel = computed(() =>
  serviceTrend.value.length
    ? serviceTrend.value
        .map(
          (point) =>
            `${point.label} 已服务 ${point.completeUsers + point.partialUsers} 人，需跟进 ${
              point.partialUsers + point.unservedUsers
            } 人`
        )
        .join("；")
    : "近 7 日服务趋势暂无数据"
);

const bucketMeta: Record<BucketKey, { title: string; hint: string; tone: "accent" | "warning" | "neutral" }> = {
  completeUsers: {
    title: "今日完全服务人数",
    hint: "业务日内所有应领物资都已完成",
    tone: "accent"
  },
  partialUsers: {
    title: "今日部分服务人数",
    hint: "业务日内只完成了部分应领物资",
    tone: "warning"
  },
  unservedUsers: {
    title: "今日未服务人数",
    hint: "业务日内尚未领取任何应领物资",
    tone: "neutral"
  }
};

const activeBucketData = computed(() => {
  if (!dashboard.value || !activeBucket.value) {
    return undefined;
  }

  return dashboard.value.serviceOverview[activeBucket.value];
});

const resolveLogLink = (log: OperationLogRecord) => `/logs/${log.id}`;
const resolveActorRoute = (log: OperationLogRecord) => resolveActorLink(log.actor);
const formatLogStatus = (status: OperationLogRecord["status"]) =>
  status === "success" ? "成功" : status === "warning" ? "预警" : status === "failed" ? "失败" : "待处理";
const taskContextSummary = (task: NonNullable<typeof pendingTasks.value>[number]) =>
  buildAlertContextSummary(task) || "未关联到明确的商品、人员或柜机";
const taskIdentitySummary = (task: NonNullable<typeof pendingTasks.value>[number]) => buildAlertIdentitySummary(task);
const taskReferenceSummary = (task: NonNullable<typeof pendingTasks.value>[number]) => buildAlertReferenceSummary(task);
const logContextSummary = (log: OperationLogRecord) =>
  buildLogContextSummary(log) || buildLogSubjectSummary(log) || "未识别到明确业务对象";
const logReferenceSummary = (log: OperationLogRecord) => buildLogReferenceSummary(log);
const logSubjectSummary = (log: OperationLogRecord) => buildLogSubjectSummary(log);

const taskActionLabel = (task: NonNullable<typeof pendingTasks.value>[number]) =>
  task.grade === "fault" ? "标记已知晓" : "手动完成";

const taskGradeLabel = (grade: "fault" | "feedback" | "warning") =>
  grade === "fault" ? "故障" : grade === "feedback" ? "反馈" : "预警";

const resolveTaskAiLink = (task: NonNullable<typeof pendingTasks.value>[number]) => {
  if (task.grade === "feedback" || task.type === "user_feedback") {
    return `/ai?tab=feedback&alertId=${encodeURIComponent(task.id)}`;
  }

  if (task.relatedEventId || task.sourceLogId) {
    const query = new URLSearchParams({ tab: "diagnosis" });

    if (task.relatedEventId) {
      query.set("eventId", task.relatedEventId);
    }

    if (task.sourceLogId) {
      query.set("logId", task.sourceLogId);
    }

    return `/ai?${query.toString()}`;
  }

  return "/ai?tab=report";
};

const load = async () => {
  loading.value = true;
  try {
    // 后台首页首先要回答“今天还有谁没被服务到、还有哪些问题没处理完”。
    dashboard.value = await adminApi.dashboard();
    loadError.value = "";
  } catch (error) {
    loadError.value = error instanceof Error ? error.message : "加载运营总览失败";
  } finally {
    loading.value = false;
  }
};

const openBucket = (bucket: BucketKey) => {
  activeBucket.value = bucket;
};

const closeBucket = () => {
  activeBucket.value = undefined;
};

const openTaskDetail = (task: NonNullable<typeof pendingTasks.value>[number]) => {
  activeTask.value = task;
};

const closeTaskDetail = () => {
  activeTask.value = undefined;
};

const resolveTask = async (id: string) => {
  if (!canManageAlerts.value) {
    actionMessage.value = {
      type: "error",
      text: "当前账号没有预警处理权限，不能处理运营待办。"
    };
    return;
  }

  const task = pendingTasks.value.find((entry) => entry.id === id);

  if (!task) {
    return;
  }

  const confirmed = window.confirm(task.grade === "fault" ? "确认标记为已知晓？" : "确认手动完成这条待办？");

  if (!confirmed) {
    return;
  }

  resolvingTaskId.value = id;
  actionMessage.value = undefined;
  try {
    await adminApi.resolveAlert(
      id,
      task?.grade === "fault" ? "管理员已知晓并接手处理" : "管理员手动完成"
    );
    await load();
    actionMessage.value = {
      type: "success",
      text: task.grade === "fault" ? "已标记为知晓，请继续跟进柜机状态或关联日志。" : "待办已完成，已从当前待办列表移除。"
    };
  } catch (error) {
    actionMessage.value = {
      type: "error",
      text: error instanceof Error ? `处理待办失败：${error.message}` : "处理待办失败，请稍后重试。"
    };
  } finally {
    resolvingTaskId.value = undefined;
  }
};

onMounted(async () => {
  await load();
  timer = setInterval(load, 15_000);
  if (typeof document !== "undefined") {
    visibilityHandler = () => {
      if (document.hidden) {
        if (timer) {
          clearInterval(timer);
          timer = undefined;
        }
        return;
      }

      void load();
      if (timer) {
        clearInterval(timer);
      }
      timer = setInterval(load, 15_000);
    };
    document.addEventListener("visibilitychange", visibilityHandler);
  }
});

onUnmounted(() => {
  if (timer) {
    clearInterval(timer);
  }
  if (visibilityHandler) {
    document.removeEventListener("visibilitychange", visibilityHandler);
  }
});
</script>

<template>
  <section class="admin-page">
    <div v-if="loadError" class="admin-alert admin-alert--danger dashboard-load-error">
      <div>
        <strong>运营总览加载失败</strong>
        <p class="admin-copy">{{ loadError }}</p>
      </div>
      <button class="admin-button admin-button--ghost" :disabled="loading" @click="load">
        {{ loading ? "重试中" : "重试" }}
      </button>
    </div>

    <div v-if="actionMessage" class="admin-alert" :class="{ 'admin-alert--danger': actionMessage.type === 'error' }">
      {{ actionMessage.text }}
    </div>

    <article v-if="loading && !dashboard" class="admin-panel admin-loading">
      <span class="admin-kicker">正在同步</span>
      <div class="admin-skeleton admin-skeleton--wide"></div>
      <div class="admin-skeleton admin-skeleton--mid"></div>
      <div class="admin-skeleton admin-skeleton--short"></div>
    </article>

    <section v-if="dashboard" class="admin-page__section">
      <article class="dashboard-command admin-panel">
        <div class="dashboard-command__main">
          <span class="admin-kicker">今日看板</span>
          <h3 class="dashboard-command__title">先确认服务覆盖，再处理风险任务</h3>
          <p class="admin-subtitle">
            今日已统计 {{ serviceTotalCount }} 人，仍有 {{ serviceFollowUpCount }} 人需要继续跟进；任务池每 15 秒自动刷新一次。
          </p>
        </div>
        <div class="dashboard-command__side">
          <span class="admin-pill admin-pill--success">自动刷新 15s</span>
          <strong class="dashboard-command__value admin-code">{{ serviceFollowUpCount }}</strong>
          <span class="admin-copy">需跟进人员</span>
        </div>
      </article>

      <div class="admin-grid admin-grid--stats-4">
        <button class="dashboard-stat-button" @click="openBucket('completeUsers')">
          <StatTile
            :title="bucketMeta.completeUsers.title"
            :value="dashboard.serviceOverview.completeUsers.count"
            :hint="bucketMeta.completeUsers.hint"
            action-label="查看名单"
            :tone="bucketMeta.completeUsers.tone"
            :sparkline="completeUsersTrend"
            sparkline-label="近 7 日完全服务人数趋势"
          />
        </button>
        <button class="dashboard-stat-button" @click="openBucket('partialUsers')">
          <StatTile
            :title="bucketMeta.partialUsers.title"
            :value="dashboard.serviceOverview.partialUsers.count"
            :hint="bucketMeta.partialUsers.hint"
            action-label="查看名单"
            :tone="bucketMeta.partialUsers.tone"
            :sparkline="partialUsersTrend"
            sparkline-label="近 7 日部分服务人数趋势"
          />
        </button>
        <button class="dashboard-stat-button" @click="openBucket('unservedUsers')">
          <StatTile
            :title="bucketMeta.unservedUsers.title"
            :value="dashboard.serviceOverview.unservedUsers.count"
            :hint="bucketMeta.unservedUsers.hint"
            action-label="查看名单"
            :sparkline="unservedUsersTrend"
            sparkline-label="近 7 日未服务人数趋势"
          />
        </button>
        <StatTile
          title="待处理事件数"
          :value="dashboard.pendingTasks.length"
          hint="缺货、临期、设备异常与用户反馈"
          tone="warning"
          :sparkline="pendingTasksTrend"
          sparkline-label="近 7 日待处理事件趋势"
        />
      </div>

      <div class="dashboard-visual-grid">
        <article class="dashboard-chart-card admin-panel">
          <div class="admin-panel__head">
            <div>
              <span class="admin-kicker">服务趋势</span>
              <h3 class="admin-panel__title">今日服务与跟进走势</h3>
            </div>
            <span class="admin-pill admin-pill--success">实时</span>
          </div>
          <svg
            v-if="hasServiceTrendChart"
            class="dashboard-line-chart"
            viewBox="0 0 460 180"
            role="img"
            :aria-label="trendChartLabel"
          >
            <path class="dashboard-line-chart__grid" d="M22 32H438M22 72H438M22 112H438M22 152H438" />
            <path class="dashboard-line-chart__axis" d="M22 20V160H448" />
            <polyline
              v-if="servedTrendPlot.points"
              class="dashboard-line-chart__line dashboard-line-chart__line--main"
              :points="servedTrendPlot.points"
            />
            <polyline
              v-if="followUpTrendPlot.points"
              class="dashboard-line-chart__line dashboard-line-chart__line--sub"
              :points="followUpTrendPlot.points"
            />
            <g class="dashboard-line-chart__points dashboard-line-chart__points--main">
              <circle
                v-for="point in servedTrendPlot.markers"
                :key="`served-${point.label}`"
                :cx="point.x"
                :cy="point.y"
                r="3.2"
              >
                <title>{{ point.label }} 已服务 {{ point.value }} 人</title>
              </circle>
            </g>
            <g class="dashboard-line-chart__points dashboard-line-chart__points--sub">
              <circle
                v-for="point in followUpTrendPlot.markers"
                :key="`follow-${point.label}`"
                :cx="point.x"
                :cy="point.y"
                r="2.8"
              >
                <title>{{ point.label }} 需跟进 {{ point.value }} 人</title>
              </circle>
            </g>
          </svg>
          <div v-if="hasServiceTrendChart" class="dashboard-line-chart__labels">
            <span v-for="point in serviceTrend" :key="point.label">{{ point.label }}</span>
          </div>
          <div v-else class="admin-empty admin-empty--compact">
            <div class="admin-empty__title">暂无近 7 日服务趋势</div>
          </div>
          <div class="dashboard-chart-legend">
            <span><i class="dashboard-chart-legend__dot"></i>已服务人数（完全+部分）</span>
            <span><i class="dashboard-chart-legend__dot dashboard-chart-legend__dot--sub"></i>需跟进人数（部分+未服务）</span>
          </div>
        </article>

        <article class="dashboard-mix-card admin-panel">
          <div class="admin-panel__head">
            <div>
              <span class="admin-kicker">业务分布</span>
              <h3 class="admin-panel__title">服务完成度结构</h3>
            </div>
          </div>
          <div class="dashboard-mix-card__body">
            <div class="dashboard-donut" :style="serviceMixStyle">
              <span>{{ serviceTotalCount }}</span>
            </div>
            <div class="dashboard-mix-card__legend">
              <span><i></i>完全服务 {{ dashboard.serviceOverview.completeUsers.count }}</span>
              <span><i></i>部分服务 {{ dashboard.serviceOverview.partialUsers.count }}</span>
              <span><i></i>未服务 {{ dashboard.serviceOverview.unservedUsers.count }}</span>
            </div>
          </div>
        </article>

        <article class="dashboard-mini-card admin-panel">
          <div class="admin-panel__head">
            <div>
              <span class="admin-kicker">重点待办</span>
              <h3 class="admin-panel__title">高优先级任务</h3>
            </div>
          </div>
          <div v-if="highPriorityTasks.length" class="dashboard-mini-list">
            <button
              v-for="task in highPriorityTasks"
              :key="task.id"
              class="dashboard-mini-list__row"
              @click="openTaskDetail(task)"
            >
              <span>{{ task.title }}</span>
              <strong>{{ taskGradeLabel(task.grade) }}</strong>
            </button>
          </div>
          <div v-else class="admin-empty admin-empty--compact">
            <div class="admin-empty__title">没有高优先级任务</div>
          </div>
        </article>
      </div>

      <div class="dashboard-grade-strip">
        <div class="dashboard-grade-strip__item dashboard-grade-strip__item--danger">
          <span class="admin-kicker">故障</span>
          <strong class="admin-code">{{ dashboard.taskGradeSummary.fault }}</strong>
        </div>
        <div class="dashboard-grade-strip__item dashboard-grade-strip__item--warning">
          <span class="admin-kicker">反馈</span>
          <strong class="admin-code">{{ dashboard.taskGradeSummary.feedback }}</strong>
        </div>
        <div class="dashboard-grade-strip__item">
          <span class="admin-kicker">预警</span>
          <strong class="admin-code">{{ dashboard.taskGradeSummary.warning }}</strong>
        </div>
      </div>
    </section>

    <section class="admin-grid admin-grid--main-aside">
      <article class="admin-panel admin-panel-block">
        <div class="admin-panel__head">
          <div>
            <span class="admin-kicker">待处理事件</span>
            <h3 class="admin-panel__title">统一任务池</h3>
          </div>
          <span class="admin-pill admin-pill--warning">OPEN {{ pendingTasks.length }}</span>
        </div>

        <table v-if="pendingTasks.length" class="admin-table">
          <thead>
            <tr>
              <th>到期时间</th>
              <th>任务</th>
              <th>业务对象</th>
              <th>处理</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="task in pendingTasks" :key="task.id">
              <td class="admin-code">{{ formatDateTime(task.dueAt) }}</td>
              <td>
                <span class="admin-table__strong">{{ task.title }}</span>
                <span class="admin-table__subtext">分级：{{ taskGradeLabel(task.grade) }} · 状态：{{ task.status === "acknowledged" ? "已知晓" : "待处理" }}</span>
                <span class="admin-table__subtext">{{ task.previewDetail || task.detail }}</span>
              </td>
              <td>
                <span class="admin-context-main">{{ taskContextSummary(task) }}</span>
                <span v-if="taskIdentitySummary(task)" class="admin-context-meta admin-code">{{ taskIdentitySummary(task) }}</span>
                <span v-if="taskReferenceSummary(task)" class="admin-context-meta admin-code">{{ taskReferenceSummary(task) }}</span>
                <div class="dashboard-task-links">
                  <RouterLink v-if="task.deviceCode" class="admin-link" :to="`/operations/${task.deviceCode}`">
                    柜机
                  </RouterLink>
                  <RouterLink v-if="task.targetUserId" class="admin-link" :to="`/users/${task.targetUserId}`">
                    人员
                  </RouterLink>
                </div>
              </td>
              <td class="dashboard-task-cell">
                <div class="dashboard-task-actions">
                  <button class="admin-button admin-button--ghost" @click="openTaskDetail(task)">详情</button>
                  <RouterLink v-if="sessionStore.can('ai-insights:view')" class="admin-link" :to="resolveTaskAiLink(task)">
                    AI 分析
                  </RouterLink>
                  <button
                    v-if="canManageAlerts"
                    class="admin-button admin-button--ghost"
                    :disabled="resolvingTaskId === task.id"
                    @click="resolveTask(task.id)"
                  >
                    {{ resolvingTaskId === task.id ? "处理中" : taskActionLabel(task) }}
                  </button>
                  <span v-else class="admin-table__subtext">需要预警处理权限</span>
                </div>
              </td>
            </tr>
          </tbody>
        </table>
        <div v-else class="admin-empty">
          <div class="admin-empty__title">{{ loading ? "正在加载任务" : "当前没有待处理事件" }}</div>
          <div class="admin-empty__body">缺货、设备异常、临期和用户反馈会统一进入这里。</div>
        </div>
      </article>

      <aside class="admin-grid">
        <article class="admin-panel admin-panel-block">
          <div class="admin-panel__head">
            <div>
              <span class="admin-kicker">快速入口</span>
              <h3 class="admin-panel__title">货品、柜机与日志工作台</h3>
            </div>
          </div>

          <div class="admin-list">
            <div class="admin-list__row">
              <div class="admin-list__main">
                <span class="admin-list__title">货品总览</span>
                <span class="admin-table__subtext">查看各商品种类数量、柜机分布和货品预警模板。</span>
              </div>
              <RouterLink class="admin-link" to="/goods">打开</RouterLink>
            </div>
            <div class="admin-list__row">
              <div class="admin-list__main">
                <span class="admin-list__title">柜机监控</span>
                <span class="admin-table__subtext">按柜机查看门状态、库存和当前异常。</span>
              </div>
              <RouterLink class="admin-link" to="/operations">打开</RouterLink>
            </div>
            <div class="admin-list__row">
              <div class="admin-list__main">
                <span class="admin-list__title">日志总览</span>
                <span class="admin-table__subtext">按人、柜、货和事件查看动作日志。</span>
              </div>
              <RouterLink class="admin-link" to="/logs">打开</RouterLink>
            </div>
            <div v-if="sessionStore.can('ai-insights:view')" class="admin-list__row">
              <div class="admin-list__main">
                <span class="admin-list__title">AI 工作台</span>
                <span class="admin-table__subtext">生成异常诊断、日报、反馈草稿和策略建议。</span>
              </div>
              <RouterLink class="admin-link" to="/ai">打开</RouterLink>
            </div>
          </div>
        </article>
      </aside>
    </section>

    <section class="admin-page__section">
      <div class="admin-page__section-head">
        <div>
          <p class="admin-kicker">汇总日志</p>
          <h3 class="admin-page__section-title">货品调拨、告警与关键操作</h3>
        </div>
        <RouterLink class="admin-link" to="/logs">进入日志总览</RouterLink>
      </div>

      <article class="admin-panel admin-panel-block">
        <table v-if="summaryLogs.length" class="admin-table">
          <thead>
            <tr>
              <th>时间</th>
              <th>动作</th>
              <th>业务对象</th>
              <th>状态</th>
              <th>详情</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="log in summaryLogs" :key="log.id">
              <td class="admin-code">{{ formatDateTime(log.occurredAt) }}</td>
              <td>
                <div class="admin-context-main">
                  <RouterLink class="admin-link" :to="resolveLogLink(log)">{{ log.description }}</RouterLink>
                </div>
                <div class="dashboard-log-actor">
                  <RouterLink v-if="resolveActorRoute(log)" class="admin-link" :to="resolveActorRoute(log)!">
                    {{ log.actor.name }}
                  </RouterLink>
                  <span v-else>{{ log.actor.name }}</span>
                  <span class="admin-table__subtext">{{ formatActorTypeLabel(log.actor.type) }} · {{ formatLogCategoryLabel(log.category) }} · {{ log.type }}</span>
                </div>
              </td>
              <td>
                <span class="admin-context-main">{{ logContextSummary(log) }}</span>
                <span v-if="logSubjectSummary(log)" class="admin-context-meta">{{ logSubjectSummary(log) }}</span>
                <span v-if="logReferenceSummary(log)" class="admin-context-meta admin-code">{{ logReferenceSummary(log) }}</span>
                <div class="admin-inline-links">
                  <RouterLink
                    v-if="resolveSubjectLink(log.primarySubject)"
                    class="admin-link"
                    :to="resolveSubjectLink(log.primarySubject)!"
                  >
                    主体一
                  </RouterLink>
                  <RouterLink
                    v-if="resolveSubjectLink(log.secondarySubject)"
                    class="admin-link"
                    :to="resolveSubjectLink(log.secondarySubject)!"
                  >
                    主体二
                  </RouterLink>
                </div>
              </td>
              <td>
                <span class="admin-pill" :class="log.status === 'warning' ? 'admin-pill--warning' : log.status === 'failed' ? 'admin-pill--danger' : log.status === 'success' ? 'admin-pill--success' : 'admin-pill--neutral'">
                  {{ formatLogStatus(log.status) }}
                </span>
              </td>
              <td>
                <span class="admin-table__subtext">{{ log.detail }}</span>
                <RouterLink class="admin-link" :to="resolveLogLink(log)">详情</RouterLink>
              </td>
            </tr>
          </tbody>
        </table>
        <div v-else class="admin-empty">
          <div class="admin-empty__title">{{ loading ? "正在加载汇总日志" : "当前没有可展示日志" }}</div>
          <div class="admin-empty__body">补货、取货、异常和手工处理日志会显示在这里。</div>
        </div>
      </article>
    </section>

    <div v-if="activeBucket && activeBucketData" class="dashboard-drawer-backdrop">
      <article class="dashboard-drawer admin-panel">
        <div class="admin-panel__head">
          <div>
            <span class="admin-kicker">服务名单</span>
            <h3 class="admin-panel__title">{{ bucketMeta[activeBucket].title }}</h3>
          </div>
          <button class="admin-button admin-button--ghost" @click="closeBucket">关闭</button>
        </div>

        <table class="admin-table">
          <thead>
            <tr>
              <th>人员</th>
              <th>手机号</th>
              <th>片区</th>
              <th>完成度</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="person in activeBucketData.users" :key="person.userId">
              <td>
                <RouterLink class="admin-link" :to="`/users/${person.userId}`" @click="closeBucket">
                  {{ person.name }}
                </RouterLink>
              </td>
              <td class="admin-code">{{ person.phone }}</td>
              <td>{{ person.neighborhood ?? "-" }}</td>
              <td>
                <span class="admin-table__strong">{{ person.summary }}</span>
                <span class="admin-table__subtext">{{ person.fulfilledGoods }}/{{ person.totalGoods }}</span>
                <span
                  v-for="(detailLine, index) in person.detailLines ?? []"
                  :key="`${person.userId}-detail-${index}`"
                  class="admin-table__subtext"
                >
                  {{ detailLine }}
                </span>
              </td>
            </tr>
          </tbody>
        </table>
      </article>
    </div>

    <div v-if="activeTask" class="dashboard-drawer-backdrop">
      <article class="dashboard-drawer admin-panel">
        <div class="admin-panel__head">
          <div>
            <span class="admin-kicker">任务详情</span>
            <h3 class="admin-panel__title">{{ activeTask.title }}</h3>
          </div>
          <button class="admin-button admin-button--ghost" @click="closeTaskDetail">关闭</button>
        </div>
        <div class="admin-kv">
          <div class="admin-kv__row">
            <span class="admin-kv__label">分级</span>
            <span class="admin-kv__value">{{ taskGradeLabel(activeTask.grade) }}</span>
          </div>
          <div class="admin-kv__row">
            <span class="admin-kv__label">截止时间</span>
            <span class="admin-kv__value admin-code">{{ formatDateTime(activeTask.dueAt) }}</span>
          </div>
          <div class="admin-kv__row">
            <span class="admin-kv__label">完整备注</span>
            <span class="admin-kv__value">{{ activeTask.detail }}</span>
          </div>
        </div>
      </article>
    </div>
  </section>
</template>

<style scoped>
.dashboard-load-error {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 12px;
}

.dashboard-command {
  display: grid;
  grid-template-columns: minmax(0, 1fr) 190px;
  gap: 18px;
  align-items: stretch;
  padding: 18px;
  background:
    linear-gradient(135deg, rgba(31, 111, 91, 0.1), rgba(36, 95, 147, 0.06) 48%, rgba(255, 255, 255, 0) 100%),
    var(--admin-panel);
}

.dashboard-command__main {
  display: grid;
  align-content: center;
  gap: 8px;
}

.dashboard-command__title {
  margin: 0;
  font-size: 1.18rem;
  line-height: 1.28;
}

.dashboard-command__side {
  display: grid;
  align-content: center;
  justify-items: start;
  gap: 8px;
  padding-left: 18px;
  border-left: 1px solid var(--admin-line);
}

.dashboard-command__value {
  font-size: 2.2rem;
  line-height: 1;
  color: var(--admin-accent-strong);
}

.dashboard-stat-button {
  padding: 0;
  border: 0;
  background: transparent;
  cursor: pointer;
  text-align: left;
}

.dashboard-stat-button:hover :deep(.stat-tile),
.dashboard-stat-button:focus-visible :deep(.stat-tile) {
  border-color: var(--admin-line-strong);
  box-shadow: var(--admin-shadow-soft);
}

.dashboard-task-cell {
  width: 112px;
  white-space: nowrap;
}

.dashboard-task-actions {
  display: grid;
  gap: 8px;
}

.dashboard-task-links {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  margin-top: 6px;
}

.dashboard-log-actor {
  display: grid;
  gap: 4px;
  margin-top: 4px;
}

.dashboard-drawer-backdrop {
  position: fixed;
  inset: 0;
  z-index: 30;
  display: grid;
  justify-items: end;
  padding: 16px;
  background: rgba(21, 31, 43, 0.26);
}

.dashboard-drawer {
  width: min(520px, 100%);
  max-height: calc(100vh - 32px);
  display: grid;
  gap: 12px;
  padding: 14px;
  overflow: auto;
}

.dashboard-grade-strip {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 10px;
  margin-top: 2px;
}

.dashboard-visual-grid {
  display: grid;
  grid-template-columns: minmax(0, 1.42fr) minmax(240px, 0.62fr) minmax(260px, 0.78fr);
  gap: 12px;
}

.dashboard-chart-card,
.dashboard-mix-card,
.dashboard-mini-card {
  padding: 14px;
  min-width: 0;
}

.dashboard-line-chart {
  width: 100%;
  height: 170px;
  display: block;
}

.dashboard-line-chart__grid {
  fill: none;
  stroke: #edf2f4;
  stroke-width: 1;
}

.dashboard-line-chart__axis {
  fill: none;
  stroke: #ccd8da;
  stroke-width: 1.2;
}

.dashboard-line-chart__line {
  fill: none;
  stroke-linecap: round;
  stroke-linejoin: round;
  stroke-width: 3.2;
}

.dashboard-line-chart__line--main {
  stroke: var(--admin-accent);
}

.dashboard-line-chart__line--sub {
  stroke: var(--admin-warning);
  stroke-width: 2.4;
}

.dashboard-line-chart__points circle {
  fill: #fff;
  stroke-width: 2;
}

.dashboard-line-chart__points--main circle {
  stroke: var(--admin-accent);
}

.dashboard-line-chart__points--sub circle {
  stroke: var(--admin-warning);
}

.dashboard-line-chart__labels {
  display: grid;
  grid-template-columns: repeat(7, minmax(0, 1fr));
  gap: 4px;
  margin-top: -8px;
  padding: 0 18px 4px 20px;
  color: var(--admin-muted);
  font-family: var(--admin-code-font);
  font-size: 0.7rem;
  text-align: center;
}

.dashboard-chart-legend,
.dashboard-mix-card__legend {
  display: flex;
  flex-wrap: wrap;
  gap: 10px;
  color: var(--admin-muted);
  font-size: 0.8rem;
}

.dashboard-chart-legend__dot,
.dashboard-mix-card__legend i {
  display: inline-block;
  width: 8px;
  height: 8px;
  margin-right: 6px;
  border-radius: 999px;
  background: var(--admin-accent);
}

.dashboard-chart-legend__dot--sub,
.dashboard-mix-card__legend span:nth-child(3) i {
  background: var(--admin-warning);
}

.dashboard-mix-card__body {
  display: grid;
  grid-template-columns: 128px minmax(0, 1fr);
  gap: 14px;
  align-items: center;
}

.dashboard-donut {
  position: relative;
  width: 128px;
  aspect-ratio: 1;
  display: grid;
  place-items: center;
  border-radius: 50%;
  background: conic-gradient(
    var(--admin-accent-strong) 0 var(--service-complete),
    #14a39a var(--service-complete) var(--service-partial),
    var(--admin-warning) var(--service-partial) 100%
  );
}

.dashboard-donut span {
  width: 74px;
  height: 74px;
  display: grid;
  place-items: center;
  border-radius: 50%;
  background: #fff;
  color: var(--admin-text);
  font-family: var(--admin-code-font);
  font-size: 1.25rem;
  font-weight: 800;
}

.dashboard-mix-card__legend {
  display: grid;
  gap: 8px;
}

.dashboard-mix-card__legend span:nth-child(2) i {
  background: #14a39a;
}

.dashboard-mini-list {
  display: grid;
  gap: 8px;
}

.dashboard-mini-list__row {
  display: flex;
  justify-content: space-between;
  gap: 10px;
  width: 100%;
  padding: 9px 10px;
  border: 1px solid var(--admin-line);
  border-radius: 7px;
  background: #fff;
  color: var(--admin-text);
  text-align: left;
}

.dashboard-mini-list__row:hover {
  border-color: rgba(8, 91, 76, 0.28);
  background: #f7fbf9;
}

.dashboard-mini-list__row span {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.dashboard-mini-list__row strong {
  color: var(--admin-warning);
  white-space: nowrap;
}

.admin-empty--compact {
  min-height: 98px;
  align-content: center;
}

.dashboard-grade-strip__item {
  display: grid;
  gap: 4px;
  padding: 10px 12px;
  border: 1px solid var(--admin-line);
  border-radius: 8px;
  background: var(--admin-panel);
}

.dashboard-grade-strip__item--danger {
  border-color: rgba(198, 40, 40, 0.28);
  background: rgba(198, 40, 40, 0.06);
}

.dashboard-grade-strip__item--warning {
  border-color: rgba(237, 164, 32, 0.28);
  background: rgba(237, 164, 32, 0.06);
}

@media (max-width: 720px) {
  .dashboard-visual-grid,
  .dashboard-grade-strip {
    grid-template-columns: 1fr;
  }

  .dashboard-load-error,
  .dashboard-command {
    grid-template-columns: 1fr;
  }

  .dashboard-load-error {
    align-items: stretch;
  }

  .dashboard-command__side {
    padding-left: 0;
    padding-top: 12px;
    border-left: 0;
    border-top: 1px solid var(--admin-line);
  }

  .dashboard-drawer-backdrop {
    justify-items: stretch;
    padding: 0;
  }

  .dashboard-drawer {
    width: 100%;
    max-height: 100vh;
    border-radius: 0;
  }
}
</style>
