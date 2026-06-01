<script setup lang="ts">
import { computed, ref } from "vue";
import { onShow } from "@dcloudio/uni-app";
import type { DeviceStatus, DeviceRecord, GoodsCategory, InventoryMovement } from "@vm/shared-types";

import { mobileApi } from "../../api/mobile";
import EmptyState from "../../components/ui/EmptyState.vue";
import GlassCard from "../../components/ui/GlassCard.vue";
import MenuIcon from "../../components/ui/MenuIcon.vue";
import MobileShell from "../../layouts/MobileShell.vue";
import { appCopy } from "../../constants/copy";
import { categoryLabelMap } from "../../constants/labels";
import { useSessionStore } from "../../stores/session";
import { useUiPreferencesStore } from "../../stores/ui-preferences";
import { getErrorMessage } from "../../utils/error-message";
import { getReceivableDeviceGoods } from "../../utils/receivable-goods";
import { scanDeviceCode } from "../../utils/scan-device";

const sessionStore = useSessionStore();
const uiPreferencesStore = useUiPreferencesStore();
const devices = ref<DeviceRecord[]>([]);
const records = ref<InventoryMovement[]>([]);
const loading = ref(false);

uiPreferencesStore.hydrate();

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

const permissionList = computed(() =>
  Object.entries(sessionStore.quota?.remainingByGoods ?? {}).map(([goodsId, quantity]) => {
    const matchedGoods = devices.value
      .flatMap((device) => device.doors)
      .flatMap((door) => door.goods)
      .find((item) => item.goodsId === goodsId);

    return {
      goodsId,
      goodsName: matchedGoods?.name ?? goodsId,
      quantity,
      category: matchedGoods?.category
    };
  })
);

const serviceWindows = computed(() =>
  (sessionStore.quota?.activeWindows ?? []).map(
    (window) => `${String(window.startHour).padStart(2, "0")}:00-${String(window.endHour).padStart(2, "0")}:00`
  )
);
const totalRemaining = computed(() => permissionList.value.reduce((sum, item) => sum + item.quantity, 0));
const usedCount = computed(() => sessionStore.quota?.usedCount ?? 0);
const categoryOrder: Array<{ key: GoodsCategory; label: string; tone: "drink" | "food" | "daily" }> = [
  { key: "drink", label: "饮品", tone: "drink" },
  { key: "food", label: "食品", tone: "food" },
  { key: "daily", label: "日用品", tone: "daily" }
];
const categorySummaries = computed(() =>
  categoryOrder.map((category) => {
    const items = permissionList.value.filter((item) => item.category === category.key);

    return {
      ...category,
      quantity: items.reduce((sum, item) => sum + item.quantity, 0),
      kinds: items.length,
      icon: category.tone
    };
  })
);

const guidanceText = computed(() => {
  if (permissionList.value.length) {
    return "先确认今天还能领什么，再去最近的柜机操作；如果机器异常，可直接反馈给工作人员。";
  }

  return "当前没有可领取额度也不需要重复操作，系统会按服务时间和资格自动刷新。";
});

const accessibilityEnabled = computed(() => uiPreferencesStore.isAccessibilityEnabled(sessionStore.user?.role));
const deviceEntries = computed(() =>
  devices.value.map((device) => ({
    device,
    visibleGoods: getReceivableDeviceGoods(device, sessionStore.quota)
  }))
);
const visibleDeviceEntries = computed(() =>
  accessibilityEnabled.value ? deviceEntries.value.filter((entry) => entry.visibleGoods.length) : deviceEntries.value
);
const firstAvailableEntry = computed(() => visibleDeviceEntries.value.find((entry) => entry.visibleGoods.length));

const load = async () => {
  await sessionStore.bootstrap();

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
    records.value = recordResponse;
    sessionStore.setQuota(quotaResponse);
  } catch (error) {
    uni.showToast({
      title: getErrorMessage(error),
      icon: "none"
    });
  } finally {
    loading.value = false;
  }
};

const openDeviceDetail = (deviceCode: string) => {
  uni.navigateTo({
    url: `/pages/special/device-detail?deviceCode=${deviceCode}`
  });
};

const goHistory = () => {
  uni.navigateTo({
    url: "/pages/special/history"
  });
};

const goNearbyTab = () => {
  uni.switchTab({
    url: "/pages/tabs/nearby"
  });
};

const goFeedback = (deviceCode?: string) => {
  uni.navigateTo({
    url: deviceCode ? `/pages/common/feedback?deviceCode=${deviceCode}` : "/pages/common/feedback"
  });
};

const scanAndOpen = async () => {
  try {
    const scannedDeviceCode = await scanDeviceCode();

    if (!scannedDeviceCode) {
      uni.showToast({
        title: "未识别到柜机编号",
        icon: "none"
      });
      return;
    }

    await mobileApi.getDevice(scannedDeviceCode);
    uni.navigateTo({
      url: `/pages/special/device-detail?deviceCode=${encodeURIComponent(scannedDeviceCode)}&scan=1`
    });
  } catch (error) {
    uni.showToast({
      title: getErrorMessage(error),
      icon: "none"
    });
  }
};

const formatDateTime = (value: string) => value.slice(0, 16).replace("T", " ");

onShow(() => {
  load();
});
</script>

<template>
  <MobileShell
    eyebrow="用户"
    :title="`${sessionStore.user?.name ?? '访客'}，您好`"
    :subtitle="accessibilityEnabled ? '显示柜机名称、地点和可选货物。' : appCopy.specialWelcome"
  >
    <view v-if="!accessibilityEnabled" class="special-dashboard">
      <view class="special-hero">
        <view class="special-hero__copy">
          <view>
            <text class="special-hero__hello">您好，{{ sessionStore.user?.name ?? "访客" }}</text>
            <text class="special-hero__subtitle">小柜大爱 · 与爱同行</text>
          </view>
          <text class="special-hero__badge">{{ totalRemaining > 0 ? "已认证" : "待刷新" }}</text>
        </view>

        <view class="today-card">
          <view class="today-card__head">
            <view>
              <text class="today-card__eyebrow">今日资格</text>
              <text class="today-card__title">{{ totalRemaining > 0 ? "今日可领取" : "当前暂无可领取" }}</text>
            </view>
            <text class="vm-status" :class="totalRemaining > 0 ? 'vm-status--available' : 'vm-status--warning'">
              {{ serviceWindows.length ? "开放中" : "未到时段" }}
            </text>
          </view>

          <view class="today-card__metrics">
            <view class="today-card__metric">
              <text class="today-card__number vm-number">{{ totalRemaining }}</text>
              <text class="today-card__label">可领取</text>
            </view>
            <view class="today-card__metric">
              <text class="today-card__number vm-number">{{ usedCount }}</text>
              <text class="today-card__label">已领取</text>
            </view>
            <view class="today-card__metric">
              <text class="today-card__number vm-number">{{ permissionList.length }}</text>
              <text class="today-card__label">可选种类</text>
            </view>
          </view>

          <view class="today-card__window">
            <text>{{ serviceWindows.length ? `开放时段 ${serviceWindows.join("、")}` : "当前暂无开放时段，系统会自动刷新资格。" }}</text>
          </view>
        </view>
      </view>

      <view class="category-grid">
        <view
          v-for="item in categorySummaries"
          :key="item.key"
          class="category-card"
          :class="`category-card--${item.tone}`"
        >
          <MenuIcon :name="item.icon" size="md" tone="accent" />
          <text class="category-card__title">{{ item.label }}</text>
          <text class="category-card__meta">{{ item.quantity }} 件可领</text>
        </view>
      </view>

      <view class="special-action-stack">
        <button class="special-scan-button" @tap="scanAndOpen">
          <MenuIcon name="scan" size="sm" tone="contrast" />
          <text>扫码开柜</text>
        </button>
        <button class="special-find-button" @tap="goNearbyTab">
          <MenuIcon name="nearby" size="sm" tone="accent" />
          <text>就近找柜机</text>
        </button>
        <text class="special-action-stack__hint">领取时请及时关门，传递爱心</text>
      </view>

      <button v-if="firstAvailableEntry" class="nearest-card" @tap="openDeviceDetail(firstAvailableEntry.device.deviceCode)">
        <view class="nearest-card__media" aria-hidden="true">
          <view class="nearest-card__machine" />
        </view>
        <view class="nearest-card__main">
          <text class="nearest-card__label">推荐柜机</text>
          <text class="nearest-card__title">{{ firstAvailableEntry.device.name }}</text>
          <text class="nearest-card__meta">{{ firstAvailableEntry.device.location }}</text>
        </view>
        <text class="vm-status vm-status--success">今日可领</text>
      </button>

      <GlassCard tone="quiet" compact>
        <view class="vm-stack">
          <view v-if="permissionList.length" class="permission-list">
            <view v-for="item in permissionList" :key="item.goodsId" class="permission-item">
              <view class="permission-item__main">
                <text class="permission-item__title">{{ item.goodsName }}</text>
                <text class="permission-item__meta">
                  {{ item.category ? categoryLabelMap[item.category] : "物资" }}
                </text>
              </view>
              <text class="vm-status vm-status--success">今日可领 {{ item.quantity }} 件</text>
            </view>
          </view>
          <EmptyState v-else title="当前无可领取额度" description="系统会按服务时间段和个人策略自动刷新权限，不需要重复提交。" />

          <view class="care-note">
            <text class="care-note__title">服务说明</text>
            <text class="care-note__body">{{ guidanceText }}</text>
          </view>
        </view>
      </GlassCard>
    </view>

    <view class="vm-section">
      <view class="section-heading">
        <text class="section-heading__title">附近柜机</text>
        <text class="vm-subtitle">
          {{ accessibilityEnabled ? "仅保留柜机名称、地点和可选货物。" : "可先查看位置、库存和免费额度，再决定前往哪一台柜机。" }}
        </text>
      </view>

      <view v-if="visibleDeviceEntries.length" class="device-list">
        <GlassCard v-for="entry in visibleDeviceEntries" :key="entry.device.deviceCode">
          <view class="vm-stack">
            <view class="device-header">
              <view class="device-header__main">
                <text class="device-header__title">{{ entry.device.name }}</text>
                <text class="vm-subtitle">{{ entry.device.location }}</text>
              </view>
              <text v-if="!accessibilityEnabled" class="vm-status" :class="`vm-status--${statusToneMap[entry.device.status]}`">
                {{ statusLabelMap[entry.device.status] }}
              </text>
            </view>

            <view v-if="!accessibilityEnabled" class="device-meta">
              <text>柜机编号 {{ entry.device.deviceCode }}</text>
              <text>最近在线 {{ formatDateTime(entry.device.lastSeenAt) }}</text>
            </view>

            <view v-if="entry.visibleGoods.length" class="goods-list">
              <view v-for="goods in entry.visibleGoods" :key="goods.goodsId" class="goods-item">
                <view class="goods-item__main">
                  <text class="goods-item__name">{{ goods.name }}</text>
                  <text class="goods-item__meta">
                    {{
                      accessibilityEnabled
                        ? `今日免费 ${sessionStore.quota?.remainingByGoods?.[goods.goodsId] ?? 0} 件`
                        : `${categoryLabelMap[goods.category]} · 现有 ${goods.stock ?? 0} 件 · 免费 ${sessionStore.quota?.remainingByGoods?.[goods.goodsId] ?? 0} 件`
                    }}
                  </text>
                </view>
                <text v-if="!accessibilityEnabled && goods.expiresAt" class="goods-item__tag">至 {{ goods.expiresAt.slice(5, 10) }}</text>
              </view>
            </view>
            <EmptyState
              v-else
              title="当前没有可选货物"
              :description="accessibilityEnabled ? '' : '这台柜机目前没有柜内有库存的可选货品。'"
            />

            <view class="action-grid" :class="{ 'action-grid--single': accessibilityEnabled }">
              <button class="vm-button" @tap="openDeviceDetail(entry.device.deviceCode)">选择货品并取货</button>
              <button v-if="!accessibilityEnabled" class="vm-button vm-button--ghost" @tap="goFeedback(entry.device.deviceCode)">
                反馈这台柜机
              </button>
            </view>
          </view>
        </GlassCard>
      </view>
      <GlassCard v-else tone="quiet">
        <EmptyState
          :title="loading ? '正在加载柜机信息' : accessibilityEnabled ? '附近暂无可选货物' : '附近暂无可用柜机'"
          :description="loading ? '请稍候，系统正在同步设备状态。' : accessibilityEnabled ? '稍后再来查看，系统会按库存自动刷新。' : '请联系工作人员确认设备接入状态。'"
        />
      </GlassCard>
    </view>

    <GlassCard v-if="!accessibilityEnabled" tone="quiet">
      <view class="vm-stack">
        <view class="section-heading">
          <text class="section-heading__title">最近服务记录</text>
          <text class="vm-subtitle">只展示最近三次结果，完整记录可继续进入服务记录页查看。</text>
        </view>

        <view v-if="records.length" class="permission-list">
          <view v-for="record in records.slice(0, 3)" :key="record.id" class="permission-item">
            <view class="permission-item__main">
              <text class="permission-item__title">{{ record.goodsName }}</text>
              <text class="permission-item__meta">{{ record.deviceCode }} · {{ formatDateTime(record.happenedAt) }}</text>
            </view>
            <text class="vm-status vm-status--success">领取 {{ record.quantity }} 件</text>
          </view>
        </view>
        <EmptyState v-else title="还没有服务记录" description="首次领取成功后，这里会自动展示最近操作。" />
      </view>
    </GlassCard>
  </MobileShell>
</template>

<style scoped>
.section-heading,
.permission-item__main,
.device-header__main,
.goods-item__main {
  display: flex;
  flex-direction: column;
  gap: 10rpx;
}

.section-heading__title,
.permission-item__title,
.device-header__title,
.goods-item__name,
.care-note__title {
  font-size: 30rpx;
  font-weight: 700;
  color: var(--vm-text);
}

.permission-item__meta,
.device-meta,
.goods-item__meta,
.care-note__body {
  font-size: 22rpx;
  color: var(--vm-text-soft);
  line-height: 1.6;
}

.permission-list,
.device-list,
.goods-list,
.category-grid,
.today-card,
.special-dashboard,
.special-action-stack,
.nearest-card__main {
  display: grid;
  gap: 16rpx;
}

.category-grid {
  grid-template-columns: repeat(3, minmax(0, 1fr));
}

.special-dashboard {
  gap: 20rpx;
}

.special-hero {
  position: relative;
  display: grid;
  gap: 22rpx;
  padding: 28rpx 26rpx 26rpx;
  border-radius: 32rpx;
  background:
    radial-gradient(circle at 82% 18%, rgba(255, 255, 255, 0.22), transparent 28%),
    linear-gradient(135deg, #2e7d46 0%, #60b45a 100%);
  box-shadow: 0 20rpx 48rpx rgba(46, 125, 70, 0.2);
  overflow: hidden;
}

.special-hero::after {
  content: "";
  position: absolute;
  right: -42rpx;
  bottom: -62rpx;
  width: 230rpx;
  height: 170rpx;
  border-radius: 50%;
  background: rgba(255, 255, 255, 0.1);
}

.special-hero__copy,
.special-hero__badge,
.special-scan-button,
.special-find-button {
  display: flex;
  align-items: center;
}

.special-hero__copy {
  position: relative;
  z-index: 1;
  justify-content: space-between;
  gap: 20rpx;
}

.special-hero__hello {
  display: block;
  font-size: 34rpx;
  line-height: 1.2;
  font-weight: 900;
  color: #ffffff;
}

.special-hero__subtitle {
  display: block;
  margin-top: 8rpx;
  font-size: 23rpx;
  color: rgba(255, 255, 255, 0.86);
}

.special-hero__badge {
  flex-shrink: 0;
  min-height: 44rpx;
  padding: 0 18rpx;
  border-radius: 999rpx;
  background: rgba(255, 255, 255, 0.22);
  color: #ffffff;
  font-size: 22rpx;
  font-weight: 800;
  border: 1rpx solid rgba(255, 255, 255, 0.24);
}

.today-card {
  position: relative;
  z-index: 1;
  padding: 26rpx;
  border-radius: 26rpx;
  border: 1rpx solid rgba(255, 255, 255, 0.42);
  background: rgba(255, 255, 255, 0.94);
  box-shadow: 0 18rpx 42rpx rgba(31, 106, 58, 0.14);
}

.today-card__head,
.today-card__metrics,
.nearest-card {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 18rpx;
}

.today-card__eyebrow,
.nearest-card__label {
  display: block;
  font-size: 22rpx;
  color: var(--vm-accent-strong);
}

.today-card__title {
  display: block;
  margin-top: 8rpx;
  font-size: 34rpx;
  font-weight: 900;
  color: var(--vm-text);
}

.today-card__metrics {
  padding: 22rpx 0;
  border-top: 1rpx solid var(--vm-line);
  border-bottom: 1rpx solid var(--vm-line);
}

.today-card__metric {
  flex: 1;
  display: grid;
  gap: 8rpx;
  text-align: center;
}

.today-card__number {
  font-size: 46rpx;
  line-height: 1;
  font-weight: 900;
  color: var(--vm-accent-strong);
}

.today-card__label,
.today-card__window,
.nearest-card__meta {
  font-size: 22rpx;
  color: var(--vm-text-soft);
  line-height: 1.55;
}

.today-card__window {
  padding: 16rpx 18rpx;
  border-radius: 18rpx;
  background: rgba(46, 125, 70, 0.08);
  color: var(--vm-accent-strong);
}

.category-card {
  display: grid;
  justify-items: center;
  gap: 10rpx;
  min-height: 154rpx;
  padding: 20rpx 12rpx;
  border-radius: 24rpx;
  border: 1rpx solid var(--vm-line);
  background: var(--vm-surface-strong);
}

.category-card--drink {
  background: #eef6ff;
  border-color: rgba(66, 139, 214, 0.18);
}

.category-card--food {
  background: #fff3e2;
  border-color: var(--vm-warning-line);
}

.category-card--daily {
  background: #f0f6ea;
  border-color: var(--vm-success-line);
}

.category-card__title {
  font-size: 26rpx;
  font-weight: 800;
  color: var(--vm-text);
}

.category-card__meta {
  font-size: 22rpx;
  color: var(--vm-text-soft);
}

.special-action-stack {
  gap: 14rpx;
}

.special-scan-button,
.special-find-button {
  width: 100%;
  min-height: 88rpx;
  justify-content: center;
  gap: 12rpx;
  border-radius: 24rpx;
  font-size: 30rpx;
  font-weight: 900;
}

.special-scan-button {
  background: linear-gradient(135deg, var(--vm-warning), #ff9a33);
  color: #ffffff;
  box-shadow: 0 18rpx 38rpx rgba(255, 138, 43, 0.2);
}

.special-find-button {
  background: #ffffff;
  color: var(--vm-accent-strong);
  border: 1rpx solid var(--vm-accent-line);
}

.special-action-stack__hint {
  text-align: center;
  font-size: 22rpx;
  color: var(--vm-text-soft);
}

.nearest-card {
  width: 100%;
  display: grid;
  grid-template-columns: auto minmax(0, 1fr) auto;
  align-items: center;
  gap: 18rpx;
  padding: 20rpx;
  border-radius: 24rpx;
  border: 1rpx solid var(--vm-success-line);
  background: #ffffff;
  text-align: left;
}

.nearest-card__media {
  display: grid;
  place-items: center;
  width: 108rpx;
  height: 108rpx;
  border-radius: 20rpx;
  background: linear-gradient(180deg, #fff4e6, #eaf6e4);
  overflow: hidden;
}

.nearest-card__machine {
  position: relative;
  width: 58rpx;
  height: 82rpx;
  border-radius: 10rpx;
  background: #2e7d46;
  box-shadow: inset 0 0 0 5rpx rgba(255, 255, 255, 0.26);
}

.nearest-card__machine::before {
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

.nearest-card__title {
  font-size: 30rpx;
  font-weight: 800;
  color: var(--vm-text);
}

.permission-item,
.goods-item,
.care-note {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 18rpx;
  padding: 22rpx 24rpx;
  border-radius: 24rpx;
  background: var(--vm-surface-soft);
  border: 1rpx solid var(--vm-line);
}

.care-note {
  display: grid;
  align-items: start;
}

.device-header,
.device-meta {
  display: flex;
  justify-content: space-between;
  align-items: flex-start;
  gap: 16rpx;
}

.device-meta {
  align-items: center;
  flex-wrap: wrap;
}

.action-grid {
  display: grid;
  gap: 16rpx;
  grid-template-columns: repeat(2, minmax(0, 1fr));
}

.action-grid--single {
  grid-template-columns: 1fr;
}

.action-grid__full {
  grid-column: 1 / -1;
}

.goods-item__tag {
  flex-shrink: 0;
  padding: 10rpx 16rpx;
  border-radius: 999rpx;
  background: var(--vm-highlight-soft);
  color: var(--vm-warning);
  font-size: 22rpx;
}

.vm-page--accessible .device-header__title,
.vm-page--accessible .goods-item__name {
  font-size: 38rpx;
}

.vm-page--accessible .goods-item {
  align-items: flex-start;
}

.vm-page--accessible .goods-item__meta {
  font-size: 28rpx;
  color: var(--vm-text);
}
</style>

