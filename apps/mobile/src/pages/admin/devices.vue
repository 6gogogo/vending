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
const deviceCards = ref<Array<{
  device: DeviceRecord;
  pendingCount: number;
  todayPickupCount: number;
}>>([]);

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
    const devices = await mobileApi.listDevices();
    const monitoring = await Promise.all(
      devices.map(async (device) => {
        try {
          const detail = await mobileApi.deviceMonitoring(device.deviceCode);
          return {
            device,
            pendingCount: detail.pendingTasks.length,
            todayPickupCount: detail.businessDayServedUsers.length
          };
        } catch {
          return {
            device,
            pendingCount: 0,
            todayPickupCount: 0
          };
        }
      })
    );

    deviceCards.value = monitoring.sort((left, right) => {
      if (left.pendingCount !== right.pendingCount) {
        return right.pendingCount - left.pendingCount;
      }

      if (left.device.status !== right.device.status) {
        return left.device.status === "online" ? -1 : 1;
      }

      return left.device.name.localeCompare(right.device.name, "zh-CN");
    });
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
  <MobileShell eyebrow="柜机列表" title="柜机监控入口" subtitle="查看在线情况、待处理任务和今日领取数，点详情进入单柜机处理。">
    <GlassCard tone="quiet">
      <view class="vm-stack">
        <view v-if="deviceCards.length" class="device-list">
          <button
            v-for="item in deviceCards"
            :key="item.device.deviceCode"
            class="device-item"
            @tap="openDetail(item.device.deviceCode)"
          >
            <view v-if="item.pendingCount" class="device-item__dot" />
            <view class="device-item__header">
              <text class="device-item__title">{{ item.device.name }}</text>
              <text class="vm-status" :class="`vm-status--${statusToneMap[item.device.status]}`">{{ statusLabelMap[item.device.status] }}</text>
            </view>
            <view class="device-item__stats">
              <view class="device-item__stat">
                <text class="device-item__label">待处理</text>
                <text class="device-item__value" :class="{ 'device-item__value--warning': item.pendingCount > 0 }">{{ item.pendingCount }}</text>
              </view>
              <view class="device-item__stat">
                <text class="device-item__label">今日领取</text>
                <text class="device-item__value">{{ item.todayPickupCount }}</text>
              </view>
            </view>
            <text class="device-item__link">查看详情 ></text>
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
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 16rpx;
}

.device-item {
  position: relative;
  display: grid;
  gap: 16rpx;
  min-height: 240rpx;
  padding: 24rpx;
  border-radius: 26rpx;
  background: var(--vm-surface-soft);
  border: 1rpx solid var(--vm-line);
  text-align: left;
}

.device-item__dot {
  position: absolute;
  top: 18rpx;
  right: 18rpx;
  width: 16rpx;
  height: 16rpx;
  border-radius: 50%;
  background: #ef4444;
  box-shadow: 0 0 0 6rpx rgba(239, 68, 68, 0.12);
}

.device-item__header,
.device-item__stats {
  display: grid;
  gap: 12rpx;
}

.device-item__header {
  min-width: 0;
}

.device-item__stats {
  grid-template-columns: repeat(2, minmax(0, 1fr));
}

.device-item__stat {
  display: grid;
  gap: 8rpx;
}

.device-item__title {
  font-size: 28rpx;
  font-weight: 700;
  color: var(--vm-text);
}

.device-item__label,
.device-item__link {
  font-size: 22rpx;
  color: var(--vm-text-soft);
}

.device-item__value {
  font-size: 30rpx;
  font-weight: 700;
  color: var(--vm-text);
}

.device-item__value--warning {
  color: var(--vm-danger);
}

.device-item__link {
  color: var(--vm-accent-strong);
}
</style>

