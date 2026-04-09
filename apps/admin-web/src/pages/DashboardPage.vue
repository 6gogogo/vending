<script setup lang="ts">
import { computed, onMounted, ref } from "vue";
import { RouterLink } from "vue-router";
import type { DashboardSnapshot, OperationLogRecord } from "@vm/shared-types";

import { adminApi } from "../api/admin";
import StatTile from "../components/StatTile.vue";
import { resolveActorLink, resolveSubjectLink } from "../utils/entity-links";

type BucketKey = "completeUsers" | "partialUsers" | "unservedUsers";

const dashboard = ref<DashboardSnapshot>();
const loading = ref(false);
const activeBucket = ref<BucketKey>();
const resolvingTaskId = ref<string>();

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

const load = async () => {
  loading.value = true;
  try {
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

const resolveTask = async (id: string) => {
  resolvingTaskId.value = id;
  try {
    await adminApi.resolveAlert(id, "管理员手动完成");
    await load();
  } finally {
    resolvingTaskId.value = undefined;
  }
};

onMounted(load);
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
              <td class="admin-code">{{ task.dueAt.slice(0, 16).replace("T", " ") }}</td>
              <td>
                <span class="admin-table__strong">{{ task.title }}</span>
                <span class="admin-table__subtext">{{ task.detail }}</span>
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
                <button
                  class="admin-button admin-button--ghost"
                  :disabled="resolvingTaskId === task.id"
                  @click="resolveTask(task.id)"
                >
                  {{ resolvingTaskId === task.id ? "处理中" : "手动完成" }}
                </button>
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
              <td class="admin-code">{{ log.occurredAt.slice(0, 16).replace("T", " ") }}</td>
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
              </td>
            </tr>
          </tbody>
        </table>
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

@media (max-width: 720px) {
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
