<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from "vue";
import { RouterLink } from "vue-router";
import type { DashboardSnapshot, OperationLogRecord } from "@vm/shared-types";

import { adminApi } from "../api/admin";
import StatTile from "../components/StatTile.vue";
import { resolveActorLink, resolveSubjectLink } from "../utils/entity-links";
import { formatDateTime } from "../utils/datetime";

type BucketKey = "completeUsers" | "partialUsers" | "unservedUsers";

const dashboard = ref<DashboardSnapshot>();
const loading = ref(false);
const activeBucket = ref<BucketKey>();
const resolvingTaskId = ref<string>();
const activeTask = ref<NonNullable<typeof pendingTasks.value>[number]>();
let timer: ReturnType<typeof setInterval> | undefined;
let visibilityHandler: (() => void) | undefined;

const summaryLogs = computed(() => dashboard.value?.summaryLogs ?? []);
const pendingTasks = computed(() => dashboard.value?.pendingTasks ?? []);

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
  const task = pendingTasks.value.find((entry) => entry.id === id);

  if (!task) {
    return;
  }

  const confirmed = window.confirm(task.grade === "fault" ? "确认标记为已知晓？" : "确认手动完成这条待办？");

  if (!confirmed) {
    return;
  }

  resolvingTaskId.value = id;
  try {
    await adminApi.resolveAlert(
      id,
      task?.grade === "fault" ? "管理员已知晓并接手处理" : "管理员手动完成"
    );
    await load();
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
    <section v-if="dashboard" class="admin-page__section">
      <div class="admin-grid admin-grid--stats-4">
        <button class="dashboard-stat-button" @click="openBucket('completeUsers')">
          <StatTile
            :title="bucketMeta.completeUsers.title"
            :value="dashboard.serviceOverview.completeUsers.count"
            :hint="bucketMeta.completeUsers.hint"
            action-label="展开名单 >"
            :tone="bucketMeta.completeUsers.tone"
          />
        </button>
        <button class="dashboard-stat-button" @click="openBucket('partialUsers')">
          <StatTile
            :title="bucketMeta.partialUsers.title"
            :value="dashboard.serviceOverview.partialUsers.count"
            :hint="bucketMeta.partialUsers.hint"
            action-label="展开名单 >"
            :tone="bucketMeta.partialUsers.tone"
          />
        </button>
        <button class="dashboard-stat-button" @click="openBucket('unservedUsers')">
          <StatTile
            :title="bucketMeta.unservedUsers.title"
            :value="dashboard.serviceOverview.unservedUsers.count"
            :hint="bucketMeta.unservedUsers.hint"
            action-label="展开名单 >"
          />
        </button>
        <StatTile
          title="待处理事件数"
          :value="dashboard.pendingTasks.length"
          hint="缺货、临期、设备异常与用户反馈"
          tone="warning"
        />
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
              <th>柜机</th>
              <th>人员</th>
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
                <RouterLink v-if="task.deviceCode" class="admin-link" :to="`/operations/${task.deviceCode}`">
                  {{ task.deviceCode }}
                </RouterLink>
                <span v-else>-</span>
              </td>
              <td>
                <RouterLink v-if="task.targetUserId" class="admin-link" :to="`/users/${task.targetUserId}`">
                  {{ task.targetUserId }}
                </RouterLink>
                <span v-else>-</span>
              </td>
              <td class="dashboard-task-cell">
                <div class="dashboard-task-actions">
                  <button class="admin-button admin-button--ghost" @click="openTaskDetail(task)">详情</button>
                  <RouterLink class="admin-link" :to="resolveTaskAiLink(task)">AI 分析</RouterLink>
                  <button
                    class="admin-button admin-button--ghost"
                    :disabled="resolvingTaskId === task.id"
                    @click="resolveTask(task.id)"
                  >
                    {{ resolvingTaskId === task.id ? "处理中" : taskActionLabel(task) }}
                  </button>
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
              <h3 class="admin-panel__title">货物、柜机与日志工作台</h3>
            </div>
          </div>

          <div class="admin-list">
            <div class="admin-list__row">
              <div class="admin-list__main">
                <span class="admin-list__title">货物总览</span>
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
            <div class="admin-list__row">
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
          <h3 class="admin-page__section-title">货物调动、告警与关键操作</h3>
        </div>
        <RouterLink class="admin-link" to="/logs">进入日志总览</RouterLink>
      </div>

      <article class="admin-panel admin-panel-block">
        <table v-if="summaryLogs.length" class="admin-table">
          <thead>
            <tr>
              <th>时间</th>
              <th>动作</th>
              <th>动作人</th>
              <th>主体</th>
              <th>状态</th>
              <th>详情</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="log in summaryLogs" :key="log.id">
              <td class="admin-code">{{ formatDateTime(log.occurredAt) }}</td>
              <td>
                <RouterLink class="admin-link" :to="resolveLogLink(log)">{{ log.description }}</RouterLink>
                <span class="admin-table__subtext">{{ log.detail }}</span>
              </td>
              <td>
                <RouterLink v-if="resolveActorRoute(log)" class="admin-link" :to="resolveActorRoute(log)!">
                  {{ log.actor.name }}
                </RouterLink>
                <span v-else>{{ log.actor.name }}</span>
                <span class="admin-table__subtext">{{ log.actor.type }} · {{ log.type }}</span>
              </td>
              <td>
                <div class="admin-inline-links">
                  <RouterLink
                    v-if="resolveSubjectLink(log.primarySubject)"
                    class="admin-link"
                    :to="resolveSubjectLink(log.primarySubject)!"
                  >
                    {{ log.primarySubject?.label }}
                  </RouterLink>
                  <RouterLink
                    v-if="resolveSubjectLink(log.secondarySubject)"
                    class="admin-link"
                    :to="resolveSubjectLink(log.secondarySubject)!"
                  >
                    {{ log.secondarySubject?.label }}
                  </RouterLink>
                  <span v-if="!log.primarySubject && !log.secondarySubject">-</span>
                </div>
              </td>
              <td>
                <span class="admin-pill" :class="log.status === 'warning' ? 'admin-pill--warning' : log.status === 'failed' ? 'admin-pill--danger' : log.status === 'success' ? 'admin-pill--success' : 'admin-pill--neutral'">
                  {{ formatLogStatus(log.status) }}
                </span>
              </td>
              <td>
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

    <div v-if="activeBucket && activeBucketData" class="dashboard-drawer-backdrop" @click.self="closeBucket">
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

    <div v-if="activeTask" class="dashboard-drawer-backdrop" @click.self="closeTaskDetail">
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
.dashboard-stat-button {
  padding: 0;
  border: 0;
  background: transparent;
  cursor: pointer;
  text-align: left;
}

.dashboard-task-cell {
  width: 112px;
  white-space: nowrap;
}

.dashboard-task-actions {
  display: grid;
  gap: 8px;
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
  gap: 8px;
  margin-top: 10px;
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
  .dashboard-grade-strip {
    grid-template-columns: 1fr;
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
