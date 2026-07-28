<script setup lang="ts">
import { computed, ref } from "vue";
import { onShow } from "@dcloudio/uni-app";
import type { DeviceRecord } from "@vm/shared-types";

import { mobileApi } from "../../api/mobile";
import EmptyState from "../../components/ui/EmptyState.vue";
import GlassCard from "../../components/ui/GlassCard.vue";
import MenuIcon from "../../components/ui/MenuIcon.vue";
import MobileShell from "../../layouts/MobileShell.vue";
import { formatBeijingDateTime } from "../../utils/datetime";
import { canOpenDevice, getDeviceStatusPresentation } from "../../utils/device-readiness";
import { appendErrorContext, getErrorMessage } from "../../utils/error-message";
import { useSessionStore } from "../../stores/session";

const sessionStore = useSessionStore();
const loading = ref(false);
const loadError = ref("");
const deviceCards = ref<Array<{
  device: DeviceRecord;
  pendingCount?: number;
  todayPickupCount?: number;
  monitoringUnavailable: boolean;
  monitoringError?: string;
}>>([]);

const onlineCount = computed(() => deviceCards.value.filter((item) => canOpenDevice(item.device)).length);
const unavailableCount = computed(() => deviceCards.value.filter((item) => item.monitoringUnavailable).length);
const pendingTotal = computed(() =>
  deviceCards.value.reduce((sum, item) => sum + (item.monitoringUnavailable ? 0 : item.pendingCount ?? 0), 0)
);
const pickupTotal = computed(() =>
  deviceCards.value.reduce((sum, item) => sum + (item.monitoringUnavailable ? 0 : item.todayPickupCount ?? 0), 0)
);
const loadErrorBody = computed(() =>
  appendErrorContext(loadError.value, "当前不会把失败结果显示成“暂无柜机”。")
);

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
            todayPickupCount: detail.businessDayServedUsers.length,
            monitoringUnavailable: false
          };
        } catch (error) {
          return {
            device,
            monitoringUnavailable: true,
            monitoringError: getErrorMessage(error)
          };
        }
      })
    );

    deviceCards.value = monitoring.sort((left, right) => {
      if (left.monitoringUnavailable !== right.monitoringUnavailable) {
        return left.monitoringUnavailable ? -1 : 1;
      }

      if ((left.pendingCount ?? 0) !== (right.pendingCount ?? 0)) {
        return (right.pendingCount ?? 0) - (left.pendingCount ?? 0);
      }

      if (canOpenDevice(left.device) !== canOpenDevice(right.device)) {
        return canOpenDevice(left.device) ? -1 : 1;
      }

      return left.device.name.localeCompare(right.device.name, "zh-CN");
    });
    loadError.value = "";
  } catch (error) {
    loadError.value = getErrorMessage(error);
    uni.showToast({
      title: loadError.value,
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
  <MobileShell eyebrow="柜机列表" title="柜机监控入口" subtitle="先看异常和待处理，再进入单柜机处理。">
    <GlassCard tone="accent">
      <view class="device-overview">
        <view class="device-overview__head">
          <MenuIcon name="device" size="lg" />
          <view>
            <text class="device-overview__title">柜机运行概览</text>
            <text class="device-overview__hint">
              {{ unavailableCount > 0 ? `有 ${unavailableCount} 台柜机监控数据不可用` : pendingTotal > 0 ? `有 ${pendingTotal} 个待处理动作` : "当前无待处理动作" }}
            </text>
          </view>
        </view>
        <view class="overview-grid">
          <view class="overview-metric">
            <text class="overview-metric__value vm-number">{{ onlineCount }}</text>
            <text class="overview-metric__label">在线</text>
          </view>
          <view class="overview-metric overview-metric--warning">
            <text class="overview-metric__value vm-number">{{ pendingTotal }}</text>
            <text class="overview-metric__label">{{ unavailableCount ? "已确认待处理" : "待处理" }}</text>
          </view>
          <view class="overview-metric">
            <text class="overview-metric__value vm-number">{{ pickupTotal }}</text>
            <text class="overview-metric__label">{{ unavailableCount ? "已确认今日领取" : "今日领取" }}</text>
          </view>
        </view>
        <view v-if="loadError" class="monitoring-alert" role="alert" aria-live="assertive">
          <text class="monitoring-alert__title">柜机列表同步失败</text>
          <text class="monitoring-alert__body">{{ loadErrorBody }}</text>
          <button class="vm-button vm-button--ghost" :disabled="loading" :loading="loading" @tap="load">重新加载</button>
        </view>
        <view v-else-if="unavailableCount" class="monitoring-alert" role="alert" aria-live="polite">
          <text class="monitoring-alert__title">部分监控数据未确认</text>
          <text class="monitoring-alert__body">{{ unavailableCount }} 台柜机未能读取待办或今日领取数据，已从汇总中排除，请刷新后再判断。</text>
          <button class="vm-button vm-button--ghost" :disabled="loading" :loading="loading" @tap="load">刷新监控数据</button>
        </view>
      </view>
    </GlassCard>

    <GlassCard tone="quiet">
      <view class="vm-stack">
        <view v-if="deviceCards.length" class="device-list">
          <button
            v-for="item in deviceCards"
            :key="item.device.deviceCode"
            class="device-item"
            @tap="openDetail(item.device.deviceCode)"
          >
            <view v-if="item.monitoringUnavailable || item.pendingCount" class="device-item__dot" />
            <view class="device-item__header">
              <view class="device-item__media" aria-hidden="true">
                <view class="device-item__machine" />
              </view>
              <view class="device-item__main">
                <view class="device-item__title-row">
                  <text class="device-item__title">{{ item.device.name }}</text>
                  <text class="vm-status" :class="`vm-status--${getDeviceStatusPresentation(item.device).tone}`">{{ getDeviceStatusPresentation(item.device).label }}</text>
                </view>
                <text class="device-item__meta">{{ item.device.location }}</text>
                <text class="device-item__meta">编号 {{ item.device.deviceCode }} · 最近在线 {{ formatBeijingDateTime(item.device.lastSeenAt) }}</text>
                <text v-if="!canOpenDevice(item.device)" class="device-item__meta device-item__meta--warning">
                  {{ getDeviceStatusPresentation(item.device).actionHint }}
                </text>
                <text v-if="item.monitoringUnavailable" class="device-item__meta device-item__meta--danger" role="alert">
                  待办与领取数据不可用：{{ item.monitoringError || "请刷新后重试" }}
                </text>
              </view>
            </view>
            <view class="device-item__stats">
              <view class="device-item__stat">
                <text class="device-item__label">待处理</text>
                <text class="device-item__value" :class="{ 'device-item__value--warning': item.monitoringUnavailable || (item.pendingCount ?? 0) > 0 }">
                  {{ item.monitoringUnavailable ? "—" : item.pendingCount }}
                </text>
              </view>
              <view class="device-item__stat">
                <text class="device-item__label">今日领取</text>
                <text class="device-item__value">{{ item.monitoringUnavailable ? "—" : item.todayPickupCount }}</text>
              </view>
              <view class="device-item__stat">
                <text class="device-item__label">任务状态</text>
                <text class="device-item__value" :class="{ 'device-item__value--warning': item.monitoringUnavailable || (item.pendingCount ?? 0) > 0 }">
                  {{ item.monitoringUnavailable ? "数据不可用" : (item.pendingCount ?? 0) > 0 ? "需处理" : "正常" }}
                </text>
              </view>
            </view>
            <text class="device-item__link">查看详情 ></text>
          </button>
        </view>
        <EmptyState
          v-else
          :title="loading ? '正在加载柜机' : loadError ? '柜机数据暂时不可用' : '暂无柜机数据'"
          :description="loadError ? '请点击上方“重新加载”，恢复前不会把请求失败当作空数据。' : '请稍后刷新，或在电脑后台添加柜机。'"
        />
      </view>
    </GlassCard>
  </MobileShell>
</template>

<style scoped>
.device-overview,
.device-overview__head,
.overview-grid,
.device-list {
  display: grid;
  gap: 16rpx;
}

.device-overview__head {
  grid-template-columns: auto minmax(0, 1fr);
  align-items: center;
}

.device-overview__title {
  display: block;
  font-size: 30rpx;
  font-weight: 800;
  color: var(--vm-text);
}

.device-overview__hint,
.device-item__meta {
  display: block;
  margin-top: 8rpx;
  font-size: 22rpx;
  line-height: 1.55;
  color: var(--vm-text-soft);
}

.overview-grid {
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 12rpx;
}

.overview-metric {
  display: grid;
  gap: 8rpx;
  justify-items: center;
  min-height: 112rpx;
  padding: 18rpx 10rpx;
  border-radius: 22rpx;
  border: 1rpx solid var(--vm-success-line);
  background: rgba(255, 255, 255, 0.86);
}

.overview-metric--warning {
  border-color: var(--vm-warning-line);
  background: var(--vm-warning-bg);
}

.overview-metric__value {
  font-size: 40rpx;
  line-height: 1;
  font-weight: 900;
  color: var(--vm-accent-strong);
}

.overview-metric--warning .overview-metric__value {
  color: var(--vm-warning);
}

.overview-metric__label {
  font-size: 22rpx;
  color: var(--vm-text-soft);
}

.device-item {
  position: relative;
  display: grid;
  gap: 16rpx;
  min-height: 248rpx;
  padding: 24rpx;
  border-radius: 26rpx;
  background: rgba(255, 255, 255, 0.9);
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

.device-item__stats {
  display: grid;
  gap: 12rpx;
}

.device-item__header {
  display: grid;
  grid-template-columns: auto minmax(0, 1fr);
  align-items: center;
  gap: 18rpx;
  min-width: 0;
}

.device-item__stats {
  grid-template-columns: repeat(3, minmax(0, 1fr));
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

.device-item__title-row {
  display: flex;
  justify-content: space-between;
  gap: 12rpx;
  align-items: center;
}

.device-item__main {
  min-width: 0;
}

.device-item__label,
.device-item__link {
  font-size: 22rpx;
  color: var(--vm-text-soft);
}

.device-item__value {
  font-size: 28rpx;
  font-weight: 700;
  color: var(--vm-text);
}

.device-item__value--warning {
  color: var(--vm-danger);
}

.device-item__meta--warning {
  color: var(--vm-warning);
  font-weight: 700;
}

.device-item__meta--danger {
  color: var(--vm-danger);
  font-weight: 700;
}

.monitoring-alert {
  display: grid;
  gap: 12rpx;
  padding: 20rpx;
  border: 2rpx solid var(--vm-danger-line);
  border-radius: 22rpx;
  background: var(--vm-danger-bg);
}

.monitoring-alert__title {
  font-size: 28rpx;
  font-weight: 800;
  color: var(--vm-danger);
}

.monitoring-alert__body {
  font-size: 24rpx;
  line-height: 1.6;
  color: var(--vm-text);
}

.device-item__link {
  color: var(--vm-accent-strong);
}

.device-item__media {
  display: grid;
  place-items: center;
  width: 110rpx;
  height: 110rpx;
  border-radius: 22rpx;
  background: linear-gradient(180deg, #fff4e6, #eaf6e4);
  overflow: hidden;
}

.device-item__machine {
  position: relative;
  width: 58rpx;
  height: 82rpx;
  border-radius: 10rpx;
  background: #2e7d46;
  box-shadow: inset 0 0 0 5rpx rgba(255, 255, 255, 0.26);
}

.device-item__machine::before {
  content: "";
  position: absolute;
  left: 10rpx;
  top: 14rpx;
  width: 30rpx;
  height: 48rpx;
  border-radius: 6rpx;
  background:
    linear-gradient(#ff9a33 0 0) 5rpx 9rpx / 8rpx 8rpx no-repeat,
    linear-gradient(#8fcf7f 0 0) 18rpx 9rpx / 8rpx 8rpx no-repeat,
    linear-gradient(#fff0c9 0 0) 5rpx 26rpx / 8rpx 8rpx no-repeat,
    linear-gradient(#ff9a33 0 0) 18rpx 26rpx / 8rpx 8rpx no-repeat,
    #eef8e8;
}
</style>

