<script setup lang="ts">
import { ref } from "vue";
import { onShow } from "@dcloudio/uni-app";
import type { DeviceRecord, DeviceStatus } from "@vm/shared-types";

import { mobileApi } from "../../api/mobile";
import EmptyState from "../../components/ui/EmptyState.vue";
import GlassCard from "../../components/ui/GlassCard.vue";
import MobileShell from "../../layouts/MobileShell.vue";
import { getErrorMessage } from "../../utils/error-message";
import { useSessionStore } from "../../stores/session";

const sessionStore = useSessionStore();
const loading = ref(false);
const devices = ref<DeviceRecord[]>([]);

const statusLabelMap: Record<DeviceStatus, string> = {
  online: "在线",
  offline: "离线",
  maintenance: "维护中"
};

const statusToneMap: Record<DeviceStatus, "success" | "warning" | "danger"> = {
  online: "success",
  offline: "danger",
  maintenance: "warning"
};

const load = async () => {
  await sessionStore.bootstrap();

  if (!sessionStore.user || sessionStore.user.role !== "admin") {
    uni.reLaunch({ url: "/pages/common/login" });
    return;
  }

  loading.value = true;
  try {
    devices.value = await mobileApi.listDevices();
  } catch (error) {
    uni.showToast({
      title: getErrorMessage(error),
      icon: "none"
    });
  } finally {
    loading.value = false;
  }
};

const openDetail = (deviceCode: string) => {
  uni.navigateTo({
    url: `/pages/admin/device-detail?deviceCode=${deviceCode}`
  });
};

onShow(() => {
  load();
});
</script>

<template>
  <MobileShell eyebrow="柜机列表" title="柜机监控入口" subtitle="查看设备状态、关键货品数量、待处理任务和远程开门入口。">
    <GlassCard tone="quiet">
      <view class="vm-stack">
        <view v-if="devices.length" class="device-list">
          <button v-for="device in devices" :key="device.deviceCode" class="device-item" @tap="openDetail(device.deviceCode)">
            <view class="device-item__main">
              <text class="device-item__title">{{ device.name }}</text>
              <text class="device-item__meta">{{ device.deviceCode }} · {{ device.location }}</text>
              <text class="device-item__meta">货品 {{ device.doors[0]?.goods.length ?? 0 }} 种 · 最近在线 {{ device.lastSeenAt.slice(0, 16).replace('T', ' ') }}</text>
            </view>
            <text class="vm-status" :class="`vm-status--${statusToneMap[device.status]}`">{{ statusLabelMap[device.status] }}</text>
          </button>
        </view>
        <EmptyState v-else :title="loading ? '正在加载柜机' : '暂无柜机数据'" description="请稍后刷新，或先在后台接入柜机。" />
      </view>
    </GlassCard>
  </MobileShell>
</template>

<style scoped>
.device-list {
  display: grid;
  gap: 16rpx;
}

.device-item {
  display: flex;
  justify-content: space-between;
  align-items: flex-start;
  gap: 16rpx;
  padding: 22rpx 24rpx;
  border-radius: 24rpx;
  background: rgba(255, 255, 255, 0.62);
  border: 1rpx solid rgba(159, 127, 94, 0.12);
}

.device-item__main {
  display: flex;
  flex-direction: column;
  gap: 8rpx;
  text-align: left;
}

.device-item__title {
  font-size: 30rpx;
  font-weight: 700;
  color: var(--vm-text);
}

.device-item__meta {
  font-size: 22rpx;
  color: var(--vm-text-soft);
}
</style>
