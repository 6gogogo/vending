<script setup lang="ts">
import { computed, ref } from "vue";
import { onShow } from "@dcloudio/uni-app";
import type { DeviceStatus, DeviceRecord, InventoryMovement } from "@vm/shared-types";

import { mobileApi } from "../../api/mobile";
import EmptyState from "../../components/ui/EmptyState.vue";
import GlassCard from "../../components/ui/GlassCard.vue";
import MobileShell from "../../layouts/MobileShell.vue";
import { appCopy } from "../../constants/copy";
import { categoryLabelMap } from "../../constants/labels";
import { useSessionStore } from "../../stores/session";
import { getErrorMessage } from "../../utils/error-message";

const sessionStore = useSessionStore();
const devices = ref<DeviceRecord[]>([]);
const records = ref<InventoryMovement[]>([]);
const loading = ref(false);

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

const guidanceText = computed(() => {
  if (permissionList.value.length) {
    return "先确认今天还能领什么，再去最近的柜机操作；如果机器异常，可直接反馈给工作人员。";
  }

  return "当前没有可领取额度也不需要重复操作，系统会按服务时间和资格自动刷新。";
});

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

const formatDateTime = (value: string) => value.slice(0, 16).replace("T", " ");

onShow(() => {
  load();
});
</script>

<template>
  <MobileShell eyebrow="普通用户" :title="`${sessionStore.user?.name ?? '访客'}，您好`" :subtitle="appCopy.specialWelcome">
    <template #hero-actions>
      <view class="hero-action-grid">
        <button class="vm-button" @tap="goNearbyTab">就近找柜机</button>
        <button class="vm-button vm-button--ghost" @tap="goHistory">查看服务记录</button>
      </view>
    </template>

    <GlassCard tone="accent">
      <view class="vm-stack">
        <view class="section-heading">
          <text class="section-heading__title">今日可领取概览</text>
          <text class="vm-subtitle">请先确认今天可领取的物资和相关提醒。</text>
        </view>

        <view class="care-note">
          <text class="care-note__title">服务说明</text>
          <text class="care-note__body">
            {{ serviceWindows.length ? `可领取时段：${serviceWindows.join("、")}` : "当前暂无开放时段，系统会按业务时间自动刷新资格。" }}
          </text>
          <text class="care-note__body">
            {{ guidanceText }}
          </text>
          <text class="care-note__body">
            如果定位失败、柜门异常或识别结果与你实际领取不一致，可以直接反馈，工作人员会继续协助核对。
          </text>
        </view>

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

        <view class="action-grid">
          <button class="vm-button" @tap="goNearbyTab">查看地图与就近推荐</button>
          <button class="vm-button vm-button--ghost" @tap="goHistory">查看服务记录</button>
          <button class="vm-button vm-button--soft action-grid__full" @tap="goFeedback()">遇到问题，联系工作人员</button>
        </view>
      </view>
    </GlassCard>

    <view class="vm-section">
      <view class="section-heading">
        <text class="section-heading__title">附近柜机</text>
        <text class="vm-subtitle">可先查看位置和库存，再决定前往哪一台柜机。</text>
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
                  <text class="goods-item__meta">{{ categoryLabelMap[goods.category] }} · 现有 {{ goods.stock }} 件</text>
                </view>
                <text v-if="goods.expiresAt" class="goods-item__tag">至 {{ goods.expiresAt.slice(5, 10) }}</text>
              </view>
            </view>

            <view class="action-grid">
              <button class="vm-button" @tap="openDeviceDetail(device.deviceCode)">选择货品并取货</button>
              <button class="vm-button vm-button--ghost" @tap="goFeedback(device.deviceCode)">反馈这台柜机</button>
            </view>
          </view>
        </GlassCard>
      </view>
      <GlassCard v-else tone="quiet">
        <EmptyState
          :title="loading ? '正在加载柜机信息' : '附近暂无可用柜机'"
          :description="loading ? '请稍候，系统正在同步设备状态。' : '请联系工作人员确认设备接入状态。'"
        />
      </GlassCard>
    </view>

    <GlassCard tone="quiet">
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
.hero-action-grid {
  display: grid;
  gap: 16rpx;
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
  background: rgba(255, 255, 255, 0.62);
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

.action-grid__full {
  grid-column: 1 / -1;
}

.goods-item__tag {
  flex-shrink: 0;
  padding: 10rpx 16rpx;
  border-radius: 999rpx;
  background: rgba(240, 177, 52, 0.16);
  color: #8a5b11;
  font-size: 22rpx;
}
</style>
