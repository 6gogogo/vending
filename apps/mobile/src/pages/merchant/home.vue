<script setup lang="ts">
import { ref } from "vue";
import { onShow } from "@dcloudio/uni-app";
import type { DeviceStatus, DeviceRecord, InventoryMovement } from "@vm/shared-types";

import { mobileApi } from "../../api/mobile";
import EmptyState from "../../components/ui/EmptyState.vue";
import GlassCard from "../../components/ui/GlassCard.vue";
import ServiceMetric from "../../components/ui/ServiceMetric.vue";
import { useCabinetFlow } from "../../composables/useCabinetFlow";
import { appCopy } from "../../constants/copy";
import MobileShell from "../../layouts/MobileShell.vue";
import { useSessionStore } from "../../stores/session";
import { getErrorMessage } from "../../utils/error-message";

const sessionStore = useSessionStore();
const devices = ref<DeviceRecord[]>([]);
const records = ref<InventoryMovement[]>([]);
const alerts = ref<Array<{ id: string; title: string; detail: string; dueAt: string }>>([]);
const loading = ref(false);
const summary = ref({
  donatedUnits: 0,
  expiredUnits: 0,
  pendingAlerts: 0
});
const { openCabinet, latestOrder, latestEventId, loading: opening } = useCabinetFlow();

const statusLabelMap: Record<DeviceStatus, string> = {
  online: "在线",
  offline: "离线",
  maintenance: "维护"
};

const statusToneMap: Record<DeviceStatus, "success" | "warning" | "danger"> = {
  online: "success",
  offline: "danger",
  maintenance: "warning"
};

const load = async () => {
  if (!sessionStore.user) {
    uni.reLaunch({
      url: "/pages/common/login"
    });
    return;
  }

  loading.value = true;
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
  } finally {
    loading.value = false;
  }
};

const formatDateTime = (value: string) => value.slice(0, 16).replace("T", " ");

onShow(load);
</script>

<template>
  <MobileShell eyebrow="商户端" :title="sessionStore.user?.name ?? '商户账号'" :subtitle="appCopy.merchantWelcome">
    <template #hero-extra>
      <GlassCard tone="quiet" compact>
        <view class="hero-box">
          <text class="hero-box__label">近期协同</text>
          <text class="hero-box__value">{{ latestOrder ?? "等待新的投放动作" }}</text>
          <text class="hero-box__meta">{{ latestEventId ? `事件 ${latestEventId}` : "发起开柜后将在这里展示最近进度" }}</text>
        </view>
      </GlassCard>
    </template>

    <GlassCard tone="accent">
      <view class="vm-stack">
        <view class="section-heading">
          <text class="section-heading__title">今日运营概览</text>
          <text class="vm-subtitle">先看投放量、预警压力和过期处理，再安排补货动作。</text>
        </view>

        <view class="metric-grid">
          <ServiceMetric label="累计投放件数" :value="summary.donatedUnits" hint="近阶段已完成入柜" />
          <ServiceMetric label="待处理预警" :value="summary.pendingAlerts" hint="优先查看到期任务" tone="warning" />
          <ServiceMetric label="过期处理件数" :value="summary.expiredUnits" hint="用于核对回收与补扣" />
        </view>
      </view>
    </GlassCard>

    <view class="vm-section">
      <view class="section-heading">
        <text class="section-heading__title">投放开柜</text>
        <text class="vm-subtitle">按设备逐个发起开柜，便于线下补货和巡检。</text>
      </view>

      <view v-if="devices.length" class="device-list">
        <GlassCard v-for="device in devices" :key="device.deviceCode">
          <view class="vm-stack">
            <view class="device-head">
              <view>
                <text class="device-head__title">{{ device.name }}</text>
                <text class="vm-subtitle">{{ device.location }}</text>
              </view>
              <text class="vm-status" :class="`vm-status--${statusToneMap[device.status]}`">{{ statusLabelMap[device.status] }}</text>
            </view>

            <view class="device-foot">
              <text class="device-foot__meta">柜机编号 {{ device.deviceCode }}</text>
              <text class="device-foot__meta">最近在线 {{ formatDateTime(device.lastSeenAt) }}</text>
            </view>

            <button class="vm-button" :loading="opening" @tap="openCabinet(device.deviceCode)">发起投放开柜</button>
          </view>
        </GlassCard>
      </view>
      <GlassCard v-else tone="quiet">
        <EmptyState
          :title="loading ? '正在加载设备信息' : '暂无可操作设备'"
          :description="loading ? '系统正在同步设备状态，请稍候。' : '请联系后台确认商户绑定的默认设备。'"
        />
      </GlassCard>
    </view>

    <GlassCard tone="warning">
      <view class="vm-stack">
        <view class="section-heading">
          <text class="section-heading__title">待处理预警</text>
          <text class="vm-subtitle">优先处理即将到期或需要回收的物资，避免库存浪费。</text>
        </view>

        <view v-if="alerts.length" class="task-list">
          <view v-for="alert in alerts.slice(0, 4)" :key="alert.id" class="task-item">
            <view class="task-item__main">
              <text class="task-item__title">{{ alert.title }}</text>
              <text class="task-item__meta">{{ alert.detail }}</text>
            </view>
            <text class="task-item__due">截至 {{ alert.dueAt.slice(5, 16).replace('T', ' ') }}</text>
          </view>
        </view>
        <EmptyState v-else title="当前没有待处理预警" description="系统有新预警时，这里会优先提醒你处理。" />
      </view>
    </GlassCard>

    <GlassCard tone="quiet">
      <view class="vm-stack">
        <view class="section-heading">
          <text class="section-heading__title">最近投放记录</text>
          <text class="vm-subtitle">便于对照实际投放批次与领取截止时间。</text>
        </view>

        <view v-if="records.length" class="task-list">
          <view v-for="record in records.slice(0, 4)" :key="record.id" class="task-item">
            <view class="task-item__main">
              <text class="task-item__title">{{ record.goodsName }}</text>
              <text class="task-item__meta">
                {{ record.expiresAt ? `领取截止 ${record.expiresAt.slice(5, 16).replace('T', ' ')}` : formatDateTime(record.happenedAt) }}
              </text>
            </view>
            <text class="vm-status vm-status--success">投放 {{ record.quantity }} 件</text>
          </view>
        </view>
        <EmptyState v-else title="还没有投放记录" description="首次投放并完成结算后，这里会自动展示。" />
      </view>
    </GlassCard>
  </MobileShell>
</template>

<style scoped>
.hero-box,
.section-heading {
  display: flex;
  flex-direction: column;
  gap: 12rpx;
}

.hero-box__label,
.hero-box__meta,
.device-foot__meta,
.task-item__meta {
  font-size: 22rpx;
  color: var(--vm-text-soft);
}

.hero-box__value,
.section-heading__title,
.device-head__title,
.task-item__title {
  font-size: 30rpx;
  font-weight: 700;
  color: var(--vm-text);
}

.metric-grid,
.device-list,
.task-list {
  display: grid;
  gap: 18rpx;
}

.device-head,
.device-foot,
.task-item {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 20rpx;
}

.device-head {
  align-items: flex-start;
}

.device-foot {
  flex-wrap: wrap;
}

.task-item {
  padding: 22rpx 24rpx;
  border-radius: 26rpx;
  background: rgba(255, 255, 255, 0.6);
  border: 1rpx solid rgba(159, 127, 94, 0.12);
}

.task-item__main {
  display: flex;
  flex-direction: column;
  gap: 8rpx;
}

.task-item__due {
  font-size: 22rpx;
  color: #8a5b11;
  text-align: right;
}

@media screen and (min-width: 720px) {
  .metric-grid {
    grid-template-columns: repeat(3, minmax(0, 1fr));
  }
}
</style>
