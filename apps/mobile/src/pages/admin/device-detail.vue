<script setup lang="ts">
import { computed, ref } from "vue";
import { onLoad } from "@dcloudio/uni-app";

import type { DeviceMonitoringDetail } from "@vm/shared-types";

import { mobileApi } from "../../api/mobile";
import EmptyState from "../../components/ui/EmptyState.vue";
import GlassCard from "../../components/ui/GlassCard.vue";
import ServiceMetric from "../../components/ui/ServiceMetric.vue";
import MobileShell from "../../layouts/MobileShell.vue";
import { formatBeijingDateTime } from "../../utils/datetime";
import { showOperationFailure, showOperationSuccess } from "../../utils/operation-feedback";
import { useSessionStore } from "../../stores/session";

const sessionStore = useSessionStore();
const loading = ref(false);
const deviceCode = ref("");
const detail = ref<DeviceMonitoringDetail>();
const resolvingTaskIds = ref<string[]>([]);
const refreshing = ref(false);

const servedCount = computed(() => detail.value?.businessDayServedUsers.length ?? 0);
const stockChangeCount = computed(() => detail.value?.stockChanges.length ?? 0);
const pendingTaskCount = computed(() => detail.value?.pendingTasks.length ?? 0);
const faultTaskCount = computed(() =>
  detail.value?.pendingTasks.filter((task) => task.grade === "fault").length ?? 0
);

const lastOpenedText = computed(() =>
  formatBeijingDateTime(detail.value?.runtime.lastOpenedAt, "暂无")
);

const lastClosedText = computed(() =>
  formatBeijingDateTime(detail.value?.runtime.lastClosedAt, "暂无")
);

const lastCommandText = computed(() =>
  formatBeijingDateTime(detail.value?.runtime.lastCommandAt, "暂无")
);
const operationOpenBlockedHint = computed(() => {
  if (!detail.value) {
    return "柜机状态尚未加载。";
  }

  const readiness = detail.value.device.readiness;
  const readinessAllowsOpen =
    readiness?.blocker === "door_unconfirmed"
      ? detail.value.device.status === "online"
      : (readiness?.canOpen ?? detail.value.device.status === "online");

  if (!readinessAllowsOpen) {
    return "柜机当前离线、维护中或状态已过期，请先刷新并排查连接。";
  }

  if (detail.value.runtime.doorState === "open") {
    return "柜门当前已开启，请等待关门。";
  }

  return "";
});

const load = async () => {
  await sessionStore.bootstrap();

  if (!sessionStore.user || sessionStore.user.role !== "admin" || !deviceCode.value) {
    uni.reLaunch({ url: "/pages/common/login" });
    return;
  }

  loading.value = true;
  try {
    detail.value = await mobileApi.deviceMonitoring(deviceCode.value);
  } catch (error) {
    showOperationFailure(error);
  } finally {
    loading.value = false;
  }
};

const refresh = async () => {
  if (refreshing.value) {
    return;
  }

  refreshing.value = true;
  try {
    detail.value = await mobileApi.refreshDevice(deviceCode.value);
    showOperationSuccess("柜机状态已刷新");
  } catch (error) {
    showOperationFailure(error);
  } finally {
    refreshing.value = false;
  }
};

const openOperationFlow = () => {
  if (operationOpenBlockedHint.value) {
    uni.showModal({
      title: "暂不能运营开门",
      content: operationOpenBlockedHint.value,
      showCancel: false
    });
    return;
  }

  uni.navigateTo({
    url: `/pages/common/operation-open?deviceCode=${encodeURIComponent(deviceCode.value)}`
  });
};

const showTaskDetail = (title: string, detailText: string) => {
  uni.showModal({
    title,
    content: detailText,
    showCancel: false
  });
};

const resolveTask = async (id: string, isFault: boolean) => {
  if (resolvingTaskIds.value.includes(id)) {
    return;
  }

  uni.showModal({
    title: "确认处理",
    content: isFault ? "确认标记为已知晓？该任务仍会保留为需继续跟进的故障状态。" : "确认手动完成这条待办？完成后会移入已处理记录。",
    success: async ({ confirm }) => {
      if (!confirm) {
        return;
      }

      resolvingTaskIds.value = [...resolvingTaskIds.value, id];
      try {
        await mobileApi.resolveAlert(id, isFault ? "管理员已知晓并接手处理。" : "管理员已手动完成。");
        showOperationSuccess(isFault ? "已标记为知晓" : "待办已完成");
        await load();
      } catch (error) {
        showOperationFailure(error);
      } finally {
        resolvingTaskIds.value = resolvingTaskIds.value.filter((taskId) => taskId !== id);
      }
    }
  });
};

const openLog = (logId: string) => {
  uni.navigateTo({
    url: `/pages/admin/log-detail?id=${logId}`
  });
};

onLoad((query) => {
  deviceCode.value = typeof query.deviceCode === "string" ? query.deviceCode : "";
  load();
});
</script>

<template>
  <MobileShell eyebrow="柜机详情" :title="detail?.device.name ?? deviceCode" :subtitle="detail?.device.location ?? '正在加载柜机详情'">
    <template #hero-actions>
      <view class="hero-action-grid">
        <button class="vm-button" :loading="refreshing" :disabled="refreshing" @tap="refresh">手动刷新</button>
        <button class="vm-button vm-button--ghost" :disabled="Boolean(operationOpenBlockedHint)" @tap="openOperationFlow">
          运营开门
        </button>
      </view>
      <text v-if="operationOpenBlockedHint" class="vm-subtitle">{{ operationOpenBlockedHint }}</text>
    </template>

    <GlassCard tone="accent">
      <view class="vm-stack">
        <view class="section-heading">
          <text class="section-heading__title">运行概览</text>
          <text class="vm-subtitle">请先查看实时状态和待处理任务。</text>
        </view>

        <view class="metric-grid">
          <ServiceMetric label="今日服务人数" :value="servedCount" hint="当天已服务的用户数" />
          <ServiceMetric label="待处理任务" :value="pendingTaskCount" hint="故障、预警与人工待办" tone="warning" />
          <ServiceMetric label="库存变化项" :value="stockChangeCount" hint="相对业务日起点的库存变化" />
        </view>

        <view class="runtime-panel">
          <view class="runtime-row">
            <text class="runtime-row__label">柜机编号</text>
            <text class="runtime-row__value">{{ detail?.device.deviceCode ?? deviceCode }}</text>
          </view>
          <view class="runtime-row">
            <text class="runtime-row__label">门状态</text>
            <text class="vm-status" :class="detail?.runtime.doorState === 'open' ? 'vm-status--warning' : 'vm-status--online'">
              {{ detail?.runtime.doorState ?? "unknown" }}
            </text>
          </view>
          <view class="runtime-row">
            <text class="runtime-row__label">最近开门指令</text>
            <text class="runtime-row__value">{{ lastCommandText }}</text>
          </view>
          <view class="runtime-row">
            <text class="runtime-row__label">最近开门</text>
            <text class="runtime-row__value">{{ lastOpenedText }}</text>
          </view>
          <view class="runtime-row">
            <text class="runtime-row__label">最近关门</text>
            <text class="runtime-row__value">{{ lastClosedText }}</text>
          </view>
          <view class="runtime-row">
            <text class="runtime-row__label">故障待办</text>
            <text class="runtime-row__value">{{ faultTaskCount }} 条</text>
          </view>
        </view>
      </view>
    </GlassCard>

    <GlassCard tone="quiet">
      <view class="vm-stack">
        <view class="section-heading">
          <text class="section-heading__title">今日服务人员</text>
          <text class="vm-subtitle">这里会显示今天在这台柜机完成过操作的人员。</text>
        </view>

        <view v-if="detail?.businessDayServedUsers.length" class="list-block">
          <view v-for="item in detail?.businessDayServedUsers" :key="item.userId" class="list-item">
            <text class="list-item__title">{{ item.userName }}</text>
            <text class="list-item__meta">{{ item.goodsSummary }} · {{ formatBeijingDateTime(item.lastServedAt) }}</text>
          </view>
        </view>
        <EmptyState v-else :title="loading ? '正在加载数据' : '今日还没有服务记录'" description="用户、商家或管理员对该柜机有操作后，这里会实时更新。" />
      </view>
    </GlassCard>

    <GlassCard tone="warning">
      <view class="vm-stack">
        <view class="section-heading">
          <text class="section-heading__title">库存变化与阈值</text>
          <text class="vm-subtitle">请优先关注低库存和已开启阈值提醒的货品。</text>
        </view>

        <view v-if="detail?.stockChanges.length" class="list-block">
          <view v-for="item in detail?.stockChanges" :key="item.goodsId" class="list-item">
            <text class="list-item__title">{{ item.goodsName }}</text>
            <text class="list-item__meta">
              当前 {{ item.currentStock }} 件 · 相对业务日起点 {{ item.deltaSinceStartOfBusinessDay >= 0 ? "+" : "" }}{{ item.deltaSinceStartOfBusinessDay }}
            </text>
            <text class="list-item__meta">
              {{ item.thresholdEnabled ? `已开启阈值 ${item.lowStockThreshold}` : "未开启阈值提醒" }}
            </text>
          </view>
        </view>
        <EmptyState v-else :title="loading ? '正在加载库存变化' : '当前没有库存变化项'" description="柜机发生补货、领取或清点后，这里会同步更新。" />
      </view>
    </GlassCard>

    <GlassCard tone="quiet">
      <view class="vm-stack">
        <view class="section-heading">
          <text class="section-heading__title">待处理任务</text>
          <text class="vm-subtitle">可先查看详情，再确认处理动作。</text>
        </view>

        <view v-if="detail?.pendingTasks.length" class="list-block">
          <view v-for="task in detail?.pendingTasks" :key="task.id" class="list-item">
            <view class="task-head">
              <text class="list-item__title">{{ task.title }}</text>
              <text class="vm-status" :class="task.grade === 'fault' ? 'vm-status--danger' : 'vm-status--warning'">
                {{ task.grade === "fault" ? "故障" : "待办" }}
              </text>
            </view>
            <text class="list-item__meta">{{ task.previewDetail || task.detail }}</text>
            <view class="task-actions">
              <button class="vm-button vm-button--ghost" @tap="showTaskDetail(task.title, task.detail)">查看详情</button>
              <button
                class="vm-button vm-button--ghost"
                :disabled="resolvingTaskIds.includes(task.id)"
                :loading="resolvingTaskIds.includes(task.id)"
                @tap="resolveTask(task.id, task.grade === 'fault')"
              >
                {{ resolvingTaskIds.includes(task.id) ? "处理中" : task.grade === "fault" ? "标记已知晓" : "手动完成" }}
              </button>
            </view>
          </view>
        </view>
        <EmptyState v-else :title="loading ? '正在加载任务' : '当前没有待处理任务'" description="新的故障、回调和预警会同步出现在这里。" />
      </view>
    </GlassCard>

    <GlassCard tone="quiet">
      <view class="vm-stack">
        <view class="section-heading">
          <text class="section-heading__title">相关日志</text>
          <text class="vm-subtitle">这里会显示这台柜机最近的相关记录，点击可查看详情。</text>
        </view>

        <view v-if="detail?.recentLogs.length" class="list-block">
          <button v-for="log in detail?.recentLogs" :key="log.id" class="list-item list-item--button" @tap="openLog(log.id)">
            <text class="list-item__title">{{ log.description }}</text>
            <text class="list-item__meta">{{ formatBeijingDateTime(log.occurredAt) }}</text>
          </button>
        </view>
        <EmptyState v-else :title="loading ? '正在加载日志' : '当前没有相关日志'" description="柜机产生新的业务动作后，这里会同步展示。" />
      </view>
    </GlassCard>
  </MobileShell>
</template>

<style scoped>
.section-heading {
  display: flex;
  flex-direction: column;
  gap: 12rpx;
}

.section-heading__title,
.list-item__title {
  font-size: 30rpx;
  font-weight: 700;
  color: var(--vm-text);
}

.list-item__meta,
.runtime-row__label {
  font-size: 22rpx;
  color: var(--vm-text-soft);
  line-height: 1.6;
}

.hero-action-grid,
.metric-grid,
.list-block,
.task-actions {
  display: grid;
  gap: 16rpx;
}

.runtime-panel,
.list-item {
  display: grid;
  gap: 12rpx;
  padding: 22rpx 24rpx;
  border-radius: 24rpx;
  background: var(--vm-surface-soft);
  border: 1rpx solid var(--vm-line);
}

.runtime-row,
.task-head {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 16rpx;
}

.runtime-row__value {
  font-size: 26rpx;
  color: var(--vm-text);
}

.list-item--button {
  text-align: left;
}
</style>

