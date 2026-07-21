<script setup lang="ts">
import { computed, ref } from "vue";
import { onShow } from "@dcloudio/uni-app";
import type { DeviceRecord } from "@vm/shared-types";

import { mobileApi } from "../../api/mobile";
import EmptyState from "../../components/ui/EmptyState.vue";
import GlassCard from "../../components/ui/GlassCard.vue";
import MobileShell from "../../layouts/MobileShell.vue";
import { categoryLabelMap, roleLabelMap } from "../../constants/labels";
import { useSessionStore } from "../../stores/session";
import { useUiPreferencesStore } from "../../stores/ui-preferences";
import { formatBeijingDateTime, formatBeijingMonthDay } from "../../utils/datetime";
import { canOpenDevice, getDeviceStatusPresentation } from "../../utils/device-readiness";
import { getErrorMessage } from "../../utils/error-message";
import { getReceivableDeviceGoods, getReceivableGoodsOptions } from "../../utils/receivable-goods";
import { syncRoleTabBar } from "../../utils/role-routing";
import { scanDeviceCode } from "../../utils/scan-device";

const DEFAULT_MARKER_ICON = "/static/tabs/device.png";
const ACTIVE_MARKER_ICON = "/static/tabs/device-active.png";

const sessionStore = useSessionStore();
const uiPreferencesStore = useUiPreferencesStore();
const devices = ref<DeviceRecord[]>([]);
const loading = ref(false);
const loadError = ref("");
const distanceEnabled = ref(false);
const mapExpanded = ref(false);
const viewMode = ref<"map" | "list">("map");
const selectedGoodsId = ref("");
const highlightedDeviceCode = ref("");
const currentLocation = ref<{ longitude: number; latitude: number }>();
const locationMessage = ref("正在读取当前位置");

uiPreferencesStore.hydrate();

const accessibilityEnabled = computed(() => uiPreferencesStore.isAccessibilityEnabled(sessionStore.user?.role));
const isAccessibleSpecial = computed(() => sessionStore.user?.role === "special" && accessibilityEnabled.value);
const pageEyebrow = computed(() => (sessionStore.user?.role === "merchant" ? "补货" : "附近柜机"));

const subtitle = computed(() => {
  if (sessionStore.user?.role === "special") {
    return isAccessibleSpecial.value ? "显示柜机名称、地点、距离、柜内数量和今日免费数量。" : "地图和列表都能查看，先确认可领取再开柜。";
  }

  if (sessionStore.user?.role === "merchant") {
    return "选择在线柜机，开门补货或登记商品批次。";
  }

  return "查看所有柜机状态、货品概要，再进入运营开门或详情处理。";
});

const deviceEntries = computed(() =>
  devices.value
    .map((device) => ({
      device,
      visibleGoods:
        sessionStore.user?.role === "special"
          ? getReceivableDeviceGoods(device, sessionStore.quota)
          : device.doors.flatMap((door) => door.goods)
    }))
);
const visibleDeviceEntries = computed(() =>
  isAccessibleSpecial.value ? deviceEntries.value.filter((entry) => entry.visibleGoods.length) : deviceEntries.value
);

const visibleDevices = computed(() => visibleDeviceEntries.value.map((entry) => entry.device));

const mappableDevices = computed(() =>
  visibleDevices.value.filter(
    (device) => device.longitude !== undefined && device.latitude !== undefined
  )
);

const highlightedDevice = computed(() =>
  visibleDevices.value.find((device) => device.deviceCode === highlightedDeviceCode.value)
);

const goodsOptions = computed(() => {
  if (sessionStore.user?.role === "special") {
    return getReceivableGoodsOptions(sessionStore.quota, devices.value);
  }

  const options = new Map<string, { goodsId: string; goodsName: string }>();
  for (const device of devices.value) {
    for (const door of device.doors) {
      for (const goods of door.goods) {
        options.set(goods.goodsId, {
          goodsId: goods.goodsId,
          goodsName: goods.name
        });
      }
    }
  }

  return Array.from(options.values());
});

const selectedGoodsName = computed(
  () => goodsOptions.value.find((item) => item.goodsId === selectedGoodsId.value)?.goodsName ?? ""
);
const goodsSearchPlaceholder = computed(() =>
  sessionStore.user?.role === "merchant" ? "请选择要查看的物资" : "请选择想领取的物资"
);
const nearestDeviceButtonText = computed(() =>
  distanceEnabled.value ? "定位最近柜机" : "选中推荐柜机"
);
const heroSupport = computed(() => {
  if (sessionStore.user?.role === "special") {
    return {
      title: "找柜机提示",
      lines: [
        distanceEnabled.value ? "已按距离排序，越靠前的柜机通常离你越近。" : "未开启定位时也能查看柜机，页面会先展示推荐顺序。",
        selectedGoodsName.value ? `正在查找：${selectedGoodsName.value}` : "可先选择想领取的物资，再查找附近柜机。",
        highlightedDevice.value ? `当前查看：${highlightedDevice.value.name}` : "点击地图大头钉或下方列表，可切换要查看的柜机。"
      ]
    };
  }

  if (sessionStore.user?.role === "merchant") {
    return {
      title: "开门提示",
      lines: [
        "建议先看在线柜机，再安排开门和补货。",
        selectedGoodsName.value ? `当前筛选物资：${selectedGoodsName.value}` : "可按物资名称查找需要补货的柜机。",
        highlightedDevice.value ? `当前查看：${highlightedDevice.value.name}` : "选中柜机后可选择是否有商品入柜。"
      ]
    };
  }

  return {
    title: "查看提示",
    lines: [
      "请先看地图位置，再进入柜机详情。",
      distanceEnabled.value ? "当前列表已显示距离信息，方便按顺序查看。" : "未开启定位时仍可查看柜机列表。",
      highlightedDevice.value ? `当前查看：${highlightedDevice.value.name}` : "点击列表卡片后，地图会同步高亮对应柜机。"
    ]
  };
});
const mapFocusStatusLabel = computed(() => {
  if (highlightedDevice.value && !canOpenDevice(highlightedDevice.value)) {
    return getDeviceStatusPresentation(highlightedDevice.value).label;
  }

  if (sessionStore.user?.role === "merchant") {
    return "可补货";
  }

  if (sessionStore.user?.role === "admin") {
    return "可操作";
  }

  return "可领取";
});
const mapFocusStatusTone = computed(() =>
  highlightedDevice.value
    ? getDeviceStatusPresentation(highlightedDevice.value).tone
    : "success"
);

const markerEntries = computed(() =>
  mappableDevices.value.map((device, index) => ({
    markerId: index + 1,
    device
  }))
);

const mapCenter = computed(() => {
  const highlighted = highlightedDevice.value;

  if (highlighted?.longitude !== undefined && highlighted.latitude !== undefined) {
    return {
      longitude: highlighted.longitude,
      latitude: highlighted.latitude
    };
  }

  if (currentLocation.value) {
    return currentLocation.value;
  }

  const first = mappableDevices.value[0];

  if (first?.longitude !== undefined && first.latitude !== undefined) {
    return {
      longitude: first.longitude,
      latitude: first.latitude
    };
  }

  return {
    longitude: 120.2915,
    latitude: 31.5528
  };
});
const hasRealLocation = computed(
  () => distanceEnabled.value && currentLocation.value !== undefined
);

const mapMarkers = computed(() =>
  markerEntries.value.map(({ markerId, device }) => {
    const highlighted = device.deviceCode === highlightedDeviceCode.value;
    const distanceText = distanceEnabled.value
      ? formatDistance(device.distanceMeters)
      : "按推荐顺序展示";

    return {
      id: markerId,
      longitude: device.longitude as number,
      latitude: device.latitude as number,
      title: device.name,
      iconPath: highlighted ? ACTIVE_MARKER_ICON : DEFAULT_MARKER_ICON,
      width: highlighted ? 40 : 28,
      height: highlighted ? 40 : 28,
      zIndex: highlighted ? 30 : 10,
      callout: {
        content: `${device.name}\n${distanceText}`,
        color: highlighted ? "#ffffff" : "#17293f",
        fontSize: 12,
        borderRadius: 8,
        padding: 6,
        bgColor: highlighted ? "#143a66" : "#ffffff",
        display: highlighted ? "ALWAYS" : "BYCLICK",
        textAlign: "center"
      }
    };
  })
);

const load = async () => {
  await sessionStore.bootstrap();

  if (!sessionStore.user) {
    uni.reLaunch({ url: "/pages/common/login" });
    return;
  }

  syncRoleTabBar(sessionStore.user.role);
  loading.value = true;
  loadError.value = "";

  try {
    let query: { longitude?: number; latitude?: number } | undefined;

    try {
      // 能拿到定位就按距离推荐，让用户先看到最省路程、最容易到达的柜机。
      const location = await new Promise<UniApp.GetLocationSuccess>((resolve, reject) => {
        uni.getLocation({
          type: "gcj02",
          success: resolve,
          fail: reject
        });
      });

      currentLocation.value = {
        longitude: location.longitude,
        latitude: location.latitude
      };
      locationMessage.value = `当前位置 ${location.longitude.toFixed(5)}, ${location.latitude.toFixed(5)}`;
      query = {
        longitude: location.longitude,
        latitude: location.latitude
      };
      distanceEnabled.value = true;
    } catch {
      // 没有定位权限也不能阻断服务，至少要保证列表还能按推荐顺序继续使用。
      currentLocation.value = undefined;
      distanceEnabled.value = false;
      locationMessage.value = "未获得定位权限，已按推荐顺序展示柜机";
    }

    const [deviceResponse, quotaResponse] = await Promise.all([
      mobileApi.listDevices(query),
      sessionStore.user.role === "special"
        ? mobileApi.getQuotaSummary(sessionStore.user.phone)
        : Promise.resolve(undefined)
    ]);

    devices.value = deviceResponse;

    if (quotaResponse) {
      sessionStore.setQuota(quotaResponse);
    }

    const nextHighlighted = deviceEntries.value.find(
      (entry) => entry.device.deviceCode === highlightedDeviceCode.value
    );

    if (!nextHighlighted && deviceEntries.value.length) {
      highlightedDeviceCode.value = deviceEntries.value[0].device.deviceCode;
    }

    if (!selectedGoodsId.value && goodsOptions.value.length) {
      selectedGoodsId.value = goodsOptions.value[0].goodsId;
    } else if (!goodsOptions.value.some((item) => item.goodsId === selectedGoodsId.value)) {
      selectedGoodsId.value = goodsOptions.value[0]?.goodsId ?? "";
    }
  } catch (error) {
    loadError.value = getErrorMessage(error);
  } finally {
    loading.value = false;
  }
};

const openDevice = (deviceCode: string) => {
  highlightedDeviceCode.value = deviceCode;
  const targetDevice = visibleDevices.value.find((device) => device.deviceCode === deviceCode);

  if (!targetDevice) {
    uni.showToast({ title: "未找到对应柜机", icon: "none" });
    return;
  }

  if (!canOpenDevice(targetDevice)) {
    const presentation = getDeviceStatusPresentation(targetDevice);
    uni.showModal({
      title: presentation.label,
      content: presentation.actionHint,
      confirmText: "我知道了",
      showCancel: false
    });
    return;
  }

  const distanceQuery =
    typeof targetDevice.distanceMeters === "number" ? `&distanceMeters=${targetDevice.distanceMeters}` : "";

  if (sessionStore.user?.role === "special") {
    uni.navigateTo({
      url: `/pages/special/device-detail?deviceCode=${deviceCode}${distanceQuery}`
    });
    return;
  }

  if (sessionStore.user?.role === "merchant") {
    uni.navigateTo({
      url: `/pages/common/operation-open?deviceCode=${deviceCode}`
    });
    return;
  }

  uni.navigateTo({
    url: `/pages/common/operation-open?deviceCode=${deviceCode}`
  });
};

const focusDevice = (deviceCode: string) => {
  highlightedDeviceCode.value = deviceCode;
};

const focusNearestDevice = () => {
  const nearest = visibleDevices.value[0];

  if (!nearest) {
    return;
  }

  highlightedDeviceCode.value = nearest.deviceCode;
  uni.showToast({
    title: distanceEnabled.value ? `已定位最近柜机：${nearest.name}` : `已选中推荐柜机：${nearest.name}`,
    icon: "none"
  });
};

const focusNearestGoods = () => {
  const goodsId = selectedGoodsId.value;
  const goodsName = selectedGoodsName.value.trim();

  if (!goodsId || !goodsName) {
    uni.showToast({
      title: "请选择物资",
      icon: "none"
    });
    return;
  }

  const containsGoods = (device: DeviceRecord) =>
    (sessionStore.user?.role === "special"
      ? getReceivableDeviceGoods(device, sessionStore.quota)
      : device.doors.flatMap((door) => door.goods)
    ).some((goods) => goods.goodsId === goodsId);
  const matched = devices.value.find((device) => canOpenDevice(device) && containsGoods(device));

  if (!matched) {
    const unavailableMatch = devices.value.find(containsGoods);
    if (unavailableMatch) {
      const presentation = getDeviceStatusPresentation(unavailableMatch);
      uni.showModal({
        title: `${goodsName}所在柜机${presentation.label}`,
        content: presentation.actionHint,
        confirmText: "我知道了",
        showCancel: false
      });
      return;
    }

    uni.showToast({
      title: `当前列表没有找到${goodsName}`,
      icon: "none"
    });
    return;
  }

  highlightedDeviceCode.value = matched.deviceCode;
  uni.showToast({
    title: distanceEnabled.value ? `已定位最近${goodsName}柜机` : `已选中有${goodsName}的柜机`,
    icon: "none"
  });
};

const handleMarkerTap = (event: { detail?: { markerId?: number } }) => {
  const markerId = event.detail?.markerId;
  const matched = markerEntries.value.find((item) => item.markerId === markerId);

  if (!matched) {
    return;
  }

  highlightedDeviceCode.value = matched.device.deviceCode;
};

const goFeedback = (deviceCode: string) => {
  uni.navigateTo({
    url: `/pages/common/feedback?deviceCode=${deviceCode}`
  });
};

const scanAndOpen = async () => {
  try {
    const deviceCode = await scanDeviceCode();

    if (!deviceCode) {
      uni.showToast({
        title: "未识别到柜机编号",
        icon: "none"
      });
      return;
    }

    const device = await mobileApi.getDevice(deviceCode);

    if (!canOpenDevice(device)) {
      const presentation = getDeviceStatusPresentation(device);
      uni.showModal({
        title: presentation.label,
        content: presentation.actionHint,
        confirmText: "我知道了",
        showCancel: false
      });
      return;
    }

    uni.navigateTo({
      url: `/pages/special/device-detail?deviceCode=${encodeURIComponent(deviceCode)}&scan=1`
    });
  } catch (error) {
    uni.showToast({
      title: getErrorMessage(error),
      icon: "none"
    });
  }
};

const formatDistance = (distanceMeters?: number) => {
  if (distanceMeters === undefined) {
    return "未开启定位";
  }

  if (distanceMeters < 1000) {
    return `${distanceMeters} 米`;
  }

  return `${(distanceMeters / 1000).toFixed(1)} 公里`;
};

const isLowStockGoods = (goods: { stock?: number; lowStockThreshold?: number }) =>
  typeof goods.lowStockThreshold === "number" && (goods.stock ?? 0) <= goods.lowStockThreshold;

onShow(() => {
  load();
});
</script>

<template>
  <MobileShell
    :mode="sessionStore.user?.role === 'special' ? 'care' : sessionStore.user?.role ? 'ops' : 'care'"
    :eyebrow="pageEyebrow"
    :title="roleLabelMap[sessionStore.user?.role ?? 'special']"
    :subtitle="subtitle"
  >
    <GlassCard tone="quiet">
      <view class="vm-stack">
        <view v-if="loadError" class="vm-stack">
          <EmptyState title="柜机数据加载失败" :description="loadError" />
          <button class="vm-button vm-button--ghost" :disabled="loading" :loading="loading" @tap="load">
            重新加载
          </button>
        </view>

        <view v-if="!loadError && mappableDevices.length && !isAccessibleSpecial" class="nearby-map-card">
          <view class="nearby-search-bar">
            <picker
              :range="goodsOptions"
              range-key="goodsName"
              :value="Math.max(goodsOptions.findIndex((item) => item.goodsId === selectedGoodsId), 0)"
              @change="selectedGoodsId = goodsOptions[$event.detail.value]?.goodsId ?? ''"
            >
              <view class="nearby-search-bar__input">
                {{ selectedGoodsName || goodsSearchPlaceholder }}
              </view>
            </picker>
            <button class="nearby-search-bar__button" @tap="focusNearestGoods">找物资</button>
          </view>

          <view class="nearby-mode-tabs">
            <button
              class="nearby-mode-tabs__item"
              :class="{ 'nearby-mode-tabs__item--active': viewMode === 'map' }"
              @tap="viewMode = 'map'"
            >
              地图
            </button>
            <button
              class="nearby-mode-tabs__item"
              :class="{ 'nearby-mode-tabs__item--active': viewMode === 'list' }"
              @tap="viewMode = 'list'"
            >
              列表
            </button>
          </view>

          <template v-if="viewMode === 'map'">
            <!-- #ifdef H5 -->
            <view class="nearby-map nearby-map--compact nearby-map-preview" @tap="mapExpanded = true">
              <view class="nearby-map-preview__road nearby-map-preview__road--main" />
              <view class="nearby-map-preview__road nearby-map-preview__road--cross" />
              <view class="nearby-map-preview__river" />
              <view
                v-for="(device, index) in mappableDevices"
                :key="device.deviceCode"
                class="nearby-map-preview__pin"
                :class="{ 'nearby-map-preview__pin--active': device.deviceCode === highlightedDeviceCode }"
                :style="{ left: `${22 + (index * 23) % 55}%`, top: `${28 + (index * 19) % 40}%` }"
                @tap.stop="focusDevice(device.deviceCode)"
              />
              <view v-if="hasRealLocation" class="nearby-map-preview__user" />
            </view>
            <!-- #endif -->
            <!-- #ifndef H5 -->
            <map
              class="nearby-map nearby-map--compact"
              :longitude="mapCenter.longitude"
              :latitude="mapCenter.latitude"
              :markers="mapMarkers"
              :scale="13"
              :show-location="hasRealLocation"
              @tap="mapExpanded = true"
              @markertap="handleMarkerTap"
            />
            <!-- #endif -->

            <view class="nearby-map-card__summary">
              <view class="nearby-location-banner">
                <text class="nearby-map-card__title">当前位置与地图提示</text>
                <text class="nearby-location-banner__value">{{ locationMessage }}</text>
                <text class="nearby-map-card__hint">
                  {{
                    distanceEnabled
                      ? "已按距离排序，点地图大头钉可高亮对应柜机。"
                      : "未开启定位时按推荐顺序展示；如需按距离排序，请在小程序和系统设置中允许定位权限。"
                  }}
                </text>
              </view>

              <view v-if="highlightedDevice" class="nearby-map-card__focus">
                <text class="nearby-map-card__focus-title">当前定位</text>
                <text class="nearby-map-card__focus-value">
                  {{ highlightedDevice.name }} · {{ formatDistance(highlightedDevice.distanceMeters) }}
                </text>
              </view>
            </view>

            <button v-if="highlightedDevice" class="map-focus-card" :disabled="!canOpenDevice(highlightedDevice)" @tap="openDevice(highlightedDevice.deviceCode)">
              <view class="map-focus-card__media" aria-hidden="true">
                <view class="map-focus-card__machine" />
              </view>
              <view class="map-focus-card__copy">
                <text class="map-focus-card__title">{{ highlightedDevice.name }}</text>
                <text class="map-focus-card__meta">{{ highlightedDevice.location }}</text>
                <text class="map-focus-card__meta">
                  {{ distanceEnabled ? `距离 ${formatDistance(highlightedDevice.distanceMeters)}` : "按推荐顺序展示" }}
                </text>
                <text v-if="!canOpenDevice(highlightedDevice)" class="map-focus-card__meta map-focus-card__warning">
                  {{ getDeviceStatusPresentation(highlightedDevice).actionHint }}
                </text>
              </view>
              <text class="vm-status" :class="`vm-status--${mapFocusStatusTone}`">{{ mapFocusStatusLabel }}</text>
            </button>

            <view class="nearby-map-card__tools">
              <button class="vm-button" @tap="focusNearestDevice">{{ nearestDeviceButtonText }}</button>
              <button v-if="sessionStore.user?.role === 'special'" class="vm-button vm-button--warning" @tap="scanAndOpen">扫码开柜</button>
              <button v-else class="vm-button vm-button--ghost" @tap="mapExpanded = true">放大地图查看</button>
            </view>
          </template>
        </view>

        <view
          v-if="!loadError && visibleDeviceEntries.length && (viewMode === 'list' || isAccessibleSpecial || !mappableDevices.length)"
          class="device-list"
        >
          <view
            v-for="entry in visibleDeviceEntries"
            :key="entry.device.deviceCode"
            class="device-card"
            :class="{ 'device-card--active': !isAccessibleSpecial && entry.device.deviceCode === highlightedDeviceCode }"
            @tap="!isAccessibleSpecial && focusDevice(entry.device.deviceCode)"
          >
            <view class="device-card__head">
              <view v-if="!isAccessibleSpecial" class="device-card__media" aria-hidden="true">
                <view class="device-card__machine" />
              </view>
              <view class="device-card__main">
                <text class="device-card__title">{{ entry.device.name }}</text>
                <text class="device-card__meta">{{ entry.device.location }}</text>
                <text class="device-card__meta">
                  柜机编号 {{ entry.device.deviceCode }} · 最近在线 {{ formatBeijingDateTime(entry.device.lastSeenAt) }}
                </text>
                <text class="device-card__meta">
                  {{ distanceEnabled ? `距离 ${formatDistance(entry.device.distanceMeters)}` : "未开启定位，按推荐顺序显示" }}
                </text>
                <text v-if="sessionStore.user?.role === 'special' && !isAccessibleSpecial" class="device-card__highlight">
                  展示柜内有货的物资，超出免费额度会按价格计费
                </text>
              </view>
              <text class="vm-status" :class="`vm-status--${getDeviceStatusPresentation(entry.device).tone}`">
                {{ getDeviceStatusPresentation(entry.device).label }}
              </text>
            </view>

            <text v-if="!canOpenDevice(entry.device)" class="device-card__open-hint" role="alert">
              {{ getDeviceStatusPresentation(entry.device).actionHint }}
            </text>

            <view v-if="entry.visibleGoods.length" class="goods-list">
              <view v-for="goods in entry.visibleGoods" :key="goods.goodsId" class="goods-item">
                <view class="goods-item__main">
                  <view class="goods-item__title-row">
                    <text>{{ goods.name }}</text>
                    <text v-if="isLowStockGoods(goods)" class="vm-status vm-status--low-stock">低库存</text>
                  </view>
                  <text class="goods-item__meta">
                    {{
                      sessionStore.user?.role === "special"
                        ? isAccessibleSpecial
                          ? `${categoryLabelMap[goods.category]} · 柜内 ${goods.stock} 件 · 今日免费 ${(sessionStore.quota?.remainingByGoods?.[goods.goodsId] ?? 0)} 件`
                          : `${categoryLabelMap[goods.category]} · 柜内 ${goods.stock} 件 · 免费 ${(sessionStore.quota?.remainingByGoods?.[goods.goodsId] ?? 0)} 件`
                        : `${categoryLabelMap[goods.category]} · 当前 ${goods.stock} 件`
                    }}
                  </text>
                </view>
                <text v-if="goods.expiresAt" class="goods-item__meta">
                  至 {{ formatBeijingMonthDay(goods.expiresAt) }}
                </text>
              </view>
            </view>
            <view v-else-if="sessionStore.user?.role === 'special'" class="device-card__empty">
              <text class="device-card__empty-title">当前这台柜机没有可选货品</text>
              <text v-if="!isAccessibleSpecial" class="device-card__empty-body">
                柜机会继续显示，方便你确认位置；有库存的货品会在设备详情中继续展示。
              </text>
            </view>

            <view class="action-grid" :class="{ 'action-grid--single': isAccessibleSpecial }">
              <button class="vm-button" :disabled="!canOpenDevice(entry.device)" @tap.stop="openDevice(entry.device.deviceCode)">
                {{
                  !canOpenDevice(entry.device)
                    ? "暂不可开柜"
                    : sessionStore.user?.role === "special"
                    ? "进入领取"
                    : sessionStore.user?.role === "merchant"
                      ? "补货 / 开门"
                  : "运营开门"
                }}
              </button>
              <button class="vm-button vm-button--ghost" @tap.stop="goFeedback(entry.device.deviceCode)">反馈</button>
            </view>
          </view>
        </view>

        <EmptyState
          v-if="!loadError && !visibleDeviceEntries.length"
          :title="loading ? '正在同步柜机' : isAccessibleSpecial ? '当前没有可选物资' : '当前没有可展示柜机'"
          :description="loading ? '请稍候，系统正在拉取设备信息。' : isAccessibleSpecial ? '系统会按库存自动刷新。' : '请确认后端是否已经接入柜机数据。'"
        />
      </view>
    </GlassCard>

    <GlassCard v-if="!isAccessibleSpecial" tone="quiet">
      <view class="vm-stack nearby-advice">
        <text class="nearby-advice__title">{{ heroSupport.title }}</text>
        <text v-for="line in heroSupport.lines" :key="line" class="nearby-advice__body">{{ line }}</text>
      </view>
    </GlassCard>

    <view v-if="!loadError && mapExpanded && !isAccessibleSpecial" class="nearby-map-overlay" @tap.self="mapExpanded = false">
      <view class="nearby-map-overlay__panel">
        <view class="nearby-map-overlay__head">
          <view>
            <text class="nearby-map-card__title">附近柜机地图</text>
            <text class="nearby-map-card__hint">可点击大头钉高亮柜机，再从下方列表进入详情。</text>
          </view>
          <button class="vm-button vm-button--ghost" @tap="mapExpanded = false">关闭</button>
        </view>

        <!-- #ifdef H5 -->
        <view class="nearby-map nearby-map--expanded nearby-map-preview nearby-map-preview--expanded">
          <view class="nearby-map-preview__road nearby-map-preview__road--main" />
          <view class="nearby-map-preview__road nearby-map-preview__road--cross" />
          <view class="nearby-map-preview__river" />
          <view
            v-for="(device, index) in mappableDevices"
            :key="device.deviceCode"
            class="nearby-map-preview__pin"
            :class="{ 'nearby-map-preview__pin--active': device.deviceCode === highlightedDeviceCode }"
            :style="{ left: `${22 + (index * 23) % 55}%`, top: `${28 + (index * 19) % 40}%` }"
            @tap.stop="focusDevice(device.deviceCode)"
          />
          <view v-if="hasRealLocation" class="nearby-map-preview__user" />
        </view>
        <!-- #endif -->
        <!-- #ifndef H5 -->
        <map
          class="nearby-map nearby-map--expanded"
          :longitude="mapCenter.longitude"
          :latitude="mapCenter.latitude"
          :markers="mapMarkers"
          :scale="15"
          :show-location="hasRealLocation"
          @markertap="handleMarkerTap"
        />
        <!-- #endif -->

        <view class="nearby-map-card__tools">
          <button v-if="sessionStore.user?.role === 'special'" class="vm-button vm-button--warning" @tap="scanAndOpen">扫码开柜</button>
          <button class="vm-button vm-button--ghost" @tap="focusNearestDevice">{{ nearestDeviceButtonText }}</button>
          <view class="nearby-map-card__search">
            <picker
              :range="goodsOptions"
              range-key="goodsName"
              :value="Math.max(goodsOptions.findIndex((item) => item.goodsId === selectedGoodsId), 0)"
              @change="selectedGoodsId = goodsOptions[$event.detail.value]?.goodsId ?? ''"
            >
              <view class="nearby-map-card__picker">
                {{ selectedGoodsName || goodsSearchPlaceholder }}
              </view>
            </picker>
            <button class="vm-button" @tap="focusNearestGoods">查找有货柜机</button>
          </view>
        </view>
      </view>
    </view>
  </MobileShell>
</template>

<style scoped>
.nearby-map-card,
.device-list,
.goods-list,
.action-grid,
.nearby-map-card__search,
.nearby-location-banner,
.nearby-map-card__summary,
.nearby-advice,
.map-focus-card__copy {
  display: grid;
  gap: 16rpx;
}

.nearby-map-card__tools,
.nearby-map-overlay__head {
  display: flex;
  align-items: flex-start;
  gap: 16rpx;
}

.nearby-map-overlay__head {
  justify-content: space-between;
}

.nearby-search-bar {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  gap: 12rpx;
  padding: 10rpx;
  border-radius: 999rpx;
  border: 1rpx solid var(--vm-line);
  background: #ffffff;
  box-shadow: 0 10rpx 24rpx rgba(88, 61, 30, 0.06);
}

.nearby-search-bar__input {
  min-height: 62rpx;
  display: flex;
  align-items: center;
  padding: 0 22rpx;
  color: var(--vm-text-soft);
  font-size: 24rpx;
}

.nearby-search-bar__button {
  min-width: 110rpx;
  min-height: 62rpx;
  border-radius: 999rpx;
  background: var(--vm-accent);
  color: #ffffff;
  font-size: 24rpx;
  font-weight: 800;
}

.nearby-mode-tabs {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 8rpx;
  padding: 8rpx;
  border-radius: 20rpx;
  background: var(--vm-surface-soft);
  border: 1rpx solid var(--vm-line);
}

.nearby-mode-tabs__item {
  min-height: 58rpx;
  display: flex;
  align-items: center;
  justify-content: center;
  border-radius: 16rpx;
  font-size: 24rpx;
  color: var(--vm-text-soft);
}

.nearby-mode-tabs__item--active {
  background: #ffffff;
  color: var(--vm-accent-strong);
  font-weight: 800;
  box-shadow: 0 8rpx 18rpx rgba(88, 61, 30, 0.08);
}

.nearby-map-card__title,
.nearby-advice__title {
  font-size: 28rpx;
  font-weight: 700;
  color: var(--vm-text);
}

.nearby-map-card__hint,
.device-card__meta,
.goods-item__meta,
.nearby-map-card__focus-value,
.nearby-location-banner__value,
.nearby-advice__body,
.map-focus-card__meta {
  font-size: 22rpx;
  color: var(--vm-text-soft);
  line-height: 1.6;
}

.device-card__highlight {
  font-size: 22rpx;
  color: var(--vm-accent-strong);
}

.device-card__open-hint,
.map-focus-card__warning {
  font-size: 22rpx;
  line-height: 1.6;
  color: var(--vm-warning);
  font-weight: 700;
}

.device-card__empty {
  display: grid;
  gap: 8rpx;
  padding: 18rpx 20rpx;
  border-radius: 20rpx;
  background: var(--vm-surface-soft);
  border: 1rpx dashed var(--vm-line-strong);
}

.device-card__empty-title {
  font-size: 24rpx;
  font-weight: 700;
  color: var(--vm-text);
}

.device-card__empty-body {
  font-size: 22rpx;
  line-height: 1.6;
  color: var(--vm-text-soft);
}

.nearby-location-banner {
  padding: 18rpx 20rpx;
  border-radius: 22rpx;
  background: var(--vm-surface-soft);
  border: 1rpx solid var(--vm-line);
}

.nearby-map-card__picker {
  min-height: 88rpx;
  display: flex;
  align-items: center;
  padding: 0 24rpx;
  border-radius: 22rpx;
  background: var(--vm-surface-soft);
  border: 1rpx solid var(--vm-line-strong);
  color: var(--vm-text);
  font-size: 24rpx;
}

.nearby-map {
  width: 100%;
  border-radius: 24rpx;
  overflow: hidden;
}

.nearby-map--compact {
  height: 260rpx;
}

.nearby-map--expanded {
  height: 760rpx;
}

.nearby-map-preview {
  position: relative;
  background:
    linear-gradient(90deg, rgba(46, 125, 70, 0.08) 1px, transparent 1px) 0 0 / 86rpx 86rpx,
    linear-gradient(0deg, rgba(46, 125, 70, 0.08) 1px, transparent 1px) 0 0 / 86rpx 86rpx,
    linear-gradient(135deg, #f3f8ef 0%, #fff7ec 100%);
}

.nearby-map-preview__road,
.nearby-map-preview__river,
.nearby-map-preview__pin,
.nearby-map-preview__user {
  position: absolute;
}

.nearby-map-preview__road {
  border-radius: 999rpx;
  background: rgba(255, 255, 255, 0.88);
  box-shadow: 0 0 0 1rpx rgba(46, 125, 70, 0.08);
}

.nearby-map-preview__road--main {
  left: -12%;
  top: 46%;
  width: 124%;
  height: 34rpx;
  transform: rotate(-9deg);
}

.nearby-map-preview__road--cross {
  left: 46%;
  top: -12%;
  width: 30rpx;
  height: 124%;
  transform: rotate(16deg);
}

.nearby-map-preview__river {
  left: -18%;
  bottom: 12%;
  width: 136%;
  height: 44rpx;
  border-radius: 999rpx;
  background: rgba(110, 184, 214, 0.22);
  transform: rotate(8deg);
}

.nearby-map-preview__pin {
  width: 30rpx;
  height: 30rpx;
  border-radius: 50% 50% 50% 0;
  background: var(--vm-accent);
  box-shadow: 0 8rpx 18rpx rgba(46, 125, 70, 0.2);
  transform: rotate(-45deg);
}

.nearby-map-preview__pin::after {
  content: "";
  position: absolute;
  inset: 9rpx;
  border-radius: 50%;
  background: #ffffff;
}

.nearby-map-preview__pin--active {
  width: 38rpx;
  height: 38rpx;
  background: var(--vm-warning);
  box-shadow: 0 10rpx 24rpx rgba(255, 138, 43, 0.26);
}

.nearby-map-preview__pin--active::after {
  inset: 11rpx;
}

.nearby-map-preview__user {
  left: 50%;
  top: 52%;
  width: 28rpx;
  height: 28rpx;
  border-radius: 50%;
  background: #3b82f6;
  border: 6rpx solid #ffffff;
  box-shadow: 0 8rpx 18rpx rgba(59, 130, 246, 0.2);
}

.nearby-map-preview--expanded .nearby-map-preview__pin {
  transform: rotate(-45deg) scale(1.28);
}

.nearby-map-card__tools {
  display: grid;
  gap: 16rpx;
}

.nearby-map-card__tools .vm-button {
  width: 100%;
}

.nearby-map-card__search {
  gap: 16rpx;
}

.nearby-map-card__focus {
  display: grid;
  gap: 6rpx;
  padding: 16rpx 18rpx;
  border-radius: 20rpx;
  background: var(--vm-surface-soft);
  border: 1rpx solid var(--vm-line);
}

.nearby-map-card__focus-title {
  font-size: 22rpx;
  color: var(--vm-text-soft);
}

.map-focus-card {
  display: grid;
  grid-template-columns: auto minmax(0, 1fr) auto;
  align-items: center;
  gap: 18rpx;
  width: 100%;
  padding: 18rpx;
  border-radius: 24rpx;
  border: 1rpx solid var(--vm-success-line);
  background: #ffffff;
  text-align: left;
}

.map-focus-card[disabled] {
  border-color: var(--vm-warning-line);
  background: var(--vm-warning-bg);
}

.vm-page--accessible .device-card .vm-button[disabled] {
  opacity: 1;
  background: #e7eee8;
  border-color: var(--vm-line-strong);
  color: var(--vm-muted);
}

.map-focus-card__media,
.device-card__media {
  display: grid;
  place-items: center;
  flex-shrink: 0;
  border-radius: 20rpx;
  background: linear-gradient(180deg, #fff4e6, #eaf6e4);
  overflow: hidden;
}

.map-focus-card__media {
  width: 110rpx;
  height: 110rpx;
}

.map-focus-card__machine,
.device-card__machine {
  position: relative;
  border-radius: 10rpx;
  background: #2e7d46;
  box-shadow: inset 0 0 0 5rpx rgba(255, 255, 255, 0.26);
}

.map-focus-card__machine {
  width: 58rpx;
  height: 82rpx;
}

.map-focus-card__machine::before,
.device-card__machine::before {
  content: "";
  position: absolute;
  left: 10rpx;
  top: 14rpx;
  border-radius: 6rpx;
  background:
    linear-gradient(#ff9a33 0 0) 5rpx 9rpx / 8rpx 8rpx no-repeat,
    linear-gradient(#8fcf7f 0 0) 18rpx 9rpx / 8rpx 8rpx no-repeat,
    linear-gradient(#fff0c9 0 0) 5rpx 26rpx / 8rpx 8rpx no-repeat,
    linear-gradient(#ff9a33 0 0) 18rpx 26rpx / 8rpx 8rpx no-repeat,
    #eef8e8;
}

.map-focus-card__machine::before {
  width: 30rpx;
  height: 48rpx;
}

.map-focus-card__title {
  font-size: 28rpx;
  font-weight: 800;
  color: var(--vm-text);
}

.device-card {
  display: grid;
  gap: 16rpx;
  padding: 22rpx 24rpx;
  border-radius: 24rpx;
  background: var(--vm-surface-soft);
  border: 1rpx solid var(--vm-line);
}

.action-grid--single {
  grid-template-columns: 1fr;
}

.device-card--active {
  border-color: var(--vm-info-line);
  box-shadow: 0 0 0 4rpx var(--vm-focus-ring);
}

.device-card__head,
.goods-item {
  display: flex;
  justify-content: space-between;
  gap: 16rpx;
}

.device-card__head {
  align-items: flex-start;
}

.device-card__media {
  width: 112rpx;
  height: 112rpx;
}

.device-card__machine {
  width: 58rpx;
  height: 82rpx;
}

.device-card__machine::before {
  width: 30rpx;
  height: 48rpx;
}

.device-card__main,
.goods-item__main {
  display: flex;
  flex-direction: column;
  gap: 8rpx;
}

.goods-item__title-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12rpx;
}

.device-card__title {
  font-size: 30rpx;
  font-weight: 700;
  color: var(--vm-text);
}

.vm-page--accessible .device-card__title {
  font-size: 38rpx;
}

.vm-page--accessible .device-card__meta,
.vm-page--accessible .goods-item__meta {
  font-size: 28rpx;
  color: var(--vm-text);
}

.vm-page--accessible .goods-item {
  align-items: flex-start;
}

.nearby-map-overlay {
  position: fixed;
  inset: 0;
  z-index: 40;
  display: grid;
  place-items: center;
  padding: 24rpx;
  background: rgba(23, 31, 43, 0.28);
}

.nearby-map-overlay__panel {
  width: 100%;
  max-height: 92vh;
  display: grid;
  gap: 20rpx;
  padding: 24rpx;
  border-radius: 28rpx;
  background: var(--vm-surface-strong);
  overflow: auto;
}
</style>

