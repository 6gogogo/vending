<script setup lang="ts">
import { computed, ref } from "vue";
import { onShow } from "@dcloudio/uni-app";
import type { DeviceRecord, DeviceStatus } from "@vm/shared-types";

import { mobileApi } from "../../api/mobile";
import EmptyState from "../../components/ui/EmptyState.vue";
import GlassCard from "../../components/ui/GlassCard.vue";
import MobileShell from "../../layouts/MobileShell.vue";
import { categoryLabelMap, roleLabelMap } from "../../constants/labels";
import { useSessionStore } from "../../stores/session";
import { getErrorMessage } from "../../utils/error-message";
import { syncRoleTabBar } from "../../utils/role-routing";

const DEFAULT_MARKER_ICON = "https://a.amap.com/jsapi_demos/static/demo-center/icons/poi-marker-default.png";
const ACTIVE_MARKER_ICON = "https://a.amap.com/jsapi_demos/static/demo-center/icons/poi-marker-red.png";

const sessionStore = useSessionStore();
const devices = ref<DeviceRecord[]>([]);
const loading = ref(false);
const distanceEnabled = ref(false);
const mapExpanded = ref(false);
const selectedGoodsId = ref("");
const highlightedDeviceCode = ref("");
const currentLocation = ref<{ longitude: number; latitude: number }>();

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

const subtitle = computed(() => {
  if (sessionStore.user?.role === "special") {
    return "查看附近柜机位置、货品与服务时间，再进入领取。";
  }

  if (sessionStore.user?.role === "merchant") {
    return "查看可补货柜机状态，再进入补货登记。";
  }

  return "查看所有柜机状态、货品概要与详情入口。";
});

const mappableDevices = computed(() =>
  devices.value.filter(
    (device) => device.longitude !== undefined && device.latitude !== undefined
  )
);

const highlightedDevice = computed(() =>
  devices.value.find((device) => device.deviceCode === highlightedDeviceCode.value)
);

const goodsOptions = computed(() => {
  const options = new Map<string, { goodsId: string; goodsName: string }>();

  if (sessionStore.user?.role === "special") {
    for (const window of sessionStore.quota?.activeWindows ?? []) {
      for (const goods of window.goodsLimits) {
        options.set(goods.goodsId, {
          goodsId: goods.goodsId,
          goodsName: goods.goodsName
        });
      }
    }

    return Array.from(options.values());
  }

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

const mapMarkers = computed(() =>
  markerEntries.value.map(({ markerId, device }) => {
    const highlighted = device.deviceCode === highlightedDeviceCode.value;
    const distanceText = distanceEnabled.value
      ? formatDistance(device.distanceMeters)
      : "按默认顺序展示";

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
        color: highlighted ? "#ffffff" : "#213547",
        fontSize: 12,
        borderRadius: 8,
        padding: 6,
        bgColor: highlighted ? "#d35b4f" : "#fffaf0",
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

  try {
    let query: { longitude?: number; latitude?: number } | undefined;

    try {
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
      query = {
        longitude: location.longitude,
        latitude: location.latitude
      };
      distanceEnabled.value = true;
    } catch {
      currentLocation.value = undefined;
      distanceEnabled.value = false;
    }

    devices.value = await mobileApi.listDevices(query);

    if (!highlightedDeviceCode.value && devices.value.length) {
      highlightedDeviceCode.value = devices.value[0].deviceCode;
    }

    if (!selectedGoodsId.value && goodsOptions.value.length) {
      selectedGoodsId.value = goodsOptions.value[0].goodsId;
    }
  } catch (error) {
    uni.showToast({
      title: getErrorMessage(error),
      icon: "none"
    });
  } finally {
    loading.value = false;
  }
};

const openDevice = (deviceCode: string) => {
  highlightedDeviceCode.value = deviceCode;

  if (sessionStore.user?.role === "special") {
    uni.navigateTo({
      url: `/pages/special/device-detail?deviceCode=${deviceCode}`
    });
    return;
  }

  if (sessionStore.user?.role === "merchant") {
    uni.navigateTo({
      url: `/pages/merchant/restock?deviceCode=${deviceCode}`
    });
    return;
  }

  uni.navigateTo({
    url: `/pages/admin/device-detail?deviceCode=${deviceCode}`
  });
};

const focusDevice = (deviceCode: string) => {
  highlightedDeviceCode.value = deviceCode;
};

const focusNearestDevice = () => {
  const nearest = devices.value[0];

  if (!nearest) {
    return;
  }

  highlightedDeviceCode.value = nearest.deviceCode;
  uni.showToast({
    title: `已定位最近柜机：${nearest.name}`,
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

  const matched = devices.value.find((device) =>
    device.doors.some((door) =>
      door.goods.some((goods) => goods.goodsId === goodsId)
    )
  );

  if (!matched) {
    uni.showToast({
      title: `附近没有找到${goodsName}`,
      icon: "none"
    });
    return;
  }

  highlightedDeviceCode.value = matched.deviceCode;
  uni.showToast({
    title: `已定位最近${goodsName}柜机`,
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

const formatDistance = (distanceMeters?: number) => {
  if (distanceMeters === undefined) {
    return "未开启定位";
  }

  if (distanceMeters < 1000) {
    return `${distanceMeters} 米`;
  }

  return `${(distanceMeters / 1000).toFixed(1)} 公里`;
};

onShow(() => {
  load();
});
</script>

<template>
  <MobileShell
    eyebrow="附近柜机"
    :title="roleLabelMap[sessionStore.user?.role ?? 'special']"
    :subtitle="subtitle"
  >
    <GlassCard tone="quiet">
      <view class="vm-stack">
        <view v-if="mappableDevices.length" class="nearby-map-card">
          <view class="nearby-map-card__head">
            <view>
              <text class="nearby-map-card__title">附近柜机地图</text>
              <text class="nearby-map-card__hint">
                {{ distanceEnabled ? "已按距离排序，点大头钉可高亮对应柜机。" : "未开启定位，地图按默认顺序展示。" }}
              </text>
            </view>
            <button class="vm-button vm-button--ghost nearby-map-card__expand" @tap="mapExpanded = true">
              放大
            </button>
          </view>

          <map
            class="nearby-map nearby-map--compact"
            :longitude="mapCenter.longitude"
            :latitude="mapCenter.latitude"
            :markers="mapMarkers"
            :scale="13"
            :show-location="true"
            @tap="mapExpanded = true"
            @markertap="handleMarkerTap"
          />

          <view class="nearby-map-card__tools">
            <button class="vm-button vm-button--ghost" @tap="focusNearestDevice">找寻最近柜机</button>
            <view class="nearby-map-card__search">
              <picker
                :range="goodsOptions"
                range-key="goodsName"
                :value="Math.max(goodsOptions.findIndex((item) => item.goodsId === selectedGoodsId), 0)"
                @change="selectedGoodsId = goodsOptions[$event.detail.value]?.goodsId ?? ''"
              >
                <view class="nearby-map-card__picker">
                  {{ selectedGoodsName || "请选择允许领取的物资" }}
                </view>
              </picker>
              <button class="vm-button" @tap="focusNearestGoods">搜索最近物资</button>
            </view>
          </view>

          <view v-if="highlightedDevice" class="nearby-map-card__focus">
            <text class="nearby-map-card__focus-title">当前定位</text>
            <text class="nearby-map-card__focus-value">
              {{ highlightedDevice.name }} · {{ formatDistance(highlightedDevice.distanceMeters) }}
            </text>
          </view>
        </view>

        <view v-if="devices.length" class="device-list">
          <view
            v-for="device in devices"
            :key="device.deviceCode"
            class="device-card"
            :class="{ 'device-card--active': device.deviceCode === highlightedDeviceCode }"
            @tap="focusDevice(device.deviceCode)"
          >
            <view class="device-card__head">
              <view class="device-card__main">
                <text class="device-card__title">{{ device.name }}</text>
                <text class="device-card__meta">{{ device.location }}</text>
                <text class="device-card__meta">
                  柜机编号 {{ device.deviceCode }} · 最近在线 {{ device.lastSeenAt.slice(0, 16).replace("T", " ") }}
                </text>
                <text class="device-card__meta">
                  {{ distanceEnabled ? `距离 ${formatDistance(device.distanceMeters)}` : "未开启定位，按默认顺序显示" }}
                </text>
              </view>
              <text class="vm-status" :class="`vm-status--${statusToneMap[device.status]}`">{{ statusLabelMap[device.status] }}</text>
            </view>

            <view class="goods-list">
              <view v-for="goods in device.doors[0]?.goods ?? []" :key="goods.goodsId" class="goods-item">
                <view class="goods-item__main">
                  <text>{{ goods.name }}</text>
                  <text class="goods-item__meta">
                    {{ categoryLabelMap[goods.category] }} · 当前 {{ goods.stock }} 件
                  </text>
                </view>
                <text v-if="goods.expiresAt" class="goods-item__meta">
                  至 {{ goods.expiresAt.slice(5, 10) }}
                </text>
              </view>
            </view>

            <view class="action-grid">
              <button class="vm-button" @tap.stop="openDevice(device.deviceCode)">
                {{
                  sessionStore.user?.role === "special"
                    ? "进入领取"
                    : sessionStore.user?.role === "merchant"
                      ? "去补货"
                      : "查看详情"
                }}
              </button>
              <button class="vm-button vm-button--ghost" @tap.stop="goFeedback(device.deviceCode)">反馈</button>
            </view>
          </view>
        </view>

        <EmptyState
          v-else
          :title="loading ? '正在同步柜机' : '当前没有可展示柜机'"
          :description="loading ? '请稍候，系统正在拉取设备信息。' : '请确认后端是否已经接入柜机数据。'"
        />
      </view>
    </GlassCard>

    <view v-if="mapExpanded" class="nearby-map-overlay" @tap.self="mapExpanded = false">
      <view class="nearby-map-overlay__panel">
        <view class="nearby-map-overlay__head">
          <view>
            <text class="nearby-map-card__title">附近柜机地图</text>
            <text class="nearby-map-card__hint">可点击大头钉高亮柜机，再从下方列表进入详情。</text>
          </view>
          <button class="vm-button vm-button--ghost" @tap="mapExpanded = false">关闭</button>
        </view>

        <map
          class="nearby-map nearby-map--expanded"
          :longitude="mapCenter.longitude"
          :latitude="mapCenter.latitude"
          :markers="mapMarkers"
          :scale="15"
          :show-location="true"
          @markertap="handleMarkerTap"
        />

        <view class="nearby-map-card__tools">
          <button class="vm-button vm-button--ghost" @tap="focusNearestDevice">找寻最近柜机</button>
          <view class="nearby-map-card__search">
            <picker
              :range="goodsOptions"
              range-key="goodsName"
              :value="Math.max(goodsOptions.findIndex((item) => item.goodsId === selectedGoodsId), 0)"
              @change="selectedGoodsId = goodsOptions[$event.detail.value]?.goodsId ?? ''"
            >
              <view class="nearby-map-card__picker">
                {{ selectedGoodsName || "请选择允许领取的物资" }}
              </view>
            </picker>
            <button class="vm-button" @tap="focusNearestGoods">搜索最近物资</button>
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
.nearby-map-card__search {
  display: grid;
  gap: 16rpx;
}

.nearby-map-card__head,
.nearby-map-card__tools,
.nearby-map-overlay__head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 16rpx;
}

.nearby-map-card__title {
  font-size: 28rpx;
  font-weight: 700;
  color: var(--vm-text);
}

.nearby-map-card__hint,
.device-card__meta,
.goods-item__meta,
.nearby-map-card__focus-value {
  font-size: 22rpx;
  color: var(--vm-text-soft);
}

.nearby-map-card__expand {
  min-width: 120rpx;
}

.nearby-map-card__picker {
  min-height: 88rpx;
  display: flex;
  align-items: center;
  padding: 0 24rpx;
  border-radius: 22rpx;
  background: rgba(255, 255, 255, 0.72);
  border: 1rpx solid rgba(159, 127, 94, 0.16);
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

.nearby-map-card__tools {
  display: grid;
  gap: 16rpx;
}

.nearby-map-card__focus {
  display: grid;
  gap: 6rpx;
  padding: 16rpx 18rpx;
  border-radius: 20rpx;
  background: rgba(255, 255, 255, 0.62);
  border: 1rpx solid rgba(159, 127, 94, 0.12);
}

.nearby-map-card__focus-title {
  font-size: 22rpx;
  color: var(--vm-text-soft);
}

.device-card {
  display: grid;
  gap: 16rpx;
  padding: 22rpx 24rpx;
  border-radius: 24rpx;
  background: rgba(255, 255, 255, 0.62);
  border: 1rpx solid rgba(159, 127, 94, 0.12);
}

.device-card--active {
  border-color: rgba(62, 110, 73, 0.35);
  box-shadow: 0 0 0 4rpx rgba(62, 110, 73, 0.08);
}

.device-card__head,
.goods-item {
  display: flex;
  justify-content: space-between;
  gap: 16rpx;
}

.device-card__main,
.goods-item__main {
  display: flex;
  flex-direction: column;
  gap: 8rpx;
}

.device-card__title {
  font-size: 30rpx;
  font-weight: 700;
  color: var(--vm-text);
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
  background: #fffaf0;
  overflow: auto;
}
</style>
