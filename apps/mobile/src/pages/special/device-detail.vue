<script setup lang="ts">
import { computed, reactive, ref } from "vue";
import { onLoad } from "@dcloudio/uni-app";

import type { GoodsCategory } from "@vm/shared-types";

import { mobileApi } from "../../api/mobile";
import EmptyState from "../../components/ui/EmptyState.vue";
import GlassCard from "../../components/ui/GlassCard.vue";
import ServiceMetric from "../../components/ui/ServiceMetric.vue";
import MobileShell from "../../layouts/MobileShell.vue";
import { categoryLabelMap } from "../../constants/labels";
import { useSessionStore } from "../../stores/session";
import { useUiPreferencesStore } from "../../stores/ui-preferences";
import { getErrorMessage } from "../../utils/error-message";
import { getReceivableLimit } from "../../utils/receivable-goods";

const sessionStore = useSessionStore();
const uiPreferencesStore = useUiPreferencesStore();
const FAR_DISTANCE_WARNING_METERS = 500;
const loading = ref(false);
const submitting = ref(false);
const deviceCode = ref("");
const scanMode = ref(false);
const deviceName = ref("柜机详情");
const location = ref("");
const deviceAddress = ref("");
const deviceLongitude = ref<number>();
const deviceLatitude = ref<number>();
const manualDistanceMeters = ref<number>();
const manualDistanceState = ref<"scan" | "near" | "far" | "unknown">("unknown");
const goodsList = ref<Array<{
  goodsCode: string;
  goodsId: string;
  name: string;
  price: number;
  imageUrl: string;
  category: GoodsCategory;
  stock?: number;
  expiresAt?: string;
}>>([]);
const selectedMap = reactive<Record<string, number>>({});

uiPreferencesStore.hydrate();

const selectedItems = computed(() =>
  goodsList.value
    .map((item) => ({
      goodsId: item.goodsId,
      goodsName: item.name,
      quantity: selectedMap[item.goodsId] ?? 0,
      category: item.category
    }))
    .filter((item) => item.quantity > 0)
);

const selectedSummary = computed(() =>
  selectedItems.value.map((item) => `${item.goodsName} x${item.quantity}`).join("、")
);

const selectedTotal = computed(() =>
  selectedItems.value.reduce((total, item) => total + item.quantity, 0)
);

const availableGoodsCount = computed(() =>
  goodsList.value.filter((item) => (item.stock ?? 0) > 0).length
);
const accessibilityEnabled = computed(() => uiPreferencesStore.isAccessibilityEnabled(sessionStore.user?.role));
const hasNavigationTarget = computed(
  () => typeof deviceLongitude.value === "number" && typeof deviceLatitude.value === "number"
);
const navigationAddress = computed(
  () => deviceAddress.value || location.value || deviceName.value || "柜机位置"
);

const distanceBanner = computed(() => {
  if (scanMode.value) {
    return {
      tone: "success",
      title: "已通过扫码识别柜机",
      lines: ["当前默认你已经站在柜机旁，可直接确认可领取货品后开柜。"]
    };
  }

  if (manualDistanceState.value === "far") {
    return {
      tone: "warning",
      title: "请先核对你与柜机的相对距离",
      lines: [
        `当前检测你距离这台柜机约 ${formatDistance(manualDistanceMeters.value)}，可能不是你身边的设备。`,
        "请先确认柜机名称、位置和实际站位，避免误开其他柜机。"
      ]
    };
  }

  if (manualDistanceState.value === "near") {
    return {
      tone: "accent",
      title: "已确认你就在柜机附近",
      lines: [
        `当前检测距离约 ${formatDistance(manualDistanceMeters.value)}，可以继续选择货品。`,
        "本页只展示你今天仍可领取且柜内有库存的货品。"
      ]
    };
  }

  return {
    tone: "warning",
    title: "暂未确认你与柜机的相对距离",
    lines: ["如果不是扫码进入，建议站到柜机旁后再继续操作。", "本页只展示你今天仍可领取且柜内有库存的货品。"]
  };
});

const openGuideText = computed(() =>
  scanMode.value
    ? "当前通过扫码识别柜机，确认货品后可直接发起开柜，最终结算会以平台识别结果为准。"
    : "建议站在柜机旁再操作，先选好计划领取的货品，取货后及时关门。"
);

const load = async () => {
  await sessionStore.bootstrap();

  if (!sessionStore.user || !deviceCode.value) {
    uni.reLaunch({
      url: "/pages/common/login"
    });
    return;
  }

  loading.value = true;
  try {
    const [device, goods, quota] = await Promise.all([
      mobileApi.getDevice(deviceCode.value),
      mobileApi.queryGoods(deviceCode.value),
      mobileApi.getQuotaSummary(sessionStore.user.phone)
    ]);

    deviceName.value = device.name;
    location.value = device.location;
    deviceAddress.value = device.address ?? "";
    deviceLongitude.value = device.longitude;
    deviceLatitude.value = device.latitude;
    sessionStore.setQuota(quota);
    goodsList.value = goods.filter(
      (item) => getReceivableLimit(quota, item.goodsId) > 0 && (item.stock ?? 0) > 0
    );
    for (const key of Object.keys(selectedMap)) {
      delete selectedMap[key];
    }
    await inspectRelativeDistance(device);
  } catch (error) {
    uni.showToast({
      title: getErrorMessage(error),
      icon: "none"
    });
  } finally {
    loading.value = false;
  }
};

const calculateDistanceMeters = (
  latitudeA: number,
  longitudeA: number,
  latitudeB: number,
  longitudeB: number
) => {
  const toRadians = (value: number) => (value * Math.PI) / 180;
  const earthRadius = 6371_000;
  const latitudeDelta = toRadians(latitudeB - latitudeA);
  const longitudeDelta = toRadians(longitudeB - longitudeA);
  const sinLatitude = Math.sin(latitudeDelta / 2);
  const sinLongitude = Math.sin(longitudeDelta / 2);
  const a =
    sinLatitude * sinLatitude +
    Math.cos(toRadians(latitudeA)) * Math.cos(toRadians(latitudeB)) * sinLongitude * sinLongitude;

  return Math.round(earthRadius * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a)));
};

const inspectRelativeDistance = async (device: {
  longitude?: number;
  latitude?: number;
  name: string;
}) => {
  if (scanMode.value) {
    manualDistanceState.value = "scan";
    return;
  }

  if (device.longitude === undefined || device.latitude === undefined) {
    if (manualDistanceMeters.value !== undefined) {
      manualDistanceState.value =
        manualDistanceMeters.value > FAR_DISTANCE_WARNING_METERS ? "far" : "near";
      return;
    }

    manualDistanceState.value = "unknown";
    return;
  }

  try {
    const currentLocation = await new Promise<UniApp.GetLocationSuccess>((resolve, reject) => {
      uni.getLocation({
        type: "gcj02",
        success: resolve,
        fail: reject
      });
    });

    manualDistanceMeters.value = calculateDistanceMeters(
      currentLocation.latitude,
      currentLocation.longitude,
      device.latitude,
      device.longitude
    );
    manualDistanceState.value =
      manualDistanceMeters.value > FAR_DISTANCE_WARNING_METERS ? "far" : "near";

    if (manualDistanceState.value === "far") {
      uni.showModal({
        title: "距离提醒",
        content: `系统检测你距离 ${device.name} 约 ${formatDistance(manualDistanceMeters.value)}。如果这不是你身边的柜机，请返回重新选择或改用扫码进入。`,
        showCancel: false
      });
    }
  } catch {
    if (manualDistanceMeters.value !== undefined) {
      manualDistanceState.value =
        manualDistanceMeters.value > FAR_DISTANCE_WARNING_METERS ? "far" : "near";
      return;
    }

    manualDistanceState.value = "unknown";
  }
};

const getRemaining = (goodsId: string) => sessionStore.quota?.remainingByGoods?.[goodsId] ?? 0;

const updateSelected = (goodsId: string, delta: number) => {
  const current = selectedMap[goodsId] ?? 0;
  const max = Math.max(0, getRemaining(goodsId));
  const next = Math.min(max, Math.max(0, current + delta));
  selectedMap[goodsId] = next;
};

const performOpen = async () => {
  if (!sessionStore.user || !selectedItems.value.length) {
    uni.showModal({
      title: "请选择商品",
      content: "正式开柜前需要先选择本次计划领取的商品。",
      showCancel: false
    });
    return;
  }

  submitting.value = true;
  try {
    const response = await mobileApi.openCabinet({
      phone: sessionStore.user.phone,
      deviceCode: deviceCode.value,
      doorNum: "1",
      category: selectedItems.value[0]?.category,
      openMode: scanMode.value ? "scan" : "manual",
      intentItems: selectedItems.value.map((item) => ({
        goodsId: item.goodsId,
        goodsName: item.goodsName,
        quantity: item.quantity,
        category: item.category
      }))
    });

    if (response.remainingQuota) {
      sessionStore.setQuota({
        ...sessionStore.quota,
        remainingToday: response.remainingQuota
      });
    }

    uni.redirectTo({
      url: `/pages/common/opening?eventId=${encodeURIComponent(response.eventId)}&deviceCode=${encodeURIComponent(response.deviceCode)}`
    });
  } catch (error) {
    uni.reLaunch({
      url: `/pages/common/result?status=danger&title=${encodeURIComponent(scanMode.value ? "扫码开柜失败" : "手动开柜失败")}&detail=${encodeURIComponent(getErrorMessage(error))}&actionText=${encodeURIComponent("重新尝试")}&backUrl=${encodeURIComponent(`/pages/special/device-detail?deviceCode=${deviceCode.value}${scanMode.value ? "&scan=1" : ""}`)}`
    });
  } finally {
    submitting.value = false;
  }
};

const submit = () => {
  if (!selectedItems.value.length) {
    uni.showModal({
      title: "请选择商品",
      content: "正式开柜前需要先选择本次计划领取的商品。",
      showCancel: false
    });
    return;
  }

  uni.showModal({
    title: scanMode.value ? "确认扫码开柜" : "确认手动开柜",
    content: scanMode.value
      ? `即将按扫码流程开柜，已选择：${selectedSummary.value}。柜门关闭后会按平台实际识别结果结算。`
      : `${manualDistanceState.value === "far" ? `当前检测你距离柜机约 ${formatDistance(manualDistanceMeters.value)}，请先确认不是误点了其他柜机。` : "请确认你已经在柜机旁，并准备好立即取货和及时关门。"}已选择：${selectedSummary.value}。`,
    confirmText: scanMode.value ? "确认开柜" : "继续开柜",
    success: ({ confirm }) => {
      if (confirm) {
        void performOpen();
      }
    }
  });
};

const goFeedback = () => {
  uni.navigateTo({
    url: `/pages/common/feedback?deviceCode=${deviceCode.value}`
  });
};

const openNavigation = () => {
  if (!hasNavigationTarget.value) {
    uni.showModal({
      title: "暂无导航坐标",
      content: "这台柜机还没有设置经纬度，暂时无法打开导航。",
      showCancel: false
    });
    return;
  }

  uni.openLocation({
    longitude: deviceLongitude.value as number,
    latitude: deviceLatitude.value as number,
    name: deviceName.value || "柜机位置",
    address: navigationAddress.value,
    scale: 18,
    fail: (error) => {
      uni.showModal({
        title: "无法打开导航",
        content: `系统未能打开地图能力：${getErrorMessage(error)}`,
        showCancel: false
      });
    }
  });
};

const formatDistance = (distanceMeters?: number) => {
  if (distanceMeters === undefined) {
    return "未知距离";
  }

  if (distanceMeters < 1000) {
    return `${distanceMeters} 米`;
  }

  return `${(distanceMeters / 1000).toFixed(1)} 公里`;
};

onLoad((query) => {
  deviceCode.value = typeof query.deviceCode === "string" ? query.deviceCode : "";
  scanMode.value = query.scan === "1";
  manualDistanceMeters.value =
    typeof query.distanceMeters === "string" && !Number.isNaN(Number(query.distanceMeters))
      ? Number(query.distanceMeters)
      : undefined;
  load();
});
</script>

<template>
  <MobileShell eyebrow="柜机详情" :title="deviceName" :subtitle="location || deviceAddress || '请先确认柜机位置和货品信息'">
    <GlassCard tone="accent">
      <view class="vm-stack">
        <view v-if="!accessibilityEnabled" class="section-heading">
          <text class="section-heading__title">本次领取计划</text>
          <text class="vm-subtitle">请先选择本次要领取的货品，再确认开柜。</text>
        </view>

        <view v-if="!accessibilityEnabled" class="overview-grid">
          <ServiceMetric label="已选种类" :value="selectedItems.length" hint="已加入本次计划的货品种类" tone="accent" />
          <ServiceMetric label="已选件数" :value="selectedTotal" hint="会按你的实时资格限制上限" />
          <ServiceMetric label="可选货品" :value="availableGoodsCount" hint="当前柜机仍有库存的货品种类" />
        </view>

        <view v-if="!accessibilityEnabled" class="selection-banner">
          <text class="selection-banner__label">{{ scanMode ? "扫码模式" : "手动模式" }}</text>
          <text class="selection-banner__value">{{ selectedSummary || "暂未选择货品" }}</text>
          <text class="selection-banner__hint">{{ openGuideText }}</text>
          <text class="selection-banner__hint">正式结算仍以柜门关闭后的平台识别结果为准。</text>
        </view>

        <view v-if="!accessibilityEnabled" class="distance-banner" :class="`distance-banner--${distanceBanner.tone}`">
          <text class="distance-banner__title">{{ distanceBanner.title }}</text>
          <text v-for="line in distanceBanner.lines" :key="line" class="distance-banner__body">{{ line }}</text>
        </view>

        <view v-if="goodsList.length" class="goods-list">
          <view v-for="goods in goodsList" :key="goods.goodsId" class="goods-item">
            <view class="goods-item__main">
              <text class="goods-item__name">{{ goods.name }}</text>
              <text class="goods-item__meta">
                {{
                  accessibilityEnabled
                    ? `今日可领 ${getRemaining(goods.goodsId)} 件`
                    : `${categoryLabelMap[goods.category]} · 现有 ${goods.stock ?? 0} 件 · 可领 ${getRemaining(goods.goodsId)} 件`
                }}
              </text>
              <text v-if="!accessibilityEnabled && goods.expiresAt" class="goods-item__hint">
                批次到期 {{ goods.expiresAt.slice(5, 16).replace("T", " ") }}
              </text>
            </view>
            <view class="stepper">
              <button class="stepper__button" @tap="updateSelected(goods.goodsId, -1)">-</button>
              <text class="stepper__value">{{ selectedMap[goods.goodsId] ?? 0 }}</text>
              <button class="stepper__button" @tap="updateSelected(goods.goodsId, 1)">+</button>
            </view>
          </view>
        </view>
        <EmptyState
          v-else
          :title="loading ? '正在加载货品信息' : '当前没有你今天可领取的货品'"
          :description="loading ? '请稍候，系统正在同步柜机商品列表。' : accessibilityEnabled ? '' : '本页只展示你今天仍可领取且柜内有库存的货品。'"
        />

        <view class="action-stack">
          <button class="vm-button" :loading="submitting" @tap="submit">
            {{ scanMode ? "确认货品并扫码开柜" : "确认货品并手动开柜" }}
          </button>
          <button v-if="!accessibilityEnabled && hasNavigationTarget" class="vm-button vm-button--ghost" @tap="openNavigation">
            导航到此柜机
          </button>
          <button v-if="!accessibilityEnabled" class="vm-button vm-button--ghost" @tap="goFeedback">反馈这台柜机的问题</button>
        </view>
      </view>
    </GlassCard>
  </MobileShell>
</template>

<style scoped>
.section-heading,
.goods-item__main {
  display: flex;
  flex-direction: column;
  gap: 10rpx;
}

.section-heading__title,
.goods-item__name {
  font-size: 30rpx;
  font-weight: 700;
  color: var(--vm-text);
}

.goods-item__meta,
.goods-item__hint,
.selection-banner__hint,
.distance-banner__body {
  font-size: 22rpx;
  color: var(--vm-text-soft);
  line-height: 1.6;
}

.overview-grid,
.goods-list,
.action-stack,
.distance-banner {
  display: grid;
  gap: 16rpx;
}

.selection-banner,
.goods-item {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 18rpx;
  padding: 22rpx 24rpx;
  border-radius: 24rpx;
  background: var(--vm-surface-soft);
  border: 1rpx solid var(--vm-line);
}

.selection-banner {
  display: grid;
}

.selection-banner__label {
  font-size: 22rpx;
  color: var(--vm-accent-strong);
}

.selection-banner__value {
  font-size: 28rpx;
  color: var(--vm-text);
  font-weight: 700;
  line-height: 1.5;
}

.distance-banner {
  padding: 22rpx 24rpx;
  border-radius: 24rpx;
  border: 1rpx solid var(--vm-line);
}

.distance-banner--accent {
  background: var(--vm-info-bg);
  border-color: var(--vm-info-line);
}

.distance-banner--warning {
  background: var(--vm-warning-bg);
  border-color: var(--vm-warning-line);
}

.distance-banner--success {
  background: var(--vm-success-bg);
  border-color: var(--vm-success-line);
}

.distance-banner__title {
  font-size: 28rpx;
  font-weight: 700;
  color: var(--vm-text);
}

.stepper {
  display: flex;
  align-items: center;
  gap: 16rpx;
}

.stepper__button {
  width: 76rpx;
  min-height: 76rpx;
  border-radius: 22rpx;
  border: 1rpx solid var(--vm-line-strong);
  background: var(--vm-surface-strong);
  font-size: 34rpx;
  color: var(--vm-text);
}

.stepper__value {
  min-width: 48rpx;
  text-align: center;
  font-size: 30rpx;
  font-weight: 700;
}

.vm-page--accessible .goods-item {
  flex-direction: column;
  align-items: stretch;
}

.vm-page--accessible .goods-item__name {
  font-size: 38rpx;
}

.vm-page--accessible .goods-item__meta {
  font-size: 28rpx;
  color: var(--vm-text);
}

.vm-page--accessible .stepper {
  justify-content: space-between;
}

.vm-page--accessible .stepper__button {
  width: 120rpx;
  min-height: 100rpx;
  border-width: 3rpx;
  font-size: 42rpx;
}

.vm-page--accessible .stepper__value {
  min-width: 96rpx;
  font-size: 40rpx;
}
</style>

