<script setup lang="ts">
import { ref } from "vue";
import { onShow } from "@dcloudio/uni-app";
import type { DeviceRecord, InventoryMovement } from "@vm/shared-types";

import { mobileApi } from "../../api/mobile";
import GlassCard from "../../components/ui/GlassCard.vue";
import { useCabinetFlow } from "../../composables/useCabinetFlow";
import { appCopy } from "../../constants/copy";
import MobileShell from "../../layouts/MobileShell.vue";
import { useSessionStore } from "../../stores/session";
import { getErrorMessage } from "../../utils/error-message";

const sessionStore = useSessionStore();
const devices = ref<DeviceRecord[]>([]);
const records = ref<InventoryMovement[]>([]);
const alerts = ref<Array<{ id: string; title: string; detail: string; dueAt: string }>>([]);
const summary = ref({
  donatedUnits: 0,
  expiredUnits: 0,
  pendingAlerts: 0
});
const { openCabinet, latestOrder, latestEventId } = useCabinetFlow();

const load = async () => {
  if (!sessionStore.user) {
    uni.reLaunch({
      url: "/pages/common/login"
    });
    return;
  }

  try {
    const [deviceResponse, summaryResponse, alertResponse] = await Promise.all([
      mobileApi.listDevices(),
      mobileApi.merchantSummary(sessionStore.user.id),
      mobileApi.alerts("merchant")
    ]);

    devices.value = deviceResponse;
    records.value = summaryResponse.records;
    summary.value = {
      donatedUnits: summaryResponse.donatedUnits,
      expiredUnits: summaryResponse.expiredUnits,
      pendingAlerts: summaryResponse.pendingAlerts
    };
    alerts.value = alertResponse;
  } catch (error) {
    uni.showToast({
      title: getErrorMessage(error),
      icon: "none"
    });
  }
};

onShow(load);
</script>

<template>
  <MobileShell eyebrow="商户端" :title="sessionStore.user?.name ?? '商户账号'" :subtitle="appCopy.merchantWelcome">
    <GlassCard>
      <view class="summary-grid">
        <view class="summary-box">
          <text class="summary-box__value">{{ summary.donatedUnits }}</text>
          <text class="summary-box__label">累计投放</text>
        </view>
        <view class="summary-box">
          <text class="summary-box__value">{{ summary.pendingAlerts }}</text>
          <text class="summary-box__label">待处理预警</text>
        </view>
        <view class="summary-box">
          <text class="summary-box__value">{{ summary.expiredUnits }}</text>
          <text class="summary-box__label">过期处理数</text>
        </view>
      </view>
      <view style="height: 18rpx;" />
      <text v-if="latestOrder" class="vm-pill">最近开柜事件：{{ latestOrder }}</text>
      <text v-if="latestEventId" class="vm-pill">最近事件编号：{{ latestEventId }}</text>
    </GlassCard>

    <GlassCard>
      <view class="vm-stack">
        <text class="card__title">发起投放开柜</text>
        <view v-for="device in devices" :key="device.deviceCode" class="launch-row">
          <view>
            <text>{{ device.name }}</text>
            <view style="height: 6rpx;" />
            <text class="vm-subtitle">{{ device.location }}</text>
          </view>
          <button class="vm-button vm-button--ghost launch-row__button" @tap="openCabinet(device.deviceCode)">
            开柜
          </button>
        </view>
      </view>
    </GlassCard>

    <GlassCard>
      <view class="vm-stack">
        <text class="card__title">待处理预警</text>
        <view v-for="alert in alerts.slice(0, 4)" :key="alert.id" class="alert-row">
          <view>
            <text>{{ alert.title }}</text>
            <view style="height: 8rpx;" />
            <text class="vm-subtitle">{{ alert.detail }}</text>
          </view>
          <text class="vm-pill">{{ alert.dueAt.slice(5, 10) }}</text>
        </view>
      </view>
    </GlassCard>

    <GlassCard>
      <view class="vm-stack">
        <text class="card__title">最近投放记录</text>
        <view v-for="record in records.slice(0, 4)" :key="record.id" class="alert-row">
          <view>
            <text>{{ record.goodsName }}</text>
            <view style="height: 8rpx;" />
            <text class="vm-subtitle">{{ record.expiresAt ? `领取截止：${record.expiresAt.slice(5, 10)}` : record.happenedAt.slice(0, 10) }}</text>
          </view>
          <text class="vm-pill">{{ record.quantity }}</text>
        </view>
      </view>
    </GlassCard>
  </MobileShell>
</template>

<style scoped>
.summary-grid {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 16rpx;
}

.summary-box {
  padding: 18rpx;
  border-radius: 24rpx;
  background: rgba(255, 255, 255, 0.04);
  border: 1rpx solid var(--vm-line);
}

.summary-box__value {
  font-size: 42rpx;
  font-weight: 700;
}

.summary-box__label {
  margin-top: 8rpx;
  font-size: 22rpx;
  color: var(--vm-muted);
}

.card__title {
  font-size: 32rpx;
  font-weight: 700;
}

.launch-row,
.alert-row {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 16rpx;
  padding: 18rpx 0;
  border-bottom: 1rpx solid var(--vm-line);
}

.launch-row__button {
  min-width: 170rpx;
}
</style>
