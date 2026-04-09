<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from "vue";
import { RouterLink, useRoute } from "vue-router";

import { adminApi } from "../api/admin";

const route = useRoute();

const detail = ref<Awaited<ReturnType<typeof adminApi.deviceDetail>>>();
const loading = ref(false);
const refreshing = ref(false);
const syncing = ref(false);
const remoteOpening = ref(false);
const resolvingTaskId = ref("");
const selectedDoorNum = ref("1");
const lastUpdatedAt = ref("");

let timer: ReturnType<typeof setInterval> | undefined;

const selectedDoorGoods = computed(() => {
  const device = detail.value?.device;

  if (!device) {
    return [];
  }

  if (!selectedDoorNum.value) {
    return device.doors.flatMap((door) => door.goods);
  }

  return device.doors.find((door) => door.doorNum === selectedDoorNum.value)?.goods ?? [];
});
const pendingTasks = computed(() => detail.value?.pendingTasks ?? []);
const recentEvents = computed(() => detail.value?.recentEvents ?? []);
const recentLogs = computed(() => detail.value?.recentLogs ?? []);
const businessDayServedUsers = computed(() => detail.value?.businessDayServedUsers ?? []);
const stockChangeMap = computed(
  () => new Map((detail.value?.stockChanges ?? []).map((item) => [item.goodsId, item]))
);

const formatDeviceStatus = (status?: "online" | "offline" | "maintenance") =>
  status === "online" ? "在线" : status === "maintenance" ? "维护中" : "离线";

const formatDoorState = (state?: "open" | "closed" | "unknown") =>
  state === "open" ? "门已开" : state === "closed" ? "门已关" : "门状态未知";

const formatEventStatus = (status: string) => {
  if (status === "created") return "已创建";
  if (status === "opening") return "开门中";
  if (status === "opened") return "门已开";
  if (status === "closed") return "门已关";
  if (status === "settled") return "已结算";
  if (status === "failed") return "失败";
  if (status === "timeout_unopened") return "超时未开门";
  if (status === "stuck_open") return "久开未关";
  if (status === "refunded") return "已退款";
  return status;
};

const formatLogStatus = (status: string) =>
  status === "success" ? "成功" : status === "warning" ? "预警" : status === "failed" ? "失败" : "待处理";

const formatUserRole = (role: "admin" | "merchant" | "special") =>
  role === "admin" ? "管理员" : role === "merchant" ? "商户" : "特殊群体";

const taskActionLabel = (task: NonNullable<typeof pendingTasks.value>[number]) =>
  task.grade === "fault" ? "标记已知晓" : "手动完成";

const taskGradeLabel = (grade: "fault" | "feedback" | "warning") =>
  grade === "fault" ? "故障" : grade === "feedback" ? "反馈" : "预警";

const load = async () => {
  loading.value = true;
  try {
    detail.value = await adminApi.deviceDetail(String(route.params.deviceCode));
    if (!detail.value.device.doors.some((door) => door.doorNum === selectedDoorNum.value)) {
      selectedDoorNum.value = detail.value.device.doors[0]?.doorNum ?? "1";
    }
    lastUpdatedAt.value = new Date().toLocaleString("zh-CN", { hour12: false });
  } finally {
    loading.value = false;
  }
};

const refreshDevice = async () => {
  refreshing.value = true;
  try {
    detail.value = await adminApi.refreshDevice(String(route.params.deviceCode));
    lastUpdatedAt.value = new Date().toLocaleString("zh-CN", { hour12: false });
  } finally {
    refreshing.value = false;
  }
};

const syncGoods = async () => {
  syncing.value = true;
  try {
    await adminApi.syncDeviceGoods(String(route.params.deviceCode), selectedDoorNum.value);
    await load();
  } finally {
    syncing.value = false;
  }
};

const remoteOpen = async () => {
  remoteOpening.value = true;
  try {
    await adminApi.remoteOpenDevice(String(route.params.deviceCode), selectedDoorNum.value);
    await load();
  } finally {
    remoteOpening.value = false;
  }
};

const resolveTask = async (taskId: string) => {
  const task = pendingTasks.value.find((entry) => entry.id === taskId);
  resolvingTaskId.value = taskId;
  try {
    await adminApi.resolveAlert(
      taskId,
      task?.grade === "fault" ? "管理员已知晓并接手处理" : "管理员手动完成"
    );
    await load();
  } finally {
    resolvingTaskId.value = "";
  }
};

watch(
  () => route.params.deviceCode,
  async () => {
    await load();
  }
);

onMounted(async () => {
  await load();
  timer = setInterval(load, 8_000);
});

onUnmounted(() => {
  if (timer) {
    clearInterval(timer);
  }
});
</script>

<template>
  <section class="admin-page">
    <section class="admin-page__section">
      <div class="admin-page__section-head">
        <div>
          <p class="admin-kicker">单柜机值守页</p>
          <h3 class="admin-page__section-title">{{ detail?.device.name ?? "加载中" }}</h3>
        </div>
        <div class="admin-toolbar">
          <span class="admin-copy">自动刷新 8 秒一次</span>
          <span class="admin-copy">最近刷新：{{ lastUpdatedAt || "尚未加载" }}</span>
        </div>
      </div>
    </section>

    <section v-if="detail" class="admin-grid">
      <article class="admin-panel admin-panel-block">
        <div class="device-detail-status">
          <div class="device-detail-status__item">
            <span class="admin-kicker">柜机状态</span>
            <strong>{{ formatDeviceStatus(detail.device.status) }}</strong>
            <span class="admin-table__subtext">{{ detail.device.deviceCode }}</span>
          </div>
          <div class="device-detail-status__item">
            <span class="admin-kicker">门状态</span>
            <strong>{{ formatDoorState(detail.runtime.doorState) }}</strong>
            <span class="admin-table__subtext">{{ detail.runtime.openedAfterLastCommand ? "已收到开门反馈" : "未收到开门反馈" }}</span>
          </div>
          <div class="device-detail-status__item">
            <span class="admin-kicker">最近开门</span>
            <strong class="admin-code">{{ detail.runtime.lastOpenedAt ? detail.runtime.lastOpenedAt.slice(0, 16).replace("T", " ") : "-" }}</strong>
            <span class="admin-table__subtext">最近关门：{{ detail.runtime.lastClosedAt ? detail.runtime.lastClosedAt.slice(0, 16).replace("T", " ") : "-" }}</span>
          </div>
          <div class="device-detail-status__item">
            <span class="admin-kicker">库存与服务</span>
            <strong class="admin-code">{{ detail.totalStock }} 件</strong>
            <span class="admin-table__subtext">累计服务 {{ detail.servedUsers }} 人 / 今日 {{ businessDayServedUsers.length }} 人</span>
          </div>
          <div class="device-detail-status__item">
            <span class="admin-kicker">待处理</span>
            <strong class="admin-code">{{ pendingTasks.length }} 项</strong>
            <span class="admin-table__subtext">最近心跳：{{ detail.device.lastSeenAt.slice(0, 16).replace("T", " ") }}</span>
          </div>
        </div>
      </article>

      <section class="admin-grid admin-grid--main-aside">
        <article class="admin-panel admin-panel-block">
          <div class="admin-panel__head">
            <div>
              <span class="admin-kicker">货品台账</span>
              <h3 class="admin-panel__title">本地库存由服务端维护，相对业务日起点显示变化量</h3>
            </div>
            <div class="admin-toolbar">
              <label class="admin-field admin-field--inline">
                <span class="admin-field__label">货门</span>
                <select v-model="selectedDoorNum" class="admin-select">
                  <option v-for="door in detail.device.doors" :key="door.doorNum" :value="door.doorNum">
                    {{ door.label }} / {{ door.doorNum }}
                  </option>
                </select>
              </label>
              <button class="admin-button admin-button--ghost" :disabled="syncing" @click="syncGoods">
                {{ syncing ? "同步中" : "同步货品种类" }}
              </button>
            </div>
          </div>

          <table class="admin-table">
            <thead>
              <tr>
                <th>货品</th>
                <th>分类</th>
                <th>库存</th>
                <th>今日变化</th>
                <th>阈值</th>
                <th>临期</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="goods in selectedDoorGoods" :key="goods.goodsId">
                <td>
                  <span class="admin-table__strong">{{ goods.name }}</span>
                  <span class="admin-table__subtext">{{ goods.goodsId }}</span>
                </td>
                <td>{{ goods.category }}</td>
                <td>
                  <span class="admin-pill" :class="goods.stock <= 0 ? 'admin-pill--danger' : goods.stock <= 2 ? 'admin-pill--warning' : 'admin-pill--success'">
                    {{ goods.stock }}
                  </span>
                </td>
                <td>
                  <span
                    class="admin-pill"
                    :class="(stockChangeMap.get(goods.goodsId)?.deltaSinceStartOfBusinessDay ?? 0) >= 0 ? 'admin-pill--success' : 'admin-pill--warning'"
                  >
                    {{ (stockChangeMap.get(goods.goodsId)?.deltaSinceStartOfBusinessDay ?? 0) >= 0 ? "+" : "" }}{{ stockChangeMap.get(goods.goodsId)?.deltaSinceStartOfBusinessDay ?? 0 }}
                  </span>
                </td>
                <td>
                  <span v-if="stockChangeMap.get(goods.goodsId)?.thresholdEnabled" class="admin-code">
                    {{ stockChangeMap.get(goods.goodsId)?.lowStockThreshold }}
                  </span>
                  <span v-else class="admin-table__subtext">未启用</span>
                </td>
                <td class="admin-code">
                  {{ stockChangeMap.get(goods.goodsId)?.nearestExpiryAt ? stockChangeMap.get(goods.goodsId)?.nearestExpiryAt?.slice(0, 16).replace("T", " ") : "-" }}
                </td>
              </tr>
            </tbody>
          </table>
        </article>

        <aside class="admin-grid">
          <article class="admin-panel admin-panel-block">
            <div class="admin-panel__head">
              <div>
                <span class="admin-kicker">今日服务人员</span>
                <h3 class="admin-panel__title">业务日 {{ detail.businessDateKey }} 内的领取 / 补货情况</h3>
              </div>
            </div>
            <table v-if="businessDayServedUsers.length" class="admin-table">
              <thead>
                <tr>
                  <th>人员</th>
                  <th>商品</th>
                  <th>数量</th>
                  <th>最近时间</th>
                </tr>
              </thead>
              <tbody>
                <tr v-for="entry in businessDayServedUsers" :key="entry.userId">
                  <td>
                    <RouterLink class="admin-link" :to="`/users/${entry.userId}`">{{ entry.userName }}</RouterLink>
                    <span class="admin-table__subtext">{{ formatUserRole(entry.role) }}</span>
                  </td>
                  <td>{{ entry.goodsSummary }}</td>
                  <td class="admin-code">{{ entry.totalQuantity }}</td>
                  <td class="admin-code">{{ entry.lastServedAt.slice(0, 16).replace("T", " ") }}</td>
                </tr>
              </tbody>
            </table>
            <div v-else class="admin-empty">
              <div class="admin-empty__title">今日还没有人员操作这台柜机</div>
              <div class="admin-empty__body">领取、补货和手工补扣都会在这里汇总。</div>
            </div>
          </article>

          <article class="admin-panel admin-panel-block">
            <div class="admin-panel__head">
              <div>
                <span class="admin-kicker">控制区</span>
                <h3 class="admin-panel__title">主动刷新与远程开门</h3>
              </div>
            </div>
            <div class="device-detail-actions">
              <button class="admin-button admin-button--ghost" :disabled="refreshing" @click="refreshDevice">
                {{ refreshing ? "刷新中" : "立即刷新" }}
              </button>
              <button class="admin-button" :disabled="remoteOpening" @click="remoteOpen">
                {{ remoteOpening ? "下发中" : "远程开门" }}
              </button>
            </div>
            <div class="admin-note">
              若门状态长时间不变化或最近一次开门后未收到开门确认，请直接关注右侧待处理任务。
            </div>
          </article>

          <article class="admin-panel admin-panel-block">
            <div class="admin-panel__head">
              <div>
                <span class="admin-kicker">待处理任务</span>
                <h3 class="admin-panel__title">故障、缺货、反馈统一处理</h3>
              </div>
            </div>
            <div v-if="pendingTasks.length" class="admin-list">
              <div v-for="task in pendingTasks" :key="task.id" class="admin-list__row">
                <div class="admin-list__main">
                  <span class="admin-list__title">{{ task.title }}</span>
                  <span class="admin-list__meta">
                    {{ taskGradeLabel(task.grade) }} · {{ task.status === "acknowledged" ? "已知晓" : "待处理" }} · {{ task.dueAt.slice(0, 16).replace("T", " ") }}
                  </span>
                  <span class="admin-table__subtext">{{ task.detail }}</span>
                </div>
                <div class="device-task-actions">
                  <button
                    v-if="task.status === 'open'"
                    class="admin-button admin-button--ghost"
                    :disabled="resolvingTaskId === task.id"
                    @click="resolveTask(task.id)"
                  >
                    {{ resolvingTaskId === task.id ? "处理中" : taskActionLabel(task) }}
                  </button>
                  <span v-else class="admin-table__subtext">已知晓</span>
                  <RouterLink class="admin-link" :to="`/logs?subjectType=alert&subjectId=${task.id}`">日志</RouterLink>
                </div>
              </div>
            </div>
            <div v-else class="admin-empty">
              <div class="admin-empty__title">当前没有待处理任务</div>
              <div class="admin-empty__body">低库存、长时间敞门和用户反馈会显示在这里。</div>
            </div>
          </article>

          <article class="admin-panel admin-panel-block">
            <div class="admin-panel__head">
              <div>
                <span class="admin-kicker">最近开柜事件</span>
                <h3 class="admin-panel__title">按时间倒序查看</h3>
              </div>
            </div>
            <table v-if="recentEvents.length" class="admin-table">
              <thead>
                <tr>
                  <th>订单</th>
                  <th>状态</th>
                  <th>时间</th>
                </tr>
              </thead>
              <tbody>
                <tr v-for="event in recentEvents" :key="event.eventId">
                  <td>
                    <span class="admin-table__strong">{{ event.orderNo }}</span>
                    <span class="admin-table__subtext">{{ event.eventId }}</span>
                  </td>
                  <td>{{ formatEventStatus(event.status) }}</td>
                  <td>
                    <span class="admin-code">{{ event.updatedAt.slice(0, 16).replace("T", " ") }}</span>
                    <RouterLink class="admin-table__subtext admin-link" :to="`/logs?subjectType=event&subjectId=${event.eventId}`">
                      查看关联日志
                    </RouterLink>
                  </td>
                </tr>
              </tbody>
            </table>
            <div v-else class="admin-empty">
              <div class="admin-empty__title">{{ loading ? "正在加载事件" : "当前没有开柜事件" }}</div>
              <div class="admin-empty__body">远程开门、用户取货和商户补货都会在这里记录。</div>
            </div>
          </article>
        </aside>
      </section>

      <section class="admin-page__section">
        <div class="admin-page__section-head">
          <div>
            <p class="admin-kicker">柜机日志</p>
            <h3 class="admin-page__section-title">查看该柜机的全部关键操作和异常</h3>
          </div>
          <RouterLink class="admin-link" :to="`/logs?subjectType=device&subjectId=${detail.device.deviceCode}`">进入日志总览</RouterLink>
        </div>

        <article class="admin-panel admin-panel-block">
          <table v-if="recentLogs.length" class="admin-table">
            <thead>
              <tr>
                <th>时间</th>
                <th>动作</th>
                <th>状态</th>
                <th>详情</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="log in recentLogs" :key="log.id">
                <td class="admin-code">{{ log.occurredAt.slice(0, 16).replace("T", " ") }}</td>
                <td>
                  <span class="admin-table__strong">{{ log.description }}</span>
                  <span class="admin-table__subtext">{{ log.detail }}</span>
                </td>
                <td>
                  <span class="admin-pill" :class="log.status === 'warning' ? 'admin-pill--warning' : log.status === 'failed' ? 'admin-pill--danger' : log.status === 'success' ? 'admin-pill--success' : 'admin-pill--neutral'">
                    {{ formatLogStatus(log.status) }}
                  </span>
                </td>
                <td>
                  <RouterLink class="admin-link" :to="`/logs/${log.id}`">详情</RouterLink>
                </td>
              </tr>
            </tbody>
          </table>
          <div v-else class="admin-empty">
            <div class="admin-empty__title">当前没有柜机日志</div>
            <div class="admin-empty__body">刷新、远程开门、故障回调和货物流动会自动记录在这里。</div>
          </div>
        </article>
      </section>
    </section>
  </section>
</template>

<style scoped>
.device-detail-status {
  display: grid;
  grid-template-columns: repeat(5, minmax(0, 1fr));
  gap: 8px;
}

.device-detail-status__item {
  display: grid;
  gap: 6px;
  padding: 10px 12px;
  border: 1px solid var(--admin-line);
  border-radius: 8px;
  background: var(--admin-panel-muted);
}

.device-detail-actions {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 8px;
}

.device-task-actions {
  display: grid;
  justify-items: end;
  gap: 6px;
}

.admin-field--inline {
  min-width: 160px;
}

@media (max-width: 1280px) {
  .device-detail-status {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }
}

@media (max-width: 720px) {
  .device-detail-status,
  .device-detail-actions {
    grid-template-columns: 1fr;
  }
}
</style>
