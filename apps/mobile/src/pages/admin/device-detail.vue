<script setup lang="ts">
import { ref } from "vue";
import { onLoad } from "@dcloudio/uni-app";

import type { DeviceMonitoringDetail } from "@vm/shared-types";

import { mobileApi } from "../../api/mobile";
import EmptyState from "../../components/ui/EmptyState.vue";
import GlassCard from "../../components/ui/GlassCard.vue";
import MobileShell from "../../layouts/MobileShell.vue";
import { showOperationFailure, showOperationSuccess } from "../../utils/operation-feedback";
import { useSessionStore } from "../../stores/session";

const sessionStore = useSessionStore();
const loading = ref(false);
const opening = ref(false);
const deviceCode = ref("");
const detail = ref<DeviceMonitoringDetail>();

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
  try {
    detail.value = await mobileApi.refreshDevice(deviceCode.value);
  } catch (error) {
    showOperationFailure(error);
  }
};

const remoteOpen = async () => {
  opening.value = true;
  try {
    await mobileApi.remoteOpenDevice(deviceCode.value);
    await load();
    showOperationSuccess();
  } catch (error) {
    showOperationFailure(error);
  } finally {
    opening.value = false;
  }
};

const showTaskDetail = (title: string, detailText: string) => {
  uni.showModal({
    title,
    content: detailText,
    showCancel: false
  });
};

const resolveTask = async (id: string, title: string, isFault: boolean) => {
  uni.showModal({
    title: "确认处理",
    content: isFault ? "确认标记为已知晓？" : "确认手动完成这条待办？",
    success: async ({ confirm }) => {
      if (!confirm) {
        return;
      }

      try {
        await mobileApi.resolveAlert(id, isFault ? "移动端管理员已知晓并接手处理。" : "移动端管理员已手动完成。");
        showOperationSuccess();
        await load();
      } catch (error) {
        showOperationFailure(error);
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
    <GlassCard tone="accent">
      <view class="vm-stack">
        <view class="status-row">
          <text>门状态：{{ detail?.runtime.doorState ?? "unknown" }}</text>
          <text>今日服务人数：{{ detail?.businessDayServedUsers.length ?? 0 }}</text>
        </view>
        <view class="status-row">
          <text>最近开门：{{ detail?.runtime.lastOpenedAt?.slice(0, 16).replace('T', ' ') || "暂无" }}</text>
          <text>最近关门：{{ detail?.runtime.lastClosedAt?.slice(0, 16).replace('T', ' ') || "暂无" }}</text>
        </view>
        <view class="action-row">
          <button class="vm-button" @tap="refresh">手动刷新</button>
          <button class="vm-button vm-button--ghost" :loading="opening" @tap="remoteOpen">远程开门</button>
        </view>
      </view>
    </GlassCard>

    <GlassCard tone="quiet">
      <view class="vm-stack">
        <text class="section-title">今日服务人员</text>
        <view v-if="detail?.businessDayServedUsers.length" class="list-block">
          <view v-for="item in detail?.businessDayServedUsers" :key="item.userId" class="list-item">
            <text class="list-item__title">{{ item.userName }}</text>
            <text class="list-item__meta">{{ item.goodsSummary }} · {{ item.lastServedAt.slice(0, 16).replace('T', ' ') }}</text>
          </view>
        </view>
        <EmptyState v-else :title="loading ? '正在加载数据' : '今日还没有服务记录'" description="普通用户、商户或管理员对该柜机有操作后，这里会实时更新。" />
      </view>
    </GlassCard>

    <GlassCard tone="warning">
      <view class="vm-stack">
        <text class="section-title">库存变化与阈值</text>
        <view v-if="detail?.stockChanges.length" class="list-block">
          <view v-for="item in detail?.stockChanges" :key="item.goodsId" class="list-item">
            <text class="list-item__title">{{ item.goodsName }}</text>
            <text class="list-item__meta">
              当前 {{ item.currentStock }} 件 · 相对业务日起点 {{ item.deltaSinceStartOfBusinessDay >= 0 ? '+' : '' }}{{ item.deltaSinceStartOfBusinessDay }}
              {{ item.thresholdEnabled ? ` · 阈值 ${item.lowStockThreshold}` : " · 未开启阈值" }}
            </text>
          </view>
        </view>
      </view>
    </GlassCard>

    <GlassCard tone="quiet">
      <view class="vm-stack">
        <text class="section-title">待处理任务</text>
        <view v-if="detail?.pendingTasks.length" class="list-block">
          <view v-for="task in detail?.pendingTasks" :key="task.id" class="list-item">
            <text class="list-item__title">{{ task.title }}</text>
            <text class="list-item__meta">{{ task.previewDetail || task.detail }}</text>
            <view class="task-actions">
              <button class="vm-button vm-button--ghost" @tap="showTaskDetail(task.title, task.detail)">详情</button>
              <button class="vm-button vm-button--ghost" @tap="resolveTask(task.id, task.title, task.grade === 'fault')">
                {{ task.grade === "fault" ? "标记已知晓" : "手动完成" }}
              </button>
            </view>
          </view>
        </view>
      </view>
    </GlassCard>

    <GlassCard tone="quiet">
      <view class="vm-stack">
        <text class="section-title">相关日志</text>
        <view v-if="detail?.recentLogs.length" class="list-block">
          <button v-for="log in detail?.recentLogs" :key="log.id" class="list-item" @tap="openLog(log.id)">
            <text class="list-item__title">{{ log.description }}</text>
            <text class="list-item__meta">{{ log.occurredAt.slice(0, 16).replace('T', ' ') }}</text>
          </button>
        </view>
      </view>
    </GlassCard>
  </MobileShell>
</template>

<style scoped>
.status-row,
.action-row,
.list-block,
.task-actions {
  display: grid;
  gap: 16rpx;
}

.section-title,
.list-item__title {
  font-size: 30rpx;
  font-weight: 700;
  color: var(--vm-text);
}

.list-item {
  display: grid;
  gap: 10rpx;
  padding: 22rpx 24rpx;
  border-radius: 24rpx;
  background: rgba(255, 255, 255, 0.62);
  border: 1rpx solid rgba(159, 127, 94, 0.12);
}

.list-item__meta {
  font-size: 22rpx;
  color: var(--vm-text-soft);
}
</style>
