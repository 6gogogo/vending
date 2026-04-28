<script setup lang="ts">
import { computed, reactive, ref } from "vue";
import { onLoad } from "@dcloudio/uni-app";

import type {
  CabinetOpenRequest,
  CabinetPreSettlement,
  CabinetReservationRecord,
  GoodsCategory,
  ReservationSettings
} from "@vm/shared-types";

import { mobileApi } from "../../api/mobile";
import EmptyState from "../../components/ui/EmptyState.vue";
import GlassCard from "../../components/ui/GlassCard.vue";
import ServiceMetric from "../../components/ui/ServiceMetric.vue";
import MobileShell from "../../layouts/MobileShell.vue";
import { categoryLabelMap } from "../../constants/labels";
import { useSessionStore } from "../../stores/session";
import { useUiPreferencesStore } from "../../stores/ui-preferences";
import { getErrorMessage } from "../../utils/error-message";

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
const preSettlement = ref<CabinetPreSettlement>();
const reservationSettings = ref<ReservationSettings>();
const reservations = ref<CabinetReservationRecord[]>([]);

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

const activeReservations = computed(() =>
  reservations.value
    .filter((item) => item.status === "active" && item.deviceCode === deviceCode.value)
    .sort((left, right) => Date.parse(left.expiresAt) - Date.parse(right.expiresAt))
);

const nearestReservation = computed(() => activeReservations.value[0]);

const reservationSummary = computed(() => {
  const reservation = nearestReservation.value;

  if (!reservation) {
    return "";
  }

  return reservation.items.map((item) => `${item.goodsName} x${item.quantity}`).join("、");
});

const selectedGoodsDetails = computed(() =>
  selectedItems.value.map((item) => {
    const goods = goodsList.value.find((entry) => entry.goodsId === item.goodsId);
    const freeQuantity = Math.min(item.quantity, Math.max(0, getRemaining(item.goodsId)));
    const paidQuantity = Math.max(0, item.quantity - freeQuantity);
    const unitPrice = goods?.price ?? 0;

    return {
      ...item,
      stock: goods?.stock ?? 0,
      unitPrice,
      freeQuantity,
      paidQuantity,
      paidAmount: paidQuantity * unitPrice
    };
  })
);

const selectedFreeTotal = computed(() =>
  selectedGoodsDetails.value.reduce((total, item) => total + item.freeQuantity, 0)
);

const selectedPaidTotal = computed(() =>
  selectedGoodsDetails.value.reduce((total, item) => total + item.paidQuantity, 0)
);

const estimatedPayableAmount = computed(() =>
  selectedGoodsDetails.value.reduce((total, item) => total + item.paidAmount, 0)
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
      lines: ["当前默认你已经站在柜机旁，可直接确认货品和预结算后开柜。"]
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
        "本页展示柜内有库存的货品，超出免费额度的部分会按商品价格计费。"
      ]
    };
  }

  return {
    tone: "warning",
    title: "暂未确认你与柜机的相对距离",
    lines: ["如果不是扫码进入，建议站到柜机旁后再继续操作。", "超出免费额度的部分会按商品价格计费。"]
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
    const [device, goods, quota, settings, reservationList] = await Promise.all([
      mobileApi.getDevice(deviceCode.value),
      mobileApi.queryGoods(deviceCode.value),
      mobileApi.getQuotaSummary(sessionStore.user.phone),
      mobileApi.reservationSettings(),
      mobileApi.myReservations()
    ]);

    deviceName.value = device.name;
    location.value = device.location;
    deviceAddress.value = device.address ?? "";
    deviceLongitude.value = device.longitude;
    deviceLatitude.value = device.latitude;
    sessionStore.setQuota(quota);
    reservationSettings.value = settings;
    reservations.value = reservationList;
    goodsList.value = goods.filter((item) => (item.stock ?? 0) > 0);
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

function getRemaining(goodsId: string) {
  return sessionStore.quota?.remainingByGoods?.[goodsId] ?? 0;
}

const updateSelected = (goodsId: string, delta: number) => {
  const current = selectedMap[goodsId] ?? 0;
  const goods = goodsList.value.find((item) => item.goodsId === goodsId);
  const max = Math.max(0, goods?.stock ?? 0);
  const next = Math.min(max, Math.max(0, current + delta));
  preSettlement.value = undefined;
  selectedMap[goodsId] = next;
};

const buildOpenPayload = (reservation?: CabinetReservationRecord): CabinetOpenRequest | undefined => {
  const items = reservation?.items ?? selectedItems.value;

  if (!sessionStore.user || !items.length) {
    return undefined;
  }

  return {
    phone: sessionStore.user.phone,
    deviceCode: deviceCode.value,
    doorNum: "1",
    reservationId: reservation?.id,
    category: items[0]?.category,
    openMode: scanMode.value ? "scan" : "manual",
    intentItems: items.map((item) => ({
      goodsId: item.goodsId,
      goodsName: item.goodsName,
      quantity: item.quantity,
      category: item.category
    }))
  };
};

const performOpen = async (payload: CabinetOpenRequest) => {
  submitting.value = true;
  try {
    const response = await mobileApi.openCabinet(payload);
    preSettlement.value = response.preSettlement;

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

const formatPreSettlementContent = (settlement: CabinetPreSettlement) => {
  const lines = settlement.items.map((item) => {
    return `${item.goodsName} x${item.quantity}：${formatSettlementBreakdown(item)}`;
  });

  return [
    settlement.summary,
    ...lines,
    settlement.chargeRequired
      ? "柜门关闭后，若实际拿取与选择一致，将按以上预结算金额支付。"
      : "柜门关闭后，若实际拿取与选择一致，本次无需支付。"
  ].join("\n");
};

const openNoticeText = () => {
  if (scanMode.value) {
    return "当前通过扫码识别柜机，请取货后及时关门。";
  }

  if (manualDistanceState.value === "far") {
    return `当前检测你距离柜机约 ${formatDistance(manualDistanceMeters.value)}，请确认不是误点其他柜机。`;
  }

  return "请确认你已经在柜机旁，并准备好立即取货和及时关门。";
};

const submit = async () => {
  if (!selectedItems.value.length) {
    uni.showModal({
      title: "请选择商品",
      content: "正式开柜前需要先选择本次计划领取的商品。",
      showCancel: false
    });
    return;
  }

  const payload = buildOpenPayload();

  if (!payload) {
    return;
  }

  submitting.value = true;
  try {
    const preview = await mobileApi.previewOpenSettlement(payload);
    const settlement = preview.preSettlement;
    preSettlement.value = settlement;
    submitting.value = false;

    if (!settlement) {
      await performOpen(payload);
      return;
    }

    uni.showModal({
      title: settlement.chargeRequired ? "确认预结算" : "确认免费领取",
      content: `${openNoticeText()}\n${formatPreSettlementContent(settlement)}`,
      confirmText: "确认开柜",
      success: ({ confirm }) => {
        if (confirm) {
          void performOpen(payload);
        }
      }
    });
  } catch (error) {
    submitting.value = false;
    uni.showToast({
      title: getErrorMessage(error),
      icon: "none"
    });
  }
};

const createReservation = async () => {
  if (!selectedItems.value.length) {
    uni.showModal({
      title: "请选择商品",
      content: "预约前需要先选择要保留的货品。",
      showCancel: false
    });
    return;
  }

  submitting.value = true;
  try {
    const reservation = await mobileApi.createReservation({
      deviceCode: deviceCode.value,
      doorNum: "1",
      intentItems: selectedItems.value.map((item) => ({
        goodsId: item.goodsId,
        goodsName: item.goodsName,
        quantity: item.quantity,
        category: item.category
      }))
    });
    reservations.value = [reservation, ...reservations.value.filter((item) => item.id !== reservation.id)];
    uni.showToast({
      title: "预约成功",
      icon: "success"
    });
  } catch (error) {
    uni.showToast({
      title: getErrorMessage(error),
      icon: "none"
    });
  } finally {
    submitting.value = false;
  }
};

const openWithReservation = async (reservation: CabinetReservationRecord) => {
  const payload = buildOpenPayload(reservation);

  if (!payload) {
    return;
  }

  await performOpen(payload);
};

const cancelReservation = async (reservation: CabinetReservationRecord) => {
  submitting.value = true;
  try {
    const updated = await mobileApi.cancelReservation(reservation.id);
    reservations.value = reservations.value.map((item) => (item.id === updated.id ? updated : item));
    uni.showToast({
      title: "已取消预约",
      icon: "success"
    });
  } catch (error) {
    uni.showToast({
      title: getErrorMessage(error),
      icon: "none"
    });
  } finally {
    submitting.value = false;
  }
};

const formatSettlementBreakdown = (item: {
  freeQuantity: number;
  paidQuantity: number;
  paidAmount: number;
}) =>
  `免费 ${item.freeQuantity} 件 · 付费 ${item.paidQuantity} 件${
    item.paidQuantity > 0 ? ` · ${formatCurrency(item.paidAmount)}` : ""
  }`;

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

const formatCurrency = (amount: number) => `￥${(amount / 100).toFixed(2)}`;

const formatShortDateTime = (value: string) => value.slice(5, 16).replace("T", " ");

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
          <ServiceMetric label="已选件数" :value="selectedTotal" :hint="`免费 ${selectedFreeTotal} 件，付费 ${selectedPaidTotal} 件`" />
          <ServiceMetric label="可选货品" :value="availableGoodsCount" hint="当前柜机仍有库存的货品种类" />
        </view>

        <view v-if="!accessibilityEnabled" class="selection-banner">
          <text class="selection-banner__label">{{ scanMode ? "扫码模式" : "手动模式" }}</text>
          <text class="selection-banner__value">{{ selectedSummary || "暂未选择货品" }}</text>
          <text class="selection-banner__hint">{{ openGuideText }}</text>
          <text class="selection-banner__hint">
            {{ estimatedPayableAmount > 0 ? `当前预估需支付 ${formatCurrency(estimatedPayableAmount)}` : "当前选择预计免费" }}，正式结算仍以柜门关闭后的平台识别结果为准。
          </text>
        </view>

        <view v-if="reservationSettings?.enabled && nearestReservation && !accessibilityEnabled" class="reservation-panel">
          <view class="reservation-panel__main">
            <text class="reservation-panel__label">当前预约</text>
            <text class="reservation-panel__title">{{ reservationSummary }}</text>
            <text class="reservation-panel__hint">保留到 {{ formatShortDateTime(nearestReservation.expiresAt) }}</text>
          </view>
          <view class="reservation-panel__actions">
            <button class="reservation-panel__button" :loading="submitting" @tap="openWithReservation(nearestReservation)">用预约开柜</button>
            <button class="reservation-panel__button reservation-panel__button--ghost" :loading="submitting" @tap="cancelReservation(nearestReservation)">取消</button>
          </view>
        </view>

        <view v-if="selectedGoodsDetails.length && !accessibilityEnabled" class="settlement-preview">
          <view class="settlement-preview__head">
            <text class="settlement-preview__title">预结算明细</text>
            <text class="settlement-preview__amount">
              {{ estimatedPayableAmount > 0 ? formatCurrency(estimatedPayableAmount) : "免费" }}
            </text>
          </view>
          <view v-for="item in selectedGoodsDetails" :key="item.goodsId" class="settlement-row">
            <text class="settlement-row__name">{{ item.goodsName }} x{{ item.quantity }}</text>
            <text class="settlement-row__meta">
              {{ formatSettlementBreakdown(item) }}
            </text>
          </view>
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
                    ? `今日免费额度 ${getRemaining(goods.goodsId)} 件，超出按价计费`
                    : `${categoryLabelMap[goods.category]} · 现有 ${goods.stock ?? 0} 件 · 免费 ${getRemaining(goods.goodsId)} 件 · 超出 ${formatCurrency(goods.price)}/件`
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
          :title="loading ? '正在加载货品信息' : '当前柜机暂无可选货品'"
          :description="loading ? '请稍候，系统正在同步柜机商品列表。' : accessibilityEnabled ? '' : '柜内有库存的货品会在这里展示，超出免费额度的部分会按商品价格计费。'"
        />

        <view class="action-stack">
          <button class="vm-button" :loading="submitting" @tap="submit">
            {{ scanMode ? "确认货品并扫码开柜" : "确认货品并手动开柜" }}
          </button>
          <button v-if="reservationSettings?.enabled" class="vm-button vm-button--ghost" :loading="submitting" @tap="createReservation">
            预约所选货品
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
.distance-banner__body,
.settlement-row__meta {
  font-size: 22rpx;
  color: var(--vm-text-soft);
  line-height: 1.6;
}

.overview-grid,
.goods-list,
.action-stack,
.distance-banner,
.settlement-preview,
.reservation-panel__actions {
  display: grid;
  gap: 16rpx;
}

.selection-banner,
.goods-item,
.settlement-preview,
.reservation-panel {
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

.reservation-panel {
  align-items: stretch;
}

.reservation-panel__main {
  display: grid;
  gap: 8rpx;
  min-width: 0;
}

.reservation-panel__label,
.reservation-panel__hint {
  font-size: 22rpx;
  color: var(--vm-text-soft);
}

.reservation-panel__title {
  font-size: 28rpx;
  font-weight: 700;
  color: var(--vm-text);
  line-height: 1.5;
}

.reservation-panel__actions {
  min-width: 190rpx;
}

.reservation-panel__button {
  min-height: 64rpx;
  border-radius: 18rpx;
  background: var(--vm-accent);
  color: #fff;
  font-size: 22rpx;
}

.reservation-panel__button--ghost {
  background: var(--vm-surface-strong);
  color: var(--vm-text);
  border: 1rpx solid var(--vm-line);
}

.settlement-preview {
  display: grid;
  align-items: stretch;
}

.settlement-preview__head,
.settlement-row {
  display: flex;
  justify-content: space-between;
  align-items: flex-start;
  gap: 16rpx;
}

.settlement-preview__title,
.settlement-row__name {
  font-size: 26rpx;
  font-weight: 700;
  color: var(--vm-text);
}

.settlement-preview__amount {
  font-size: 28rpx;
  font-weight: 800;
  color: var(--vm-accent-strong);
}

.settlement-row {
  padding-top: 14rpx;
  border-top: 1rpx solid var(--vm-line);
}

.settlement-row__name,
.settlement-row__meta {
  min-width: 0;
}

.settlement-row__meta {
  text-align: right;
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

