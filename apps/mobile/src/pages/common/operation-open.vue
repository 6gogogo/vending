<script setup lang="ts">
import { computed, ref } from "vue";
import { onLoad } from "@dcloudio/uni-app";

import type { CabinetOpenPurpose, DeviceRecord } from "@vm/shared-types";

import { mobileApi } from "../../api/mobile";
import EmptyState from "../../components/ui/EmptyState.vue";
import FlowSteps from "../../components/ui/FlowSteps.vue";
import GlassCard from "../../components/ui/GlassCard.vue";
import MobileShell from "../../layouts/MobileShell.vue";
import { appCopy } from "../../constants/copy";
import { useSessionStore } from "../../stores/session";
import { canOpenDevice, getDeviceStatusPresentation } from "../../utils/device-readiness";
import { appendErrorContext, getErrorMessage } from "../../utils/error-message";
import { isOpenOutcomeUncertain } from "../../utils/open-outcome";
import { isStockOperatorRole } from "../../utils/role-routing";

const sessionStore = useSessionStore();
const deviceCode = ref("");
const device = ref<DeviceRecord>();
const loading = ref(false);
const loadError = ref("");
const confirming = ref(false);
const opening = ref(false);
const hasInboundGoods = ref<boolean>();
const selectedReason = ref("维修巡检");
const customReason = ref("");

const reasonOptions = ["维修巡检", "退货取出", "临期下架", "设备清洁", "其他"];

const totalStock = computed(() =>
  device.value?.doors
    .flatMap((door) => door.goods)
    .reduce((sum, item) => sum + (item.stock ?? 0), 0) ?? 0
);

const goodsKinds = computed(() => device.value?.doors.flatMap((door) => door.goods).length ?? 0);
const loadErrorBody = computed(() =>
  appendErrorContext(
    loadError.value,
    "恢复前不会把请求失败显示成“未找到柜机”，也不会允许开门。"
  )
);
const deviceStatusPresentation = computed(() =>
  device.value
    ? getDeviceStatusPresentation(device.value)
    : loadError.value
      ? {
          canOpen: false,
          label: "状态不可用",
          tone: "danger" as const,
          actionHint: "柜机状态读取失败，请重新加载后再开门。"
        }
      : {
        canOpen: false,
        label: "状态加载中",
        tone: "warning" as const,
        actionHint: "请等待柜机状态加载完成后再开门。"
        }
);

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
  if (
    !device.value ||
    loading.value ||
    confirming.value ||
    opening.value ||
    Boolean(loadError.value) ||
    !canOpenDevice(device.value) ||
    !deviceCode.value ||
    !sessionStore.user ||
    hasInboundGoods.value === undefined
  ) {
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
    description: loadError.value
      ? "柜机状态读取失败"
      : device.value
        ? device.value.name
        : "正在确认柜机",
    state: loadError.value
      ? ("warning" as const)
      : device.value
        ? ("done" as const)
        : ("current" as const)
  },
  {
    label: "开门类型",
    description: hasInboundGoods.value === undefined ? "请选择是否有物资入柜" : hasInboundGoods.value ? "本次有物资入柜" : "本次无物资入柜",
    state: loadError.value
      ? ("todo" as const)
      : hasInboundGoods.value === undefined
        ? ("current" as const)
        : ("done" as const)
  },
  {
    label: "开柜操作",
    description: loadError.value
      ? "等待柜机状态恢复"
      : confirming.value
        ? "等待最后确认"
      : opening.value
        ? "正在下发开门指令"
      : !deviceStatusPresentation.value.canOpen
        ? deviceStatusPresentation.value.label
        : canSubmit.value
          ? "可发起开门"
          : "补全信息后开柜",
    state: loadError.value
      ? ("todo" as const)
      : confirming.value || opening.value
        ? ("current" as const)
      : canSubmit.value
        ? ("current" as const)
        : ("todo" as const)
  },
  {
    label:
      hasInboundGoods.value === undefined
        ? "后续处理"
        : hasInboundGoods.value
          ? "补货登记"
          : "操作记录",
    description:
      hasInboundGoods.value === undefined
        ? "按开门类型进入后续处理"
        : hasInboundGoods.value
          ? "关门后登记物资、数量和批次"
          : "关门后记录操作原因",
    state: "todo" as const
  }
]);

const load = async () => {
  await sessionStore.bootstrap();

  if (
    !sessionStore.user ||
    (!isStockOperatorRole(sessionStore.user.role) &&
      sessionStore.user.role !== "admin") ||
    !deviceCode.value
  ) {
    uni.reLaunch({ url: "/pages/common/login" });
    return;
  }

  loading.value = true;
  try {
    device.value = await mobileApi.getDevice(deviceCode.value);
    loadError.value = "";
  } catch (error) {
    loadError.value = getErrorMessage(error);
  } finally {
    loading.value = false;
  }
};

const submit = async () => {
  if (loading.value || confirming.value || opening.value) {
    return;
  }

  if (loadError.value) {
    uni.showModal({
      title: "柜机状态尚未确认",
      content: "上次加载柜机状态失败。请先重新加载，确认设备和库存状态后再开门。",
      confirmText: "我知道了",
      showCancel: false
    });
    return;
  }

  if (device.value && !canOpenDevice(device.value)) {
    uni.showModal({
      title: deviceStatusPresentation.value.label,
      content: deviceStatusPresentation.value.actionHint,
      confirmText: "我知道了",
      showCancel: false
    });
    return;
  }

  if (!canSubmit.value || !sessionStore.user) {
    uni.showToast({
      title: hasInboundGoods.value === undefined ? "请选择是否有物资入柜" : "请填写开门理由",
      icon: "none"
    });
    return;
  }

  confirming.value = true;
  const confirmed = await new Promise<boolean>((resolve) => {
    uni.showModal({
      title: hasInboundGoods.value ? "确认入柜开门" : "确认运营开门",
      content: hasInboundGoods.value
        ? "柜门关闭后必须提交入柜物资登记，系统不会按平台结算自动入库。"
        : `本次开门理由：${resolvedReason.value}。柜门关闭后，系统会按平台结算结果自动扣减库存，不产生支付。`,
      confirmText: "确认开门",
      success: ({ confirm }) => resolve(confirm),
      fail: () => resolve(false)
    });
  });
  confirming.value = false;

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
    const message = getErrorMessage(error);
    if (isOpenOutcomeUncertain(message, error)) {
      uni.reLaunch({
        url: `/pages/common/result?status=warning&resultType=open-pending&title=${encodeURIComponent(appCopy.openOutcomePending.title)}&detail=${encodeURIComponent(appCopy.openOutcomePending.detail)}&actionText=${encodeURIComponent(appCopy.openOutcomePending.actionText)}`
      });
    } else {
      uni.reLaunch({
        url: `/pages/common/result?status=danger&title=${encodeURIComponent("运营开门失败")}&detail=${encodeURIComponent(message)}&actionText=${encodeURIComponent("返回首页")}`
      });
    }
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
    :subtitle="device?.location ?? '选择本次开门是否有物资入柜，系统会按类型进入后续流程。'"
  >
    <template #hero-actions>
      <view class="hero-action-grid">
        <button class="vm-button vm-button--warning" :disabled="!canSubmit || confirming || opening" :loading="opening" @tap="submit">
          {{ opening ? "正在下发" : confirming ? "等待确认" : "确认开门" }}
        </button>
        <button class="vm-button vm-button--ghost" :disabled="confirming || opening" @tap="goBack">返回</button>
      </view>
    </template>

    <GlassCard tone="accent">
      <view class="vm-stack">
        <FlowSteps :steps="operationSteps" />

        <view v-if="loadError" class="device-readiness-alert device-readiness-alert--danger" role="alert" aria-live="assertive">
          <text class="device-readiness-alert__title">柜机状态读取失败</text>
          <text class="device-readiness-alert__body">{{ loadErrorBody }}</text>
          <button class="vm-button vm-button--ghost" :disabled="loading || confirming || opening" :loading="loading" @tap="load">重新加载状态</button>
        </view>

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
            <text class="vm-status" :class="`vm-status--${deviceStatusPresentation.tone}`">
              {{ deviceStatusPresentation.label }}
            </text>
          </view>
          <view v-if="!deviceStatusPresentation.canOpen" class="device-readiness-alert" role="alert" aria-live="polite">
            <text class="device-readiness-alert__body">{{ deviceStatusPresentation.actionHint }}</text>
            <button class="vm-button vm-button--ghost" :disabled="loading || confirming || opening" :loading="loading" @tap="load">重新加载状态</button>
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
        <EmptyState
          v-else
          :title="loading ? '正在加载柜机' : loadError ? '柜机数据暂时不可用' : '未找到柜机'"
          :description="loadError ? '请使用上方“重新加载状态”，确认成功前不能开门。' : '请返回柜机列表重新选择。'"
        />
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
            :disabled="confirming || opening"
            @tap="hasInboundGoods = true"
          >
            <text class="choice-card__title">有物资入柜</text>
            <text class="choice-card__body">关门后必须选择常用物资并提交补货登记，平台结算不会自动入库。</text>
          </button>
          <button
            class="choice-card"
            :class="{ 'choice-card--active': hasInboundGoods === false }"
            :disabled="confirming || opening"
            @tap="hasInboundGoods = false"
          >
            <text class="choice-card__title">没有物资入柜</text>
            <text class="choice-card__body">用于维修、退货、下架等，关门后按结算回调自动扣库存且不收款。</text>
          </button>
        </view>
      </view>
    </GlassCard>

    <GlassCard v-if="hasInboundGoods === true" tone="warning">
      <view class="vm-stack">
        <view class="section-heading">
          <text class="section-heading__title">入柜登记提醒</text>
          <text class="vm-subtitle">请先完成实物入柜，关门后页面会要求选择常用物资、数量和生产日期。</text>
        </view>
        <view class="process-list">
          <text class="process-item">1. 打开柜门并放入物资</text>
          <text class="process-item">2. 关闭柜门</text>
          <text class="process-item">3. 选择常用物资并提交入柜登记</text>
        </view>
      </view>
    </GlassCard>

    <GlassCard v-else-if="hasInboundGoods === false" tone="warning">
      <view class="vm-stack">
        <view class="section-heading">
          <text class="section-heading__title">开门理由</text>
          <text class="vm-subtitle">无物资入柜时必须留下原因，便于库存和日志追溯。</text>
        </view>

        <view class="reason-grid">
          <button
            v-for="item in reasonOptions"
            :key="item"
            class="reason-chip"
            :class="{ 'reason-chip--active': selectedReason === item }"
            :disabled="confirming || opening"
            @tap="selectedReason = item"
          >
            {{ item }}
          </button>
        </view>

        <view v-if="selectedReason === '其他'" class="vm-field">
          <text class="vm-field__label">补充说明</text>
          <textarea v-model="customReason" class="vm-field__input reason-textarea" :disabled="confirming || opening" placeholder="请填写本次开门原因" />
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

.device-readiness-alert--danger {
  border-color: var(--vm-danger-line);
  background: var(--vm-danger-bg);
}

.device-readiness-alert__title {
  font-size: 28rpx;
  font-weight: 800;
  color: var(--vm-danger);
}

.hero-action-grid,
.choice-grid,
.reason-grid,
.summary-grid {
  display: grid;
  gap: 16rpx;
}

.device-readiness-alert {
  display: grid;
  gap: 14rpx;
  padding: 18rpx 20rpx;
  border-radius: 20rpx;
  border: 1rpx solid var(--vm-warning-line);
  background: var(--vm-warning-bg);
}

.device-readiness-alert__body {
  font-size: 22rpx;
  line-height: 1.6;
  color: var(--vm-warning);
  font-weight: 700;
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
