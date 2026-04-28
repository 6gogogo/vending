<script setup lang="ts">
import { computed, ref } from "vue";
import { onLoad, onUnload } from "@dcloudio/uni-app";

import type { CabinetEventRecord, PaymentProvider } from "@vm/shared-types";

import { mobileApi } from "../../api/mobile";
import GlassCard from "../../components/ui/GlassCard.vue";
import MobileShell from "../../layouts/MobileShell.vue";
import { useSessionStore } from "../../stores/session";
import { getErrorMessage } from "../../utils/error-message";
import { resolveHomePath, syncRoleTabBar } from "../../utils/role-routing";

const sessionStore = useSessionStore();
const eventId = ref("");
const event = ref<CabinetEventRecord>();
const statusText = ref("结算，请稍后");
const hintText = ref("柜门已关闭，正在等待平台返回本次实际拿取结果。");
const countdown = ref(5);
const readyToReturn = ref(false);
const payingProvider = ref<PaymentProvider>();
const paymentMessage = ref("");

let pollTimer: ReturnType<typeof setInterval> | undefined;
let countdownTimer: ReturnType<typeof setInterval> | undefined;
let pollAttempts = 0;
let mismatchNotified = false;

const intendedSummary = computed(() =>
  event.value?.intentItems?.length
    ? event.value.intentItems.map((item) => `${item.goodsName} x${item.quantity}`).join("、")
    : "未记录"
);
const settledSummary = computed(() =>
  event.value?.goods?.length
    ? event.value.goods.map((item) => `${item.goodsName} x${item.quantity}`).join("、")
    : "等待平台结算"
);
const preSettlementItems = computed(() => event.value?.preSettlement?.items ?? []);
const settlementMatched = computed(() =>
  !event.value?.settlementComparison || event.value.settlementComparison.matched
);
const needsPayment = computed(
  () =>
    Boolean(event.value) &&
    (event.value?.status === "settled" || event.value?.status === "closed") &&
    (event.value?.amount ?? 0) > 0 &&
    event.value?.paymentNotifyStatus !== "success" &&
    event.value?.billingStatus !== "mismatch" &&
    settlementMatched.value
);
const isFreeSettlement = computed(
  () =>
    Boolean(event.value) &&
    (event.value?.status === "settled" || event.value?.status === "refunded") &&
    (event.value?.amount ?? 0) <= 0 &&
    event.value?.billingStatus !== "mismatch" &&
    settlementMatched.value
);

const formatCurrency = (amount: number) => `￥${(amount / 100).toFixed(2)}`;
const formatSettlementBreakdown = (item: {
  freeQuantity: number;
  paidQuantity: number;
  paidAmount: number;
}) =>
  `免费 ${item.freeQuantity} 件 · 付费 ${item.paidQuantity} 件${
    item.paidQuantity > 0 ? ` · ${formatCurrency(item.paidAmount)}` : ""
  }`;

const stopPolling = () => {
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = undefined;
  }
};

const stopCountdown = () => {
  if (countdownTimer) {
    clearInterval(countdownTimer);
    countdownTimer = undefined;
  }
};

const goHome = async () => {
  stopPolling();
  stopCountdown();
  await sessionStore.bootstrap();

  if (sessionStore.user) {
    syncRoleTabBar(sessionStore.user.role);
    uni.switchTab({
      url: resolveHomePath(sessionStore.user.role)
    });
    return;
  }

  uni.reLaunch({
    url: "/pages/common/login"
  });
};

const startCountdown = () => {
  stopCountdown();
  readyToReturn.value = true;
  countdown.value = 5;
  countdownTimer = setInterval(() => {
    countdown.value -= 1;

    if (countdown.value <= 0) {
      void goHome();
    }
  }, 1000);
};

const notifyMismatchIfNeeded = () => {
  if (!event.value?.settlementComparison || event.value.settlementComparison.matched || mismatchNotified) {
    return;
  }

  mismatchNotified = true;
  uni.showModal({
    title: "领取结果需要确认",
    content: `${event.value.settlementComparison.summary}，后台已收到异常记录。`,
    showCancel: false
  });
};

const applyEvent = (nextEvent: CabinetEventRecord) => {
  event.value = nextEvent;

  if (nextEvent.status === "settled" || nextEvent.status === "refunded") {
    statusText.value = nextEvent.billingStatus === "mismatch"
      ? "领取待核对"
      : needsPayment.value
        ? "待支付"
        : isFreeSettlement.value
          ? "本次免费"
          : "结算完成";
    if (needsPayment.value) {
      hintText.value = "实际拿取与选择一致，请按预结算金额完成本次支付。";
      stopPolling();
      notifyMismatchIfNeeded();
      readyToReturn.value = false;
      return;
    }

    hintText.value = nextEvent.billingStatus === "mismatch"
      ? "平台已完成结算，但实际领取结果与所选商品存在差异。"
      : "平台已完成结算，本次在免费额度内，无需支付。";
    stopPolling();
    notifyMismatchIfNeeded();
    startCountdown();
    return;
  }

  if (nextEvent.status === "closed") {
    statusText.value = "结算，请稍后";
    hintText.value = "柜门已关闭，正在等待平台返回实际拿取商品列表。";
    return;
  }

  if (nextEvent.status === "failed" || nextEvent.status === "timeout_unopened") {
    stopPolling();
    uni.reLaunch({
      url: `/pages/common/result?status=danger&title=${encodeURIComponent("本次开柜未完成")}&detail=${encodeURIComponent("柜机流程异常，后台已记录，请稍后重试或联系工作人员。")}`
    });
    return;
  }

  if (pollAttempts >= 8) {
    stopPolling();
    statusText.value = "结算，请稍后";
    hintText.value = "柜门已关闭，平台结算仍在处理中，稍后会自动返回首页。";
    startCountdown();
    return;
  }
};

const invokeClientPayment = async (provider: PaymentProvider, payload: Record<string, unknown>) => {
  if (payload.simulated) {
    return;
  }

  if (provider === "alipay") {
    const maybeMy = (globalThis as unknown as {
      my?: {
        tradePay: (options: {
          tradeNO?: string;
          orderStr?: string;
          success: () => void;
          fail: (error: unknown) => void;
        }) => void;
      };
    }).my;

    if (maybeMy?.tradePay) {
      await new Promise<void>((resolve, reject) => {
        maybeMy.tradePay({
          tradeNO: typeof payload.tradeNO === "string" ? payload.tradeNO : undefined,
          orderStr: typeof payload.orderStr === "string" ? payload.orderStr : undefined,
          success: resolve,
          fail: reject
        });
      });
      return;
    }
  }

  await new Promise<void>((resolve, reject) => {
    uni.requestPayment({
      provider: provider === "wechat" ? "wxpay" : "alipay",
      timeStamp: typeof payload.timeStamp === "string" ? payload.timeStamp : undefined,
      nonceStr: typeof payload.nonceStr === "string" ? payload.nonceStr : undefined,
      package: typeof payload.package === "string" ? payload.package : undefined,
      signType: typeof payload.signType === "string" ? payload.signType : undefined,
      paySign: typeof payload.paySign === "string" ? payload.paySign : undefined,
      orderInfo: typeof payload.orderStr === "string" ? payload.orderStr : typeof payload.tradeNO === "string" ? payload.tradeNO : undefined,
      success: () => resolve(),
      fail: reject
    } as UniApp.RequestPaymentOptions);
  });
};

const paySettlement = async (provider: PaymentProvider) => {
  if (!event.value) {
    return;
  }

  payingProvider.value = provider;
  paymentMessage.value = "";

  try {
    const payment = await mobileApi.createPaymentOrder({
      provider,
      phase: "post_settlement",
      eventId: event.value.eventId,
      orderNo: event.value.orderNo,
      deviceCode: event.value.deviceCode,
      amount: event.value.amount,
      payerUserId: event.value.userId,
      subject: `柜机结算支付 ${event.value.orderNo}`
    });

    await invokeClientPayment(provider, payment.invokePayload);

    if (payment.invokePayload.simulated) {
      await mobileApi.mockPaymentPaid(payment.order.id);
    }

    paymentMessage.value = "支付已完成，正在同步订单状态。";
    await loadEvent();
    startCountdown();
  } catch (error) {
    paymentMessage.value = getErrorMessage(error);
    uni.showToast({
      title: paymentMessage.value,
      icon: "none"
    });
  } finally {
    payingProvider.value = undefined;
  }
};

const loadEvent = async () => {
  if (!eventId.value) {
    uni.reLaunch({
      url: `/pages/common/result?status=danger&title=${encodeURIComponent("缺少事件信息")}&detail=${encodeURIComponent("未识别到本次开柜事件，请重新发起。")}`
    });
    return;
  }

  try {
    const response = await mobileApi.getCabinetEvent(eventId.value);
    pollAttempts += 1;
    applyEvent(response);
  } catch (error) {
    stopPolling();
    stopCountdown();
    uni.reLaunch({
      url: `/pages/common/result?status=danger&title=${encodeURIComponent("结算状态获取失败")}&detail=${encodeURIComponent(getErrorMessage(error))}`
    });
  }
};

onLoad((query) => {
  eventId.value = typeof query.eventId === "string" ? query.eventId : "";
  void loadEvent();
  pollTimer = setInterval(() => {
    void loadEvent();
  }, 2000);
});

onUnload(() => {
  stopPolling();
  stopCountdown();
});
</script>

<template>
  <MobileShell eyebrow="闭门确认" :title="statusText" :subtitle="hintText">
    <GlassCard tone="accent">
      <view class="vm-stack">
        <view class="status-box">
          <text class="status-box__label">本次计划领取</text>
          <text class="status-box__value">{{ intendedSummary }}</text>
        </view>
        <view class="status-box">
          <text class="status-box__label">平台实际结算</text>
          <text class="status-box__value">{{ settledSummary }}</text>
        </view>
        <view v-if="preSettlementItems.length" class="billing-box">
          <view class="billing-box__head">
            <text class="billing-box__title">预结算明细</text>
            <text class="billing-box__amount">
              {{ event?.preSettlement?.payableAmount ? formatCurrency(event.preSettlement.payableAmount) : "免费" }}
            </text>
          </view>
          <view v-for="item in preSettlementItems" :key="item.goodsId" class="billing-row">
            <text class="billing-row__name">{{ item.goodsName }} x{{ item.quantity }}</text>
            <text class="billing-row__meta">
              {{ formatSettlementBreakdown(item) }}
            </text>
          </view>
        </view>
        <view v-if="event?.settlementComparison && !event.settlementComparison.matched" class="warning-box">
          <text class="warning-box__title">已发现差异</text>
          <text class="warning-box__body">{{ event.settlementComparison.summary }}</text>
        </view>
        <view v-if="isFreeSettlement" class="free-box">
          <text class="free-box__title">无需支付</text>
          <text class="free-box__body">实际拿取与选择一致，本次商品在可领取额度内。</text>
        </view>
        <view v-if="needsPayment" class="payment-box">
          <text class="payment-box__title">预结算待支付金额</text>
          <text class="payment-box__amount">{{ formatCurrency(event?.amount ?? 0) }}</text>
          <text class="payment-box__body">支付成功后系统会自动回写柜机平台的付款成功状态。</text>
          <button class="vm-button" :loading="payingProvider === 'wechat'" @tap="paySettlement('wechat')">微信支付</button>
          <button class="vm-button vm-button--ghost" :loading="payingProvider === 'alipay'" @tap="paySettlement('alipay')">支付宝支付</button>
          <text v-if="paymentMessage" class="payment-box__body">{{ paymentMessage }}</text>
        </view>
        <text class="vm-subtitle">
          {{ readyToReturn ? `页面将在 ${countdown} 秒后自动返回首页。` : "结算结果确认后会自动返回首页。" }}
        </text>
        <button class="vm-button" @tap="goHome">立即返回首页</button>
      </view>
    </GlassCard>
  </MobileShell>
</template>

<style scoped>
.status-box,
.billing-box,
.free-box,
.warning-box,
.payment-box {
  display: grid;
  gap: 8rpx;
  padding: 22rpx 24rpx;
  border-radius: 24rpx;
  background: var(--vm-surface-soft);
  border: 1rpx solid var(--vm-line);
}

.status-box__label,
.billing-box__title,
.free-box__title,
.warning-box__title,
.payment-box__title {
  font-size: 22rpx;
  color: var(--vm-text-soft);
}

.status-box__value,
.billing-row__name,
.billing-row__meta,
.free-box__body,
.warning-box__body,
.payment-box__body {
  font-size: 28rpx;
  color: var(--vm-text);
  line-height: 1.5;
}

.payment-box__amount {
  font-size: 40rpx;
  font-weight: 800;
  color: var(--vm-text);
}

.billing-box__head,
.billing-row {
  display: flex;
  justify-content: space-between;
  gap: 16rpx;
}

.billing-box__amount {
  font-size: 28rpx;
  font-weight: 800;
  color: var(--vm-accent-strong);
}

.billing-row {
  padding-top: 12rpx;
  border-top: 1rpx solid var(--vm-line);
}

.billing-row__meta {
  text-align: right;
  color: var(--vm-text-soft);
}

.free-box {
  background: var(--vm-success-bg);
  border-color: var(--vm-success-line);
}

.warning-box {
  background: rgba(255, 245, 232, 0.88);
  border-color: rgba(207, 120, 43, 0.18);
}
</style>

