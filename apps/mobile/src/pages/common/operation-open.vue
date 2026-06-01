<script setup lang="ts">
import { computed, ref } from "vue";
import { onLoad } from "@dcloudio/uni-app";

import type { CabinetOpenPurpose, DeviceRecord, DeviceStatus } from "@vm/shared-types";

import { mobileApi } from "../../api/mobile";
import EmptyState from "../../components/ui/EmptyState.vue";
import FlowSteps from "../../components/ui/FlowSteps.vue";
import GlassCard from "../../components/ui/GlassCard.vue";
import MobileShell from "../../layouts/MobileShell.vue";
import { useSessionStore } from "../../stores/session";
import { getErrorMessage } from "../../utils/error-message";

const sessionStore = useSessionStore();
const deviceCode = ref("");
const device = ref<DeviceRecord>();
const loading = ref(false);
const opening = ref(false);
const hasInboundGoods = ref<boolean>();
const selectedReason = ref("维修巡检");
const customReason = ref("");

const reasonOptions = ["维修巡检", "退货取出", "临期下架", "设备清洁", "其他"];

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

const totalStock = computed(() =>
  device.value?.doors
    .flatMap((door) => door.goods)
    .reduce((sum, item) => sum + (item.stock ?? 0), 0) ?? 0
);

const goodsKinds = computed(() => device.value?.doors.flatMap((door) => door.goods).length ?? 0);

const resolvedReason = computed(() => {
  if (hasInboundGoods.value) {
    return "补货入柜";
  }

  return selectedReason.value === "其他" ? customReason.value.trim() : selectedReason.value;
});

const operationType = computed<CabinetOpenPurpose>(() =>
  hasInboundGoods.value ? "restock" : "service"
);

const canSubmit = computed(() => {
  if (!device.value || !deviceCode.value || !sessionStore.user || hasInboundGoods.value === undefined) {
    return false;
  }

  if (hasInboundGoods.value) {
    return true;
  }

  return Boolean(resolvedReason.value);
});
const operationSteps = computed(() => [
  {
    label: "柜机选择",
    description: device.value ? device.value.name : "正在确认柜机",
    state: device.value ? ("done" as const) : ("current" as const)
  },
  {
    label: "开门类型",
    description: hasInboundGoods.value === undefined ? "请选择是否有商品入柜" : hasInboundGoods.value ? "本次有商品入柜" : "本次无商品入柜",
    state: hasInboundGoods.value === undefined ? ("current" as const) : ("done" as const)
  },
  {
    label: "开柜操作",
    description: canSubmit.value ? "可发起开门" : "补全信息后开柜",
    state: canSubmit.value ? ("current" as const) : ("todo" as const)
  },
  {
    label: "补货登记",
    description: hasInboundGoods.value ? "关门后登记商品、数量和批次" : "无入柜时记录操作原因",
    state: "todo" as const
  }
]);

const load = async () => {
  await sessionStore.bootstrap();

  if (!sessionStore.user || !["merchant", "admin"].includes(sessionStore.user.role) || !deviceCode.value) {
    uni.reLaunch({ url: "/pages/common/login" });
    return;
  }

  loading.value = true;
  try {
    device.value = await mobileApi.getDevice(deviceCode.value);
  } catch (error) {
    uni.showToast({
      title: getErrorMessage(error),
      icon: "none"
    });
  } finally {
    loading.value = false;
  }
};

const submit = async () => {
  if (!canSubmit.value || !sessionStore.user) {
    uni.showToast({
      title: hasInboundGoods.value === undefined ? "请选择是否有商品入柜" : "请填写开门理由",
      icon: "none"
    });
    return;
  }

  const confirmed = await new Promise<boolean>((resolve) => {
    uni.showModal({
      title: hasInboundGoods.value ? "确认入柜开门" : "确认运营开门",
      content: hasInboundGoods.value
        ? "柜门关闭后必须提交入柜商品登记，系统不会按平台结算自动入库。"
        : `本次开门理由：${resolvedReason.value}。柜门关闭后，系统会按平台结算结果自动扣减库存，不产生支付。`,
      confirmText: "确认开门",
      success: ({ confirm }) => resolve(confirm),
      fail: () => resolve(false)
    });
  });

  if (!confirmed) {
    return;
  }

  opening.value = true;
  try {
    const response = await mobileApi.openCabinet({
      phone: sessionStore.user.phone,
      deviceCode: deviceCode.value,
      doorNum: "1",
      openMode: "manual",
      operationType: operationType.value,
      hasInboundGoods: hasInboundGoods.value,
      openReason: resolvedReason.value
    });

    uni.redirectTo({
      url: `/pages/common/opening?eventId=${encodeURIComponent(response.eventId)}&deviceCode=${encodeURIComponent(response.deviceCode)}`
    });
  } catch (error) {
    uni.showToast({
      title: getErrorMessage(error),
      icon: "none"
    });
  } finally {
    opening.value = false;
  }
};

const goBack = () => {
  uni.navigateBack();
};

onLoad((query) => {
  deviceCode.value = typeof query.deviceCode === "string" ? query.deviceCode : "";
  void load();
});
</script>

<template>
  <MobileShell
    mode="ops"
    eyebrow="运营开门"
    :title="(device?.name ?? deviceCode) || '柜机开门'"
    :subtitle="device?.location ?? '选择本次开门是否有商品入柜，系统会按类型进入后续流程。'"
  >
    <template #hero-actions>
      <view class="hero-action-grid">
        <button class="vm-button vm-button--warning" :disabled="!canSubmit" :loading="opening" @tap="submit">确认开门</button>
        <button class="vm-button vm-button--ghost" @tap="goBack">返回</button>
      </view>
    </template>

    <GlassCard tone="accent">
      <view class="vm-stack">
        <FlowSteps :steps="operationSteps" />

        <view class="section-heading">
          <text class="section-heading__title">柜机状态</text>
          <text class="vm-subtitle">开门前先确认点位、状态和当前库存概况。</text>
        </view>

        <view v-if="device" class="device-summary">
          <view class="summary-row">
            <text class="summary-row__label">柜机编号</text>
            <text class="summary-row__value vm-number">{{ device.deviceCode }}</text>
          </view>
          <view class="summary-row">
            <text class="summary-row__label">在线状态</text>
            <text class="vm-status" :class="`vm-status--${statusToneMap[device.status]}`">
              {{ statusLabelMap[device.status] }}
            </text>
          </view>
          <view class="summary-grid">
            <view class="mini-metric">
              <text class="mini-metric__value vm-number">{{ goodsKinds }}</text>
              <text class="mini-metric__label">货品种类</text>
            </view>
            <view class="mini-metric">
              <text class="mini-metric__value vm-number">{{ totalStock }}</text>
              <text class="mini-metric__label">当前库存</text>
            </view>
          </view>
        </view>
        <EmptyState v-else :title="loading ? '正在加载柜机' : '未找到柜机'" description="请返回柜机列表重新选择。" />
      </view>
    </GlassCard>

    <GlassCard tone="quiet">
      <view class="vm-stack">
        <view class="section-heading">
          <text class="section-heading__title">本次开门类型</text>
          <text class="vm-subtitle">此选择会决定后续库存处理方式。</text>
        </view>

        <view class="choice-grid">
          <button
            class="choice-card"
            :class="{ 'choice-card--active': hasInboundGoods === true }"
            @tap="hasInboundGoods = true"
          >
            <text class="choice-card__title">有商品入柜</text>
            <text class="choice-card__body">关门后必须选择常用商品并提交补货登记，平台结算不会自动入库。</text>
          </button>
          <button
            class="choice-card"
            :class="{ 'choice-card--active': hasInboundGoods === false }"
            @tap="hasInboundGoods = false"
          >
            <text class="choice-card__title">没有商品入柜</text>
            <text class="choice-card__body">用于维修、退货、下架等，关门后按结算回调自动扣库存且不收款。</text>
          </button>
        </view>
      </view>
    </GlassCard>

    <GlassCard v-if="hasInboundGoods === true" tone="warning">
      <view class="vm-stack">
        <view class="section-heading">
          <text class="section-heading__title">入柜登记提醒</text>
          <text class="vm-subtitle">请先完成实物入柜，关门后页面会要求选择常用商品、数量和生产日期。</text>
        </view>
        <view class="process-list">
          <text class="process-item">1. 打开柜门并放入商品</text>
          <text class="process-item">2. 关闭柜门</text>
          <text class="process-item">3. 选择常用商品并提交入柜登记</text>
        </view>
      </view>
    </GlassCard>

    <GlassCard v-else-if="hasInboundGoods === false" tone="warning">
      <view class="vm-stack">
        <view class="section-heading">
          <text class="section-heading__title">开门理由</text>
          <text class="vm-subtitle">无商品入柜时必须留下原因，便于库存和日志追溯。</text>
        </view>

        <view class="reason-grid">
          <button
            v-for="item in reasonOptions"
            :key="item"
            class="reason-chip"
            :class="{ 'reason-chip--active': selectedReason === item }"
            @tap="selectedReason = item"
          >
            {{ item }}
          </button>
        </view>

        <view v-if="selectedReason === '其他'" class="vm-field">
          <text class="vm-field__label">补充说明</text>
          <textarea v-model="customReason" class="vm-field__input reason-textarea" placeholder="请填写本次开门原因" />
        </view>
      </view>
    </GlassCard>
  </MobileShell>
</template>

<style scoped>
.section-heading,
.device-summary,
.process-list {
  display: grid;
  gap: 12rpx;
}

.section-heading__title,
.choice-card__title {
  font-size: 30rpx;
  font-weight: 700;
  color: var(--vm-text);
}

.hero-action-grid,
.choice-grid,
.reason-grid,
.summary-grid {
  display: grid;
  gap: 16rpx;
}

.hero-action-grid {
  grid-template-columns: repeat(2, minmax(0, 1fr));
}

.summary-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16rpx;
  padding: 18rpx 0;
  border-bottom: 1rpx solid var(--vm-line);
}

.summary-row__label,
.mini-metric__label,
.choice-card__body,
.process-item {
  font-size: 22rpx;
  line-height: 1.6;
  color: var(--vm-text-soft);
}

.summary-row__value {
  font-size: 26rpx;
  color: var(--vm-text);
}

.summary-grid {
  grid-template-columns: repeat(2, minmax(0, 1fr));
}

.mini-metric {
  display: grid;
  gap: 8rpx;
  padding: 18rpx 20rpx;
  border-radius: 22rpx;
  background: var(--vm-surface-soft);
  border: 1rpx solid var(--vm-line);
}

.mini-metric__value {
  font-size: 38rpx;
  font-weight: 800;
  color: var(--vm-accent-strong);
}

.choice-card {
  display: grid;
  gap: 10rpx;
  min-height: 150rpx;
  padding: 24rpx;
  text-align: left;
  border-radius: 24rpx;
  border: 1rpx solid var(--vm-line-strong);
  background: var(--vm-surface-soft);
}

.choice-card--active {
  border-color: var(--vm-info-line);
  background: var(--vm-info-bg);
  box-shadow: 0 0 0 4rpx var(--vm-focus-ring);
}

.reason-grid {
  grid-template-columns: repeat(2, minmax(0, 1fr));
}

.reason-chip {
  min-height: 84rpx;
  padding: 0 18rpx;
  border-radius: 22rpx;
  border: 1rpx solid var(--vm-line-strong);
  background: var(--vm-surface-soft);
  color: var(--vm-text);
  font-size: 24rpx;
}

.reason-chip--active {
  border-color: var(--vm-accent-line);
  background: var(--vm-accent-soft);
  color: var(--vm-accent-strong);
  font-weight: 700;
}

.reason-textarea {
  min-height: 180rpx;
  padding-top: 22rpx;
  line-height: 1.5;
}

@media screen and (min-width: 720px) {
  .choice-grid,
  .reason-grid {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }
}
</style>
