<script setup lang="ts">
import { computed, ref } from "vue";
import { onLoad, onUnload } from "@dcloudio/uni-app";

import type {
  CabinetAdjustmentRecord,
  CabinetEventRecord,
  MerchantGoodsTemplate,
  PaymentOrderCreatePayload,
  PaymentProvider
} from "@vm/shared-types";

import { mobileApi } from "../../api/mobile";
import EmptyState from "../../components/ui/EmptyState.vue";
import FlowSteps from "../../components/ui/FlowSteps.vue";
import GlassCard from "../../components/ui/GlassCard.vue";
import MobileShell from "../../layouts/MobileShell.vue";
import { useSessionStore } from "../../stores/session";
import { formatBeijingDate } from "../../utils/datetime";
import { appendErrorContext, getErrorMessage } from "../../utils/error-message";
import {
  classifyClientPaymentError,
  isPaymentRequestOutcomeUncertain,
  resolvePaymentReconciliationRequestOrderId,
  resolvePaymentLaunchAction
} from "../../utils/payment-safety";
import { resolveHomePath, syncRoleTabBar } from "../../utils/role-routing";

type PaymentUiState =
  | "idle"
  | "creating"
  | "awaiting_simulation"
  | "processing"
  | "confirming"
  | "confirmation_timeout"
  | "unpaid"
  | "failed"
  | "paid";
type SimulatedPaymentChoice = "paid" | "unpaid";
type SimulatedPaymentContext = {
  id: string;
  provider: PaymentProvider;
  orderNo: string;
  amount: number;
  reason: string;
};

const sessionStore = useSessionStore();
const eventId = ref("");
const event = ref<CabinetEventRecord>();
const statusText = ref("结算，请稍后");
const hintText = ref("柜门已关闭，正在等待平台返回本次实际拿取结果。");
const countdown = ref(5);
const readyToReturn = ref(false);
const payingProvider = ref<PaymentProvider>();
const paymentMessage = ref("");
const paymentUiState = ref<PaymentUiState>("idle");
const simulatedPayment = ref<SimulatedPaymentContext>();
const templates = ref<MerchantGoodsTemplate[]>([]);
const templatesLoading = ref(false);
const restockSubmitting = ref(false);
const restockSubmitted = ref(false);
const selectedTemplateId = ref("");
const restockQuantity = ref(0);
const productionDate = ref(formatBeijingDate(new Date()));
const restockBatchNo = ref("");
const restockNote = ref("");
const PAYMENT_CONFIRMATION_TIMEOUT_MS = 60_000;

let pollTimer: ReturnType<typeof setInterval> | undefined;
let countdownTimer: ReturnType<typeof setInterval> | undefined;
let pollAttempts = 0;
let mismatchNotified = false;
let settlementConfirmationShown = false;
let adjustmentPaymentNotified = false;
let refundNotified = false;
let paymentConfirmationStartedAt: number | undefined;
let paymentConfirmationOrderNo: string | undefined;

const isOperationalEvent = computed(
  () => event.value?.role === "merchant" || event.value?.role === "admin"
);
const isInboundOperation = computed(
  () => isOperationalEvent.value && event.value?.hasInboundGoods === true
);
const isNoInboundOperation = computed(
  () => isOperationalEvent.value && event.value?.hasInboundGoods === false
);
const intendedSummary = computed(() =>
  isInboundOperation.value
    ? "有商品入柜，需提交常用商品登记"
    : isNoInboundOperation.value
      ? `无商品入柜 · ${event.value?.openReason ?? "未填写理由"}`
      : event.value?.intentItems?.length
        ? event.value.intentItems.map((item) => `${item.goodsName} x${item.quantity}`).join("、")
        : "未记录"
);
const settledSummary = computed(() =>
  isInboundOperation.value
    ? restockSubmitted.value
      ? "常用商品登记已提交"
      : "等待手动登记入柜商品"
    : event.value?.goods?.length
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
    !isOperationalEvent.value &&
    (event.value?.status === "settled" || event.value?.status === "closed") &&
    (event.value?.amount ?? 0) > 0 &&
    event.value?.paymentNotifyStatus !== "success" &&
    event.value?.billingStatus !== "mismatch" &&
    settlementMatched.value
);
const pendingAdjustment = computed<CabinetAdjustmentRecord | undefined>(() =>
  event.value?.adjustments?.find(
    (adjustment) =>
      adjustment.amount > 0 &&
      adjustment.paymentNotifyStatus !== "success" &&
      !adjustment.refundedAt
  )
);
const needsAdjustmentPayment = computed(() => Boolean(pendingAdjustment.value));
const paymentConfirmationActive = computed(
  () => paymentUiState.value === "confirming" || paymentUiState.value === "confirmation_timeout"
);
const pendingPaymentReconciliationOrderId = computed(() =>
  resolvePaymentReconciliationRequestOrderId(event.value?.paymentRecovery)
);
const paymentRecoveryActionLabel = computed(() => {
  if (paymentUiState.value === "confirming") {
    return pendingPaymentReconciliationOrderId.value
      ? "正在请求后台安全核对"
      : "正在刷新服务端状态";
  }

  return pendingPaymentReconciliationOrderId.value
    ? "请求后台安全核对，不会再次支付"
    : "刷新服务端状态，不会再次支付";
});
const adjustmentPaymentCompleted = computed(() =>
  Boolean(
    event.value?.adjustments?.some(
      (adjustment) => adjustment.amount > 0 && adjustment.paymentNotifyStatus === "success"
    )
  )
);
const settlementPaymentCompleted = computed(
  () => event.value?.paymentNotifyStatus === "success"
);
const activePaymentAmount = computed(() =>
  pendingAdjustment.value?.amount ?? event.value?.amount ?? 0
);
const activePaymentOrderNo = computed(() =>
  pendingAdjustment.value?.orderNo ?? event.value?.orderNo ?? ""
);
const refundCompleted = computed(
  () =>
    Boolean(event.value?.refundedAt) ||
    Boolean(event.value?.adjustments?.some((adjustment) => Boolean(adjustment.refundedAt)))
);
const isFreeSettlement = computed(
  () =>
    Boolean(event.value) &&
    !isOperationalEvent.value &&
    (event.value?.status === "settled" || event.value?.status === "refunded") &&
    (event.value?.amount ?? 0) <= 0 &&
    event.value?.billingStatus !== "mismatch" &&
    settlementMatched.value &&
    !needsAdjustmentPayment.value
);
const selectedTemplate = computed(() =>
  templates.value.find((entry) => entry.id === selectedTemplateId.value)
);
const estimatedExpireDate = computed(() => {
  const shelfLifeDays = selectedTemplate.value?.defaultShelfLifeDays;

  if (!shelfLifeDays || !productionDate.value) {
    return "";
  }

  const date = new Date(`${productionDate.value}T00:00:00`);

  if (Number.isNaN(date.getTime())) {
    return "";
  }

  date.setDate(date.getDate() + shelfLifeDays);

  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
});
const canSubmitRestock = computed(
  () =>
    Boolean(event.value?.deviceCode) &&
    Boolean(selectedTemplateId.value) &&
    Number(restockQuantity.value) > 0 &&
    Boolean(productionDate.value) &&
    !restockSubmitted.value
);
const returnHintText = computed(() => {
  if (isInboundOperation.value && !restockSubmitted.value) {
    return "提交入柜登记后可返回首页。";
  }

  if (needsPayment.value || needsAdjustmentPayment.value) {
    return needsAdjustmentPayment.value
      ? "本次为后台核对后的补扣，请在下方支付面板完成；未支付会保留待处理。"
      : "支付成功后会同步结算结果；未支付不会扣款，也不会回写付款成功。";
  }

  return readyToReturn.value ? `页面将在 ${countdown.value} 秒后自动返回首页。` : "结算结果确认后会自动返回首页。";
});
const returnButtonText = computed(() =>
  isInboundOperation.value && !restockSubmitted.value
    ? "提交登记后返回"
    : needsPayment.value || needsAdjustmentPayment.value
      ? "稍后处理"
      : "立即返回首页"
);
const flowSteps = computed(() => {
  const settlementDone =
    restockSubmitted.value ||
    isFreeSettlement.value ||
    event.value?.status === "refunded" ||
    event.value?.paymentNotifyStatus === "success" ||
    (Boolean(event.value?.adjustments?.length) && !needsAdjustmentPayment.value);
  const settlementWarning =
    needsPayment.value ||
    needsAdjustmentPayment.value ||
    Boolean(event.value?.settlementComparison && !event.value.settlementComparison.matched);

  return [
    {
      label: isOperationalEvent.value ? "权限校验" : "资格校验",
      description: "账号与柜机已确认",
      state: "done" as const
    },
    {
      label: "开柜",
      description: "柜门已打开并完成操作",
      state: "done" as const
    },
    {
      label: isOperationalEvent.value ? "操作后关门" : "取货关门",
      description: "柜门已关闭",
      state: "done" as const
    },
    {
      label: isInboundOperation.value ? "登记批次" : "完成结算",
      description: settlementDone ? "已完成" : settlementWarning ? "请按提示处理" : "正在核对结果",
      state: settlementDone ? ("done" as const) : settlementWarning ? ("warning" as const) : ("current" as const)
    }
  ];
});

const formatCurrency = (amount: number) => `￥${(amount / 100).toFixed(2)}`;
const providerLabel = (provider: PaymentProvider) => (provider === "wechat" ? "微信支付" : "支付宝支付");
const formatSettlementBreakdown = (item: {
  freeQuantity: number;
  paidQuantity: number;
  paidAmount: number;
}) =>
  `免费 ${item.freeQuantity} 件 · 付费 ${item.paidQuantity} 件${
    item.paidQuantity > 0 ? ` · ${formatCurrency(item.paidAmount)}` : ""
  }`;

const paymentStateMeta = computed(() => {
  if (paymentUiState.value === "creating") {
    return {
      tone: "info",
      title: "正在创建支付单",
      body: "系统正在核对金额和业务订单，请不要重复点击支付按钮。"
    };
  }

  if (paymentUiState.value === "awaiting_simulation") {
    return {
      tone: "warning",
      title: "等待模拟支付选择",
      body: "当前环境没有发起真实扣款，可在弹窗或下方面板选择模拟已支付、暂不支付或模拟失败。"
    };
  }

  if (paymentUiState.value === "processing") {
    return {
      tone: "info",
      title: "客户端正在完成支付",
      body: "支付组件仍在处理，请不要退出或重复点击支付按钮。"
    };
  }

  if (paymentUiState.value === "confirming") {
    return {
      tone: "info",
      title: "等待服务端确认",
      body: "客户端支付动作已完成，系统正在轮询服务端结果；在确认前不会显示为已支付。"
    };
  }

  if (paymentUiState.value === "confirmation_timeout") {
    return {
      tone: "warning",
      title: "支付结果待确认",
      body: "支付请求可能已经到达渠道；确认前不要重复支付。若状态长时间未更新，请联系管理员核对渠道订单。"
    };
  }

  if (paymentUiState.value === "unpaid") {
    return {
      tone: "warning",
      title: "支付未完成",
      body: "订单仍处于待支付状态。你可以继续支付，也可以稍后回到本页面处理；未支付不会产生扣款。"
    };
  }

  if (paymentUiState.value === "failed") {
    return {
      tone: "danger",
      title: "支付未完成",
      body: "支付流程没有完成，可重新发起支付。系统不会因为失败或取消而重复扣款。"
    };
  }

  if (paymentUiState.value === "paid") {
    return {
      tone: "success",
      title: "服务端已确认支付",
      body: "服务端已返回付款成功，本次领取或补扣状态已确认。"
    };
  }

  return {
    tone: "quiet",
    title: needsAdjustmentPayment.value ? "补扣待支付" : "待支付",
    body: needsAdjustmentPayment.value
      ? "后台核对后产生补扣金额，请先完成支付。"
      : "超出免费额度的金额需要支付后完成结算。"
  };
});

const paymentActionHint = computed(() => {
  if (paymentConfirmationActive.value) {
    return paymentUiState.value === "confirmation_timeout"
      ? pendingPaymentReconciliationOrderId.value
        ? "请请求后台核对原支付单；该操作不会再次发起支付。"
        : "请刷新服务端记录；该操作不会再次发起支付。"
      : "请保持本页打开，系统会持续查询服务端确认结果。";
  }

  return needsAdjustmentPayment.value
    ? "补扣支付成功后，系统会把本次补扣标记为已完成。"
    : "结算支付成功后，系统会把本次领取标记为已付款。";
});

const stopPolling = () => {
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = undefined;
  }
};

const startPolling = () => {
  if (pollTimer) {
    return;
  }

  pollTimer = setInterval(() => {
    void loadEvent();
  }, 2000);
};

const markPaymentConfirmationPending = (message: string, orderNo: string) => {
  paymentConfirmationStartedAt = Date.now();
  paymentConfirmationOrderNo = orderNo;
  paymentUiState.value = "confirming";
  paymentMessage.value = message;
  startPolling();
};

const markPaymentOutcomeUnknown = (message: string, orderNo: string) => {
  paymentConfirmationStartedAt = Date.now();
  paymentConfirmationOrderNo = orderNo;
  paymentUiState.value = "confirmation_timeout";
  paymentMessage.value = message;
  statusText.value = "支付结果待确认";
  hintText.value = "暂未取得最终支付结果。请先重新确认服务端状态，未确认前不要再次支付。";
  readyToReturn.value = false;
  stopPolling();
};

const stopCountdown = () => {
  if (countdownTimer) {
    clearInterval(countdownTimer);
    countdownTimer = undefined;
  }
};

const goHome = async () => {
  if (isInboundOperation.value && !restockSubmitted.value) {
    uni.showToast({
      title: "请先提交入柜登记",
      icon: "none"
    });
    return;
  }

  if ((needsPayment.value || needsAdjustmentPayment.value) && paymentUiState.value !== "paid") {
    const stayOnPayment = await new Promise<boolean>((resolve) => {
      uni.showModal({
        title: "支付还未完成",
        content: needsAdjustmentPayment.value
          ? "补扣订单仍未支付。继续支付可留在当前页面；稍后处理会返回首页，但本次补扣仍会保留为待支付。"
          : "本次结算仍未支付。继续支付可留在当前页面；稍后处理会返回首页，未支付不会扣款。",
        confirmText: "继续支付",
        cancelText: "稍后处理",
        success: ({ confirm }) => resolve(confirm),
        fail: () => resolve(true)
      });
    });

    if (stayOnPayment) {
      uni.pageScrollTo({
        selector: ".payment-box",
        duration: 260
      });
      return;
    }
  }

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

const notifyPendingAdjustmentIfNeeded = () => {
  const adjustment = pendingAdjustment.value;

  if (!adjustment || adjustmentPaymentNotified) {
    return;
  }

  adjustmentPaymentNotified = true;
  uni.showModal({
    title: "补扣待支付",
    content: `补扣订单 ${adjustment.orderNo} 金额为 ${formatCurrency(adjustment.amount)}。请在下方支付面板完成；暂不支付会保留为待处理。`,
    confirmText: "去支付",
    showCancel: false,
    success: () => {
      paymentUiState.value = "unpaid";
      uni.pageScrollTo({
        selector: ".payment-box",
        duration: 260
      });
    }
  });
};

const notifyRefundIfNeeded = () => {
  if (!event.value || !refundCompleted.value || refundNotified) {
    return;
  }

  refundNotified = true;
  uni.showModal({
    title: "退款已完成",
    content: "系统已收到退款结果，本次领取占用的免费额度已退回。可返回首页继续使用。",
    confirmText: "我知道了",
    showCancel: false,
    success: () => startCountdown()
  });
};

const confirmSettlementIfNeeded = (nextEvent: CabinetEventRecord) => {
  if (settlementConfirmationShown || needsPayment.value || needsAdjustmentPayment.value || refundCompleted.value) {
    return false;
  }

  if (nextEvent.status !== "settled" && nextEvent.status !== "refunded") {
    return false;
  }

  settlementConfirmationShown = true;
  const settledItems = nextEvent.goods?.length
    ? nextEvent.goods.map((item) => `${item.goodsName} x${item.quantity}`).join("、")
    : "无商品扣减";
  const amountText = nextEvent.amount > 0 ? formatCurrency(nextEvent.amount) : "无需支付";
  const comparisonText =
    nextEvent.settlementComparison && !nextEvent.settlementComparison.matched
      ? `\n差异：${nextEvent.settlementComparison.summary}`
      : "";

  uni.showModal({
    title: "确认本次结算",
    content: `平台结算：${settledItems}\n结算金额：${amountText}${comparisonText}\n确认后将返回首页。`,
    confirmText: "确认结算",
    showCancel: false,
    success: () => startCountdown()
  });

  return true;
};

const ensureTemplatesLoaded = async () => {
  if (templates.value.length || templatesLoading.value) {
    return;
  }

  templatesLoading.value = true;
  try {
    const response = await mobileApi.merchantTemplates();
    templates.value = response.filter((entry) => entry.status === "active");
    selectedTemplateId.value = selectedTemplate.value?.id ?? templates.value[0]?.id ?? "";
    restockQuantity.value = selectedTemplate.value?.defaultQuantity ?? templates.value[0]?.defaultQuantity ?? 0;
  } catch (error) {
    uni.showToast({
      title: getErrorMessage(error),
      icon: "none"
    });
  } finally {
    templatesLoading.value = false;
  }
};

const selectTemplate = (templateId: string) => {
  selectedTemplateId.value = templateId;
  restockQuantity.value = selectedTemplate.value?.defaultQuantity ?? restockQuantity.value;
};

const submitRestock = async () => {
  if (!event.value || !canSubmitRestock.value) {
    uni.showToast({
      title: "请补全入柜登记",
      icon: "none"
    });
    return;
  }

  const confirmed = await new Promise<boolean>((resolve) => {
    uni.showModal({
      title: "确认入柜登记",
      content: `请确认向 ${event.value?.deviceCode} 登记 ${selectedTemplate.value?.goodsName ?? "货品"} x${restockQuantity.value}，预计到期 ${estimatedExpireDate.value || "未设置"}。`,
      confirmText: "确认提交",
      success: ({ confirm }) => resolve(confirm),
      fail: () => resolve(false)
    });
  });

  if (!confirmed) {
    return;
  }

  restockSubmitting.value = true;
  try {
    await mobileApi.createMerchantRestock({
      templateId: selectedTemplateId.value,
      deviceCode: event.value.deviceCode,
      cabinetEventId: event.value.eventId,
      quantity: restockQuantity.value,
      productionDate: productionDate.value,
      note:
        [
          restockBatchNo.value ? `批次号：${restockBatchNo.value.trim()}` : "",
          restockNote.value.trim(),
          event.value.openReason
        ]
          .filter(Boolean)
          .join("；") || undefined,
      confirmed: true
    });
    restockSubmitted.value = true;
    statusText.value = "入柜登记完成";
    hintText.value = "补货批次已写入系统，可在补货记录或后台库存中继续追踪。";
    startCountdown();
  } catch (error) {
    uni.showToast({
      title: getErrorMessage(error),
      icon: "none"
    });
  } finally {
    restockSubmitting.value = false;
  }
};

const applyEvent = (nextEvent: CabinetEventRecord) => {
  event.value = nextEvent;
  const serverPaymentConfirmed = paymentConfirmationOrderNo
    ? paymentConfirmationOrderNo === nextEvent.orderNo
      ? nextEvent.paymentNotifyStatus === "success"
      : Boolean(
          nextEvent.adjustments?.some(
            (adjustment) =>
              adjustment.orderNo === paymentConfirmationOrderNo &&
              adjustment.paymentNotifyStatus === "success"
          )
        )
    : false;

  if (serverPaymentConfirmed && paymentConfirmationActive.value) {
    paymentConfirmationStartedAt = undefined;
    paymentConfirmationOrderNo = undefined;
    paymentUiState.value = "paid";
    paymentMessage.value = "服务端已确认付款成功。";
  }

  if (
    nextEvent.hasInboundGoods === true &&
    (nextEvent.role === "merchant" || nextEvent.role === "admin") &&
    (nextEvent.status === "closed" || nextEvent.status === "settled" || nextEvent.status === "refunded")
  ) {
    statusText.value = restockSubmitted.value ? "入柜登记完成" : "待提交入柜登记";
    hintText.value = restockSubmitted.value
      ? "补货批次已写入系统，可继续追踪补货记录。"
      : "柜门已关闭，请选择常用商品并登记本次入柜数量。";
    stopPolling();
    readyToReturn.value = restockSubmitted.value;
    void ensureTemplatesLoaded();

    if (restockSubmitted.value) {
      startCountdown();
    }

    return;
  }

  if (
    nextEvent.hasInboundGoods === false &&
    (nextEvent.role === "merchant" || nextEvent.role === "admin") &&
    (nextEvent.status === "settled" || nextEvent.status === "refunded")
  ) {
    statusText.value = "运营开门完成";
    hintText.value = "平台结算已回调，系统按实际移出商品自动扣减库存；本次不产生支付。";
    stopPolling();
    startCountdown();
    return;
  }

  if (nextEvent.status === "settled" || nextEvent.status === "refunded") {
    if (
      (needsPayment.value || needsAdjustmentPayment.value) &&
      (paymentUiState.value === "confirming" || paymentUiState.value === "confirmation_timeout")
    ) {
      const confirmationElapsed = paymentConfirmationStartedAt
        ? Date.now() - paymentConfirmationStartedAt
        : PAYMENT_CONFIRMATION_TIMEOUT_MS;

      if (confirmationElapsed >= PAYMENT_CONFIRMATION_TIMEOUT_MS) {
        paymentUiState.value = "confirmation_timeout";
        paymentMessage.value = "服务端确认等待超时，请刷新支付结果；未确认前不要重复支付。";
        statusText.value = "支付结果待确认";
        hintText.value = "客户端支付动作已结束，但服务端暂未返回最终状态。请手动刷新确认结果。";
        stopPolling();
      } else {
        paymentUiState.value = "confirming";
        statusText.value = "支付结果确认中";
        hintText.value = "客户端支付动作已结束，正在等待服务端确认，请勿重复支付。";
        startPolling();
      }

      readyToReturn.value = false;
      return;
    }

    statusText.value = needsAdjustmentPayment.value
      ? "补扣待支付"
      : refundCompleted.value
        ? "退款已完成"
        : adjustmentPaymentCompleted.value
          ? "补扣已支付"
          : settlementPaymentCompleted.value
            ? "支付已完成"
          : nextEvent.billingStatus === "mismatch"
            ? "领取待核对"
            : needsPayment.value
              ? "待支付"
              : isFreeSettlement.value
                ? "本次免费"
                : "结算完成";
    if (needsAdjustmentPayment.value) {
      hintText.value = "平台已产生补扣订单，请完成支付后再继续使用。";
      stopPolling();
      notifyPendingAdjustmentIfNeeded();
      readyToReturn.value = false;
      return;
    }

    if (needsPayment.value) {
      hintText.value = "实际拿取与选择一致，请按预结算金额完成本次支付。";
      stopPolling();
      readyToReturn.value = false;
      return;
    }

    if (refundCompleted.value) {
      hintText.value = "退款结果已同步，本次领取占用的免费额度已退回。";
      stopPolling();
      readyToReturn.value = false;
      notifyRefundIfNeeded();
      return;
    }

    hintText.value = adjustmentPaymentCompleted.value
      ? "补扣支付已完成，系统已同步柜机平台付款成功状态。"
      : settlementPaymentCompleted.value
        ? "支付已由服务端确认，系统已同步柜机平台付款成功状态。"
      : nextEvent.billingStatus === "mismatch"
        ? "平台已完成结算，但实际领取结果与所选商品存在差异。"
        : "平台已完成结算，本次在免费额度内，无需支付。";
    stopPolling();
    if (!confirmSettlementIfNeeded(nextEvent)) {
      notifyMismatchIfNeeded();
      startCountdown();
    }
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

const getPaymentAuthCode = async (provider: PaymentProvider) => {
  if (provider === "alipay") {
    const maybeMy = (globalThis as unknown as {
      my?: {
        getAuthCode: (options: {
          scopes?: string | string[];
          success: (result: { authCode?: string; code?: string }) => void;
          fail: (error: unknown) => void;
        }) => void;
      };
    }).my;

    if (maybeMy?.getAuthCode) {
      return new Promise<string | undefined>((resolve, reject) => {
        maybeMy.getAuthCode({
          scopes: "auth_base",
          success: (result) => resolve(result.authCode ?? result.code),
          fail: reject
        });
      });
    }
  }

  return new Promise<string | undefined>((resolve, reject) => {
    uni.login({
      provider: provider === "wechat" ? "weixin" : "alipay",
      success: (result) => resolve(typeof result.code === "string" ? result.code : undefined),
      fail: reject
    } as UniApp.LoginOptions);
  });
};

const resolvePaymentPayer = async (
  provider: PaymentProvider
): Promise<Partial<Pick<PaymentOrderCreatePayload, "payerIdentityHandle">>> => {
  let authCode: string | undefined;

  try {
    authCode = await getPaymentAuthCode(provider);
  } catch {
    return {};
  }

  const identity = await mobileApi.resolvePaymentPayer({
    provider,
    authCode
  });

  if (identity.simulated) {
    return {};
  }

  if (!identity.payerIdentityHandle) {
    throw new Error("付款身份授权结果无效，请重新发起支付。");
  }

  return { payerIdentityHandle: identity.payerIdentityHandle };
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

const readPaymentSimulationNotice = (payload: Record<string, unknown>) => {
  const rawReason =
    typeof payload.simulatedReason === "string" && payload.simulatedReason.trim()
      ? payload.simulatedReason.trim()
      : "";

  if (!rawReason) {
    return "当前为演示支付流程，不会真实扣款。";
  }

  if (
    rawReason.includes("缺少") ||
    rawReason.includes("未配置") ||
    rawReason.includes("未获取到") ||
    rawReason.includes("自检未通过")
  ) {
    return "当前环境暂未接入真实支付渠道，已切换为演示支付流程，不会真实扣款。";
  }

  return rawReason.length > 80 ? "当前为演示支付流程，不会真实扣款。" : rawReason;
};

const confirmSimulatedPayment = async (
  notice: string,
  amount: number,
  orderNo: string
) =>
  new Promise<SimulatedPaymentChoice>((resolve) => {
    uni.showModal({
      title: "模拟支付确认",
      content: `订单 ${orderNo}，金额 ${formatCurrency(amount)}。${notice}选择“模拟已支付”会回写付款成功，选择“暂不支付”会保留在待支付状态。`,
      confirmText: "模拟已支付",
      cancelText: "暂不支付",
      success: (result) => {
        resolve(result.confirm ? "paid" : "unpaid");
      },
      fail: () => resolve("unpaid")
    });
  });

const markSimulatedPaymentUnpaid = () => {
  paymentUiState.value = "unpaid";
  paymentMessage.value = "已保留为未支付状态，可继续支付或稍后处理。";
};

const simulatePaymentFailure = () => {
  paymentUiState.value = "failed";
  paymentMessage.value = "已模拟支付失败。请重新发起支付，失败状态不会产生扣款。";
};

const completeSimulatedPayment = async () => {
  if (!simulatedPayment.value || payingProvider.value || paymentConfirmationActive.value) {
    return;
  }

  payingProvider.value = simulatedPayment.value.provider;
  paymentUiState.value = "processing";
  paymentMessage.value = "正在提交模拟支付成功结果。";

  try {
    await mobileApi.mockPaymentPaid(simulatedPayment.value.id);
    markPaymentConfirmationPending(
      "模拟支付客户端流程已完成，正在等待服务端确认。",
      simulatedPayment.value.orderNo
    );
    await loadEvent();
  } catch (error) {
    paymentUiState.value = "failed";
    paymentMessage.value = getErrorMessage(error);
    uni.showToast({
      title: paymentMessage.value,
      icon: "none"
    });
  } finally {
    payingProvider.value = undefined;
  }
};

const paySettlement = async (provider: PaymentProvider) => {
  if (!event.value || payingProvider.value || paymentConfirmationActive.value) {
    return;
  }

  payingProvider.value = provider;
  paymentUiState.value = "creating";
  paymentMessage.value = `正在创建${providerLabel(provider)}订单。`;
  simulatedPayment.value = undefined;
  let financialRequestStarted = false;
  let clientPaymentInvoked = false;
  let paymentOrderNo = activePaymentOrderNo.value;

  try {
    const adjustment = pendingAdjustment.value;
    const amount = adjustment?.amount ?? event.value.amount;
    const orderNo = adjustment?.orderNo ?? event.value.orderNo;
    paymentOrderNo = orderNo;
    const payerIdentity = await resolvePaymentPayer(provider);
    financialRequestStarted = true;
    const payment = await mobileApi.createPaymentOrder({
      provider,
      phase: "post_settlement",
      eventId: event.value.eventId,
      orderNo: event.value.orderNo,
      adjustmentOrderNo: adjustment?.orderNo,
      deviceCode: event.value.deviceCode,
      amount,
      payerUserId: event.value.userId,
      subject: adjustment ? `柜机补扣支付 ${orderNo}` : `柜机结算支付 ${orderNo}`,
      ...payerIdentity
    });
    const launchAction = resolvePaymentLaunchAction(
      payment.order,
      payment.invokePayload
    );

    if (launchAction === "already_paid") {
      markPaymentConfirmationPending(
        "服务端支付单已确认付款，正在同步本次业务结果。",
        orderNo
      );
      await loadEvent();
      return;
    }

    if (launchAction === "unknown") {
      markPaymentOutcomeUnknown(
        `支付单 ${payment.order.paymentNo} 的渠道结果尚未确认。请先查询结果，不要重复支付。`,
        orderNo
      );
      return;
    }

    if (launchAction === "simulate") {
      const simulationNotice = readPaymentSimulationNotice(payment.invokePayload);
      simulatedPayment.value = {
        id: payment.order.id,
        provider,
        orderNo,
        amount,
        reason: simulationNotice
      };
      paymentUiState.value = "awaiting_simulation";
      paymentMessage.value = `已进入模拟支付流程：${simulationNotice}`;
      const choice = await confirmSimulatedPayment(simulationNotice, amount, orderNo);

      if (choice === "unpaid") {
        markSimulatedPaymentUnpaid();
        return;
      }

      paymentUiState.value = "processing";
      paymentMessage.value = "正在提交模拟支付成功结果。";
      await mobileApi.mockPaymentPaid(payment.order.id);
      markPaymentConfirmationPending("模拟支付客户端流程已完成，正在等待服务端确认。", orderNo);
    } else {
      paymentUiState.value = "processing";
      clientPaymentInvoked = true;
      await invokeClientPayment(provider, payment.invokePayload);
      markPaymentConfirmationPending("支付客户端流程已完成，正在等待服务端确认。", orderNo);
    }

    await loadEvent();
  } catch (error) {
    if (
      clientPaymentInvoked &&
      classifyClientPaymentError(error) === "cancelled"
    ) {
      paymentUiState.value = "unpaid";
      paymentMessage.value = "你已取消支付，订单仍保持待支付状态。";
    } else if (
      clientPaymentInvoked ||
      (financialRequestStarted && isPaymentRequestOutcomeUncertain(error))
    ) {
      markPaymentOutcomeUnknown(
        "支付请求已经发出，但暂未取得最终结果。请先重新确认，未确认前不要再次支付。",
        paymentOrderNo
      );
    } else {
      paymentUiState.value = "failed";
      paymentMessage.value = getErrorMessage(error);
    }
    if (!paymentConfirmationActive.value) {
      uni.showToast({
        title: paymentMessage.value,
        icon: "none"
      });
    }
  } finally {
    payingProvider.value = undefined;
  }
};

const retryPaymentConfirmation = async () => {
  if (payingProvider.value || paymentUiState.value === "confirming") {
    return;
  }

  paymentConfirmationStartedAt = Date.now();
  paymentUiState.value = "confirming";
  const pendingPaymentOrderId = pendingPaymentReconciliationOrderId.value;
  paymentMessage.value = pendingPaymentOrderId
    ? "正在请求后台安全核对，随后刷新服务端状态。"
    : "正在刷新服务端支付状态。";
  startPolling();

  try {
    if (pendingPaymentOrderId) {
      await mobileApi.requestPaymentOrderReconciliation(pendingPaymentOrderId);
      paymentMessage.value = "已请求后台安全核对，正在刷新服务端状态。";
    }
    await loadEvent();
  } catch (error) {
    stopPolling();
    paymentUiState.value = "confirmation_timeout";
    paymentMessage.value = `后台安全核对请求暂未送达：${appendErrorContext(
      getErrorMessage(error),
      "请稍后重试；系统不会再次支付。"
    )}`;
    statusText.value = "支付结果待确认";
    hintText.value = "后台会在请求成功后核对原支付单；未确认前不会再次支付。";
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
    if (paymentUiState.value === "confirming") {
      paymentUiState.value = "confirmation_timeout";
      paymentMessage.value = `支付结果查询失败：${appendErrorContext(
        getErrorMessage(error),
        "请稍后重新确认，勿重复支付。"
      )}`;
      statusText.value = "支付结果待确认";
      hintText.value = "暂时无法连接服务端确认支付状态，可稍后手动刷新结果。";
      return;
    }

    uni.reLaunch({
      url: `/pages/common/result?status=danger&title=${encodeURIComponent("结算状态获取失败")}&detail=${encodeURIComponent(getErrorMessage(error))}`
    });
  }
};

onLoad((query) => {
  eventId.value = typeof query.eventId === "string" ? query.eventId : "";
  void loadEvent();
  startPolling();
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
        <FlowSteps :steps="flowSteps" />

        <view class="status-box">
          <text class="status-box__label">{{ isOperationalEvent ? "本次开门类型" : "本次计划领取" }}</text>
          <text class="status-box__value">{{ intendedSummary }}</text>
        </view>
        <view class="status-box">
          <text class="status-box__label">{{ isInboundOperation ? "入柜登记状态" : "平台实际结算" }}</text>
          <text class="status-box__value">{{ settledSummary }}</text>
        </view>
        <view v-if="isNoInboundOperation" class="free-box">
          <text class="free-box__title">无需支付</text>
          <text class="free-box__body">开门理由：{{ event?.openReason ?? "未填写" }}。本次仅记录库存变化，不向用户收费。</text>
        </view>
        <view v-if="isInboundOperation" class="restock-box">
          <view class="billing-box__head">
            <text class="billing-box__title">入柜商品登记</text>
            <text class="billing-box__amount">{{ restockSubmitted ? "已提交" : "待提交" }}</text>
          </view>

          <EmptyState
            v-if="templatesLoading"
            title="正在加载常用商品"
            description="请稍候，系统正在读取可登记的常用商品。"
          />
          <EmptyState
            v-else-if="!templates.length"
            title="暂无可用常用商品"
            description="请先维护常用商品，再回到本页提交登记。"
          />
          <template v-else-if="!restockSubmitted">
            <view class="vm-field">
              <text class="vm-field__label">常用商品</text>
              <picker
                aria-label="选择入柜常用商品"
                :range="templates"
                range-key="goodsName"
                :value="Math.max(templates.findIndex((item) => item.id === selectedTemplateId), 0)"
                @change="selectTemplate(templates[$event.detail.value]?.id ?? '')"
              >
                <view class="vm-field__input picker-value">
                  {{ selectedTemplate?.goodsName ?? "请选择常用商品" }}
                </view>
              </picker>
            </view>
            <view class="restock-grid">
              <view class="vm-field">
                <text class="vm-field__label">入柜数量</text>
                <input v-model.number="restockQuantity" aria-label="入柜数量" class="vm-field__input" type="number" placeholder="件数" />
              </view>
              <view class="vm-field">
                <text class="vm-field__label">生产日期</text>
                <picker aria-label="选择生产日期" mode="date" :value="productionDate" @change="productionDate = $event.detail.value">
                  <view class="vm-field__input picker-value">{{ productionDate || "请选择" }}</view>
                </picker>
              </view>
            </view>
            <view class="vm-field">
              <text class="vm-field__label">批次号（选填）</text>
              <input v-model="restockBatchNo" aria-label="入柜批次号" class="vm-field__input" placeholder="例如：20240519001" />
            </view>
            <view class="vm-field">
              <text class="vm-field__label">备注（选填）</text>
              <input v-model="restockNote" aria-label="入柜备注" class="vm-field__input" placeholder="例如：上午批次、临期补投" />
            </view>
            <view class="summary-panel">
              <text class="summary-panel__title">提交前确认</text>
              <text class="summary-panel__body">货品：{{ selectedTemplate?.goodsName ?? "未选择" }}</text>
              <text class="summary-panel__body">数量：{{ restockQuantity || 0 }} 件</text>
              <text class="summary-panel__body">批次号：{{ restockBatchNo || "系统生成" }}</text>
              <text class="summary-panel__body">预计到期：{{ estimatedExpireDate || "等待计算" }}</text>
            </view>
            <button class="vm-button" :disabled="!canSubmitRestock" :loading="restockSubmitting" @tap="submitRestock">
              提交入柜登记
            </button>
          </template>
          <view v-else class="summary-panel">
            <text class="summary-panel__title">登记已完成</text>
            <text class="summary-panel__body">本次入柜批次已写入库存，可返回首页继续处理。</text>
          </view>
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
        <view v-if="needsPayment || needsAdjustmentPayment" class="payment-box">
          <text class="payment-box__title">{{ needsAdjustmentPayment ? "补扣待支付金额" : "预结算待支付金额" }}</text>
          <text class="payment-box__amount">{{ formatCurrency(activePaymentAmount) }}</text>
          <text class="payment-box__body">
            订单 {{ activePaymentOrderNo }} 支付成功后，系统会自动回写柜机平台的付款成功状态。
          </text>
          <view class="payment-state" :class="`payment-state--${paymentStateMeta.tone}`">
            <text class="payment-state__title">{{ paymentStateMeta.title }}</text>
            <text class="payment-state__body">{{ paymentStateMeta.body }}</text>
          </view>
          <text class="payment-box__body">{{ paymentActionHint }}</text>
          <button
            class="vm-button"
            :disabled="Boolean(payingProvider) || paymentConfirmationActive"
            :loading="payingProvider === 'wechat'"
            @tap="paySettlement('wechat')"
          >
            微信支付
          </button>
          <button
            class="vm-button vm-button--ghost"
            :disabled="Boolean(payingProvider) || paymentConfirmationActive"
            :loading="payingProvider === 'alipay'"
            @tap="paySettlement('alipay')"
          >
            支付宝支付
          </button>
          <button
            v-if="paymentConfirmationActive"
            class="vm-button vm-button--soft"
            :disabled="paymentUiState === 'confirming'"
            :loading="paymentUiState === 'confirming'"
            @tap="retryPaymentConfirmation"
          >
            {{ paymentRecoveryActionLabel }}
          </button>
          <view
            v-if="simulatedPayment && ['awaiting_simulation', 'unpaid', 'failed'].includes(paymentUiState)"
            class="payment-simulate-actions"
          >
            <button class="vm-button vm-button--soft" :loading="Boolean(payingProvider)" @tap="completeSimulatedPayment">
              模拟已支付
            </button>
            <button class="vm-button vm-button--ghost" :disabled="Boolean(payingProvider)" @tap="markSimulatedPaymentUnpaid">
              暂不支付
            </button>
            <button class="vm-button vm-button--ghost" :disabled="Boolean(payingProvider)" @tap="simulatePaymentFailure">
              模拟失败
            </button>
          </view>
          <text v-if="paymentMessage && !paymentConfirmationActive" class="payment-box__body">{{ paymentMessage }}</text>
        </view>
        <text class="vm-subtitle">
          {{ returnHintText }}
        </text>
        <button class="vm-button" @tap="goHome">{{ returnButtonText }}</button>
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
.payment-box__title,
.summary-panel__title {
  font-size: 22rpx;
  color: var(--vm-text-soft);
}

.status-box__value,
.billing-row__name,
.billing-row__meta,
.free-box__body,
.warning-box__body,
.payment-box__body,
.summary-panel__body {
  font-size: 28rpx;
  color: var(--vm-text);
  line-height: 1.5;
}

.payment-box__amount {
  font-size: 40rpx;
  font-weight: 800;
  color: var(--vm-text);
}

.payment-state {
  display: grid;
  gap: 8rpx;
  padding: 18rpx 20rpx;
  border-radius: 20rpx;
  border: 1rpx solid var(--vm-line);
  background: rgba(255, 255, 255, 0.9);
}

.payment-state--info {
  border-color: var(--vm-info-line);
  background: var(--vm-info-bg);
}

.payment-state--warning {
  border-color: var(--vm-warning-line);
  background: var(--vm-warning-bg);
}

.payment-state--danger {
  border-color: var(--vm-danger-line);
  background: var(--vm-danger-bg);
}

.payment-state--success {
  border-color: var(--vm-success-line);
  background: var(--vm-success-bg);
}

.payment-state__title {
  font-size: 26rpx;
  font-weight: 800;
  color: var(--vm-text);
}

.payment-state__body {
  font-size: 24rpx;
  line-height: 1.5;
  color: var(--vm-text-soft);
}

.payment-simulate-actions {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 10rpx;
}

.payment-simulate-actions .vm-button {
  min-height: 78rpx;
  padding: 0 10rpx;
  font-size: 24rpx;
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

.restock-box {
  display: grid;
  gap: 18rpx;
  padding: 6rpx 0 0;
  border-top: 1rpx solid var(--vm-warning-line);
}

.restock-grid {
  display: grid;
  gap: 16rpx;
}

.picker-value {
  display: flex;
  align-items: center;
}

.summary-panel {
  display: grid;
  gap: 8rpx;
  padding: 4rpx 0 4rpx 20rpx;
  border-left: 4rpx solid var(--vm-accent);
}

.warning-box {
  background: rgba(255, 245, 232, 0.88);
  border-color: rgba(207, 120, 43, 0.18);
}

@media screen and (min-width: 720px) {
  .restock-grid {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }
}
</style>

