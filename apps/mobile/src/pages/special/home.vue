<script setup lang="ts">
import { computed, ref } from "vue";
import { onShow } from "@dcloudio/uni-app";
import type { DeviceRecord, InventoryMovement } from "@vm/shared-types";

import { mobileApi } from "../../api/mobile";
import GlassCard from "../../components/ui/GlassCard.vue";
import { useCabinetFlow } from "../../composables/useCabinetFlow";
import { appCopy } from "../../constants/copy";
import { categoryLabelMap } from "../../constants/labels";
import MobileShell from "../../layouts/MobileShell.vue";
import { useSessionStore } from "../../stores/session";
import { getErrorMessage } from "../../utils/error-message";

const sessionStore = useSessionStore();
const devices = ref<DeviceRecord[]>([]);
const records = ref<InventoryMovement[]>([]);
const loading = ref(false);
const { openCabinet, latestOrder, latestEventId } = useCabinetFlow();

const quotaEntries = computed(() => Object.entries(sessionStore.quota?.remainingToday ?? {}));

const load = async () => {
  if (!sessionStore.user) {
    uni.reLaunch({
      url: "/pages/common/login"
    });
    return;
  }

  loading.value = true;
  try {
    const [deviceResponse, quotaResponse, recordResponse] = await Promise.all([
      mobileApi.listDevices(),
      mobileApi.getQuotaSummary(sessionStore.user.phone),
      mobileApi.listRecords(sessionStore.user.id, sessionStore.user.role)
    ]);

    devices.value = deviceResponse;
    sessionStore.setQuota(quotaResponse);
    records.value = recordResponse;
  } catch (error) {
    uni.showToast({
      title: getErrorMessage(error),
      icon: "none"
    });
  } finally {
    loading.value = false;
  }
};

const goHistory = () => {
  uni.navigateTo({
    url: "/pages/special/history"
  });
};

onShow(load);
</script>

<template>
  <MobileShell eyebrow="特殊群体" :title="`${sessionStore.user?.name ?? '访客'}，您好`" :subtitle="appCopy.specialWelcome">
    <GlassCard>
      <view class="vm-stack">
        <view class="quota-strip">
          <view v-for="entry in quotaEntries" :key="entry[0]" class="quota-chip">
            <text class="quota-chip__value">{{ entry[1] }}</text>
            <text class="quota-chip__label">{{ categoryLabelMap[entry[0] as keyof typeof categoryLabelMap] }}</text>
          </view>
        </view>
        <button class="vm-button vm-button--ghost" @tap="goHistory">查看领取记录</button>
        <text v-if="latestOrder" class="vm-pill">最近开柜单号：{{ latestOrder }}</text>
        <text v-if="latestEventId" class="vm-pill">最近事件编号：{{ latestEventId }}</text>
      </view>
    </GlassCard>

    <view class="vm-grid">
      <GlassCard v-for="device in devices" :key="device.deviceCode">
        <view class="vm-stack">
          <text class="card__title">{{ device.name }}</text>
          <text class="vm-subtitle">{{ device.location }}</text>
          <view class="goods-row">
            <view v-for="goods in device.doors[0]?.goods ?? []" :key="goods.goodsId" class="goods-tile">
              <text class="goods-tile__name">{{ goods.name }}</text>
              <text class="goods-tile__meta">{{ categoryLabelMap[goods.category] }} · 剩余 {{ goods.stock }} 件</text>
            </view>
          </view>
          <button
            class="vm-button"
            :loading="loading"
            @tap="openCabinet(device.deviceCode, device.doors[0]?.goods[0]?.category)"
          >
            申请开柜领取
          </button>
        </view>
      </GlassCard>
    </view>

    <GlassCard>
      <view class="vm-stack">
        <text class="card__title">最近领取记录</text>
        <view v-for="record in records.slice(0, 3)" :key="record.id" class="record-row">
          <view>
            <text>{{ record.goodsName }}</text>
            <view style="height: 6rpx;" />
            <text class="vm-subtitle">{{ record.deviceCode }}</text>
          </view>
          <text class="vm-pill">{{ record.quantity }}</text>
        </view>
      </view>
    </GlassCard>
  </MobileShell>
</template>

<style scoped>
.quota-strip {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 16rpx;
}

.quota-chip {
  display: flex;
  flex-direction: column;
  gap: 4rpx;
  padding: 18rpx;
  border-radius: 24rpx;
  background: rgba(61, 208, 165, 0.08);
}

.quota-chip__value {
  font-size: 44rpx;
  font-weight: 700;
}

.quota-chip__label {
  font-size: 22rpx;
  color: var(--vm-muted);
}

.card__title {
  font-size: 32rpx;
  font-weight: 700;
}

.goods-row {
  display: grid;
  gap: 14rpx;
}

.goods-tile {
  padding: 18rpx;
  border-radius: 24rpx;
  background: rgba(255, 255, 255, 0.03);
  border: 1rpx solid var(--vm-line);
}

.goods-tile__name {
  font-size: 28rpx;
}

.goods-tile__meta {
  margin-top: 8rpx;
  color: var(--vm-muted);
  font-size: 22rpx;
}

.record-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 20rpx 0;
  border-bottom: 1rpx solid var(--vm-line);
}
</style>
