<script setup lang="ts">
import { computed, ref } from "vue";
import { onShow } from "@dcloudio/uni-app";
import type { DeviceStatus, DeviceRecord, InventoryMovement } from "@vm/shared-types";

import { mobileApi } from "../../api/mobile";
import EmptyState from "../../components/ui/EmptyState.vue";
import GlassCard from "../../components/ui/GlassCard.vue";
import ServiceMetric from "../../components/ui/ServiceMetric.vue";
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
const { openCabinet, latestOrder, latestEventId, loading: opening } = useCabinetFlow();

const statusLabelMap: Record<DeviceStatus, string> = {
  online: "在线可用",
  offline: "离线待检",
  maintenance: "维护中"
};

const statusToneMap: Record<DeviceStatus, "success" | "warning" | "danger"> = {
  online: "success",
  offline: "danger",
  maintenance: "warning"
};

const quotaEntries = computed(() => Object.entries(sessionStore.quota?.remainingToday ?? {}));
const usedCount = computed(() => sessionStore.quota?.usedCount ?? 0);

const latestRecordSummary = computed(() => {
  if (!records.value.length) {
    return "今天还没有新的领取记录";
  }

  const latest = records.value[0];
  return `${latest.goodsName} · ${latest.deviceCode}`;
});

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

const formatDateTime = (value: string) => value.slice(0, 16).replace("T", " ");

onShow(load);
</script>

<template>
  <MobileShell eyebrow="特殊群体" :title="`${sessionStore.user?.name ?? '访客'}，您好`" :subtitle="appCopy.specialWelcome">
    <template #hero-extra>
      <GlassCard tone="quiet" compact>
        <view class="hero-tags">
          <text class="hero-tags__label">身份标签</text>
          <view class="hero-tags__list">
            <text v-for="tag in sessionStore.user?.tags ?? []" :key="tag" class="vm-status vm-status--success">{{ tag }}</text>
          </view>
        </view>
      </GlassCard>
    </template>

    <template #hero-actions>
      <GlassCard tone="accent" compact>
        <view class="hero-action-card">
          <view>
            <text class="hero-action-card__label">最近进度</text>
            <text class="hero-action-card__value">{{ latestOrder ?? "尚未发起开柜" }}</text>
          </view>
          <text class="hero-action-card__meta">{{ latestEventId ? `事件 ${latestEventId}` : latestRecordSummary }}</text>
        </view>
      </GlassCard>
    </template>

    <GlassCard tone="accent">
      <view class="vm-stack">
        <view class="section-heading">
          <text class="section-heading__title">今日可领状态</text>
          <text class="vm-subtitle">先确认今日剩余额度，再选择就近柜机领取。</text>
        </view>

        <view class="metric-grid">
          <ServiceMetric label="今日已领次数" :value="usedCount" hint="超过上限后将无法继续开柜" />
          <ServiceMetric
            label="可领品类"
            :value="quotaEntries.length || 0"
            hint="按角色规则自动核验"
            tone="accent"
          />
        </view>

        <view v-if="quotaEntries.length" class="quota-list">
          <view v-for="entry in quotaEntries" :key="entry[0]" class="quota-list__item">
            <view>
              <text class="quota-list__title">{{ categoryLabelMap[entry[0] as keyof typeof categoryLabelMap] }}</text>
              <text class="quota-list__hint">今日剩余可领次数</text>
            </view>
            <text class="vm-number quota-list__value">{{ entry[1] }}</text>
          </view>
        </view>
        <EmptyState v-else title="暂无额度信息" description="请稍后刷新，或联系工作人员确认当前规则。" />

        <button class="vm-button vm-button--ghost" @tap="goHistory">查看完整领取记录</button>
      </view>
    </GlassCard>

    <view class="vm-section">
      <view class="section-heading">
        <text class="section-heading__title">就近柜机与物资</text>
        <text class="vm-subtitle">优先展示在线设备和当前可领取物资，减少无效操作。</text>
      </view>

      <view v-if="devices.length" class="device-list">
        <GlassCard v-for="device in devices" :key="device.deviceCode">
          <view class="vm-stack">
            <view class="device-header">
              <view class="device-header__main">
                <text class="device-header__title">{{ device.name }}</text>
                <text class="vm-subtitle">{{ device.location }}</text>
              </view>
              <text class="vm-status" :class="`vm-status--${statusToneMap[device.status]}`">{{ statusLabelMap[device.status] }}</text>
            </view>

            <view class="device-meta">
              <text>柜机编号 {{ device.deviceCode }}</text>
              <text>最近在线 {{ formatDateTime(device.lastSeenAt) }}</text>
            </view>

            <view class="goods-list">
              <view v-for="goods in device.doors[0]?.goods ?? []" :key="goods.goodsId" class="goods-item">
                <view class="goods-item__main">
                  <text class="goods-item__name">{{ goods.name }}</text>
                  <text class="goods-item__meta">
                    {{ categoryLabelMap[goods.category] }} · 剩余 {{ goods.stock }} 件
                  </text>
                </view>
                <text v-if="goods.expiresAt" class="goods-item__tag">截止 {{ goods.expiresAt.slice(5, 10) }}</text>
              </view>
            </view>

            <button
              class="vm-button"
              :loading="opening"
              @tap="openCabinet(device.deviceCode, device.doors[0]?.goods[0]?.category)"
            >
              申请开柜领取
            </button>
          </view>
        </GlassCard>
      </view>
      <GlassCard v-else tone="quiet">
        <EmptyState
          :title="loading ? '正在加载柜机列表' : '当前暂无可用柜机'"
          :description="loading ? '请稍候，系统正在同步设备状态。' : '请联系工作人员确认柜机是否已接入。'"
        />
      </GlassCard>
    </view>

    <GlassCard tone="quiet">
      <view class="vm-stack">
        <view class="section-heading">
          <text class="section-heading__title">最近领取记录预览</text>
          <text class="vm-subtitle">保留最近三条，完整记录可在次级页查看。</text>
        </view>

        <view v-if="records.length" class="record-list">
          <view v-for="record in records.slice(0, 3)" :key="record.id" class="record-item">
            <view class="record-item__main">
              <text class="record-item__title">{{ record.goodsName }}</text>
              <text class="record-item__meta">{{ record.deviceCode }} · {{ formatDateTime(record.happenedAt) }}</text>
            </view>
            <text class="vm-status vm-status--success">领取 {{ record.quantity }} 件</text>
          </view>
        </view>
        <EmptyState v-else title="还没有领取记录" description="首次领取成功后，这里会自动展示最近操作。" />
      </view>
    </GlassCard>
  </MobileShell>
</template>

<style scoped>
.hero-tags,
.hero-action-card,
.section-heading {
  display: flex;
  flex-direction: column;
  gap: 12rpx;
}

.hero-tags__label,
.hero-action-card__label {
  font-size: 22rpx;
  color: var(--vm-text-soft);
}

.hero-tags__list {
  display: flex;
  flex-wrap: wrap;
  gap: 12rpx;
}

.hero-action-card {
  gap: 14rpx;
}

.hero-action-card__value,
.section-heading__title,
.device-header__title,
.quota-list__title,
.record-item__title,
.goods-item__name {
  font-size: 30rpx;
  font-weight: 700;
  color: var(--vm-text);
}

.hero-action-card__meta,
.quota-list__hint,
.device-meta,
.record-item__meta,
.goods-item__meta {
  font-size: 22rpx;
  color: var(--vm-text-soft);
}

.metric-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 18rpx;
}

.quota-list,
.device-list,
.goods-list,
.record-list {
  display: grid;
  gap: 16rpx;
}

.quota-list__item,
.goods-item,
.record-item {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 20rpx;
  padding: 22rpx 24rpx;
  border-radius: 26rpx;
  background: rgba(255, 255, 255, 0.62);
  border: 1rpx solid rgba(159, 127, 94, 0.12);
}

.quota-list__value {
  font-size: 48rpx;
}

.device-header {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 20rpx;
}

.device-header__main {
  display: flex;
  flex-direction: column;
  gap: 8rpx;
}

.device-meta {
  display: flex;
  justify-content: space-between;
  gap: 20rpx;
  flex-wrap: wrap;
}

.goods-item__main,
.record-item__main {
  display: flex;
  flex-direction: column;
  gap: 8rpx;
}

.goods-item__tag {
  flex-shrink: 0;
  padding: 10rpx 16rpx;
  border-radius: 999rpx;
  background: rgba(240, 177, 52, 0.16);
  color: #8a5b11;
  font-size: 22rpx;
}

@media screen and (min-width: 720px) {
  .metric-grid {
    grid-template-columns: repeat(4, minmax(0, 1fr));
  }
}
</style>
