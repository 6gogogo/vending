<script setup lang="ts">
import { computed, ref } from "vue";
import { onLoad, onUnload } from "@dcloudio/uni-app";

import type {
  CabinetEventRecord,
  MerchantGoodsTemplate
} from "@vm/shared-types";

import { mobileApi } from "../../api/mobile";
import EmptyState from "../../components/ui/EmptyState.vue";
import FlowSteps from "../../components/ui/FlowSteps.vue";
import GlassCard from "../../components/ui/GlassCard.vue";
import MobileShell from "../../layouts/MobileShell.vue";
import { appCopy } from "../../constants/copy";
import { useSessionStore } from "../../stores/session";
import { formatBeijingDate } from "../../utils/datetime";
import { getErrorMessage } from "../../utils/error-message";
import { resolveHomePath, syncRoleTabBar } from "../../utils/role-routing";

const sessionStore = useSessionStore();
const eventId = ref("");
const event = ref<CabinetEventRecord>();
const statusText = ref("结算，请稍后");
const hintText = ref("柜门已关闭，正在等待平台返回本次实际拿取结果。");
const countdown = ref(5);
const readyToReturn = ref(false);
const templates = ref<MerchantGoodsTemplate[]>([]);
const templatesLoading = ref(false);
const restockSubmitting = ref(false);
const restockSubmitted = ref(false);
const selectedTemplateId = ref("");
const restockQuantity = ref(0);
const productionDate = ref(formatBeijingDate(new Date()));
const restockBatchNo = ref("");
const restockNote = ref("");

let pollTimer: ReturnType<typeof setInterval> | undefined;
let countdownTimer: ReturnType<typeof setInterval> | undefined;
let pollAttempts = 0;
let mismatchNotified = false;
let settlementConfirmationShown = false;
let refundNotified = false;

const isOperationalEvent = computed(
  () => event.value?.role === "merchant" || event.value?.role === "admin"
);
const isInboundOperation = computed(
  () => isOperationalEvent.value && event.value?.hasInboundGoods === true
);
const isNoInboundOperation = computed(
  () => isOperationalEvent.value && event.value?.hasInboundGoods === false
);
const isReservationOnlyPickupResult = computed(
  () =>
    event.value?.reservationOnlyPickup === true &&
    (event.value?.amount ?? 0) <= 0 &&
    (event.value?.billingStatus === "free" || event.value?.billingStatus === "mismatch")
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
const preSettlementItems = computed(() =>
  isReservationOnlyPickupResult.value ? [] : event.value?.preSettlement?.items ?? []
);
const settlementMatched = computed(() =>
  !event.value?.settlementComparison || event.value.settlementComparison.matched
);
const isCurrentFreePickup = computed(
  () =>
    event.value?.role === "special" &&
    (
      event.value.reservationOnlyPickup === true ||
      event.value.preSettlement?.chargeRequired === false
    )
);
const hasUnexpectedCharge = computed(
  () =>
    event.value?.role === "special" &&
    (
      (
        event.value.status !== "refunded" &&
        event.value.paymentNotifyStatus !== "success" &&
        (event.value.amount ?? 0) > 0
      ) ||
      event.value.adjustments?.some(
        (adjustment) =>
          adjustment.amount > 0 &&
          adjustment.paymentNotifyStatus !== "success" &&
          !adjustment.refundedAt
      ) === true
    )
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
    !hasUnexpectedCharge.value
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

  if (hasUnexpectedCharge.value) {
    return appCopy.freeOnly.unexpectedChargeHint;
  }

  return readyToReturn.value ? `页面将在 ${countdown.value} 秒后自动返回首页。` : "结算结果确认后会自动返回首页。";
});
const returnButtonText = computed(() =>
  isInboundOperation.value && !restockSubmitted.value
    ? "提交登记后返回"
    : "立即返回首页"
);
const flowSteps = computed(() => {
  const settlementDone =
    restockSubmitted.value ||
    isFreeSettlement.value ||
    event.value?.status === "refunded" ||
    event.value?.paymentNotifyStatus === "success";
  const settlementWarning =
    hasUnexpectedCharge.value ||
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
      label: isInboundOperation.value
        ? "登记批次"
        : isReservationOnlyPickupResult.value
          ? "领取核对"
          : "完成结算",
      description: settlementDone ? "已完成" : settlementWarning ? "请按提示处理" : "正在核对结果",
      state: settlementDone ? ("done" as const) : settlementWarning ? ("warning" as const) : ("current" as const)
    }
  ];
});

const formatSettlementBreakdown = (item: {
  freeQuantity: number;
  paidQuantity: number;
}) =>
  `${item.freeQuantity} 件可领取${
    item.paidQuantity > 0 ? ` · ${item.paidQuantity} 件超出可领取范围` : ""
  }`;

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

const goFeedback = () => {
  const query = [
    event.value?.phone ? `phone=${encodeURIComponent(event.value.phone)}` : "",
    event.value?.deviceCode
      ? `deviceCode=${encodeURIComponent(event.value.deviceCode)}`
      : ""
  ].filter(Boolean);
  uni.navigateTo({
    url: `/pages/common/feedback${query.length ? `?${query.join("&")}` : ""}`
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
  if (settlementConfirmationShown || hasUnexpectedCharge.value || refundCompleted.value) {
    return false;
  }

  if (nextEvent.status !== "settled" && nextEvent.status !== "refunded") {
    return false;
  }

  settlementConfirmationShown = true;
  const settledItems = nextEvent.goods?.length
    ? nextEvent.goods.map((item) => `${item.goodsName} x${item.quantity}`).join("、")
    : "无商品扣减";
  const isReservationPickup =
    nextEvent.reservationOnlyPickup === true &&
    nextEvent.amount <= 0 &&
    nextEvent.billingStatus === "free";
  const amountText =
    nextEvent.role === "special" && nextEvent.paymentNotifyStatus === "success"
      ? appCopy.freeOnly.historicalResolvedLabel
      : appCopy.freeOnly.amountLabel;
  const comparisonText =
    nextEvent.settlementComparison && !nextEvent.settlementComparison.matched
      ? `\n差异：${nextEvent.settlementComparison.summary}`
      : "";

  uni.showModal({
    title: isReservationPickup ? appCopy.reservationPickup.completionTitle : "确认本次结算",
    content: isReservationPickup
      ? appCopy.reservationPickup.completionContent(settledItems, comparisonText)
      : `平台结算：${settledItems}\n结算金额：${amountText}${comparisonText}\n确认后将返回首页。`,
    confirmText: isReservationPickup ? appCopy.reservationPickup.completionAction : "确认结算",
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
    hintText.value = "平台结算已回调，系统按实际移出商品自动扣减库存；本次不向用户收费。";
    stopPolling();
    startCountdown();
    return;
  }

  if (nextEvent.status === "settled" || nextEvent.status === "refunded") {
    if (hasUnexpectedCharge.value) {
      statusText.value = appCopy.freeOnly.unexpectedChargeTitle;
      hintText.value = appCopy.freeOnly.unexpectedChargeHint;
      readyToReturn.value = true;
      stopPolling();
      return;
    }

    if (isReservationOnlyPickupResult.value) {
      statusText.value =
        nextEvent.billingStatus === "mismatch"
          ? appCopy.reservationPickup.mismatchStatus
          : appCopy.reservationPickup.completedStatus;
      hintText.value =
        nextEvent.billingStatus === "mismatch"
          ? appCopy.reservationPickup.mismatchHint
          : appCopy.reservationPickup.completedHint;
      stopPolling();

      if (nextEvent.billingStatus === "mismatch") {
        notifyMismatchIfNeeded();
        startCountdown();
      } else {
        confirmSettlementIfNeeded(nextEvent);
      }
      return;
    }

    if (refundCompleted.value) {
      statusText.value = "退款已完成";
      hintText.value = "退款结果已同步，本次领取占用的免费额度已退回。";
      stopPolling();
      readyToReturn.value = false;
      notifyRefundIfNeeded();
      return;
    }

    statusText.value =
      nextEvent.billingStatus === "mismatch"
        ? "领取待核对"
        : isCurrentFreePickup.value || isFreeSettlement.value
          ? "本次免费"
          : "结算完成";
    hintText.value =
      nextEvent.billingStatus === "mismatch"
        ? "平台已完成结算，但实际领取结果与所选商品存在差异。"
        : appCopy.freeOnly.completedHint;
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
        <view v-if="isReservationOnlyPickupResult" class="free-box">
          <text class="free-box__title">{{ appCopy.reservationPickup.resultTitle }}</text>
          <text class="free-box__body">
            {{ event?.billingStatus === "mismatch" ? appCopy.reservationPickup.mismatchHint : appCopy.reservationPickup.completedHint }}
          </text>
        </view>
        <view v-if="preSettlementItems.length" class="billing-box">
          <view class="billing-box__head">
            <text class="billing-box__title">预结算明细</text>
            <text class="billing-box__amount">
              {{ event?.preSettlement?.chargeRequired ? "超出可领取范围" : "全部免费" }}
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
          <text class="free-box__body">{{ appCopy.freeOnly.completedHint }}</text>
        </view>
        <view v-if="hasUnexpectedCharge" class="warning-box">
          <text class="warning-box__title">{{ appCopy.freeOnly.unexpectedChargeTitle }}</text>
          <text class="warning-box__body">{{ appCopy.freeOnly.unexpectedChargeBody }}</text>
          <button class="vm-button vm-button--ghost" @tap="goFeedback">
            {{ appCopy.freeOnly.feedbackAction }}
          </button>
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
.warning-box {
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
.summary-panel__title {
  font-size: 22rpx;
  color: var(--vm-text-soft);
}

.status-box__value,
.billing-row__name,
.billing-row__meta,
.free-box__body,
.warning-box__body,
.summary-panel__body {
  font-size: 28rpx;
  color: var(--vm-text);
  line-height: 1.5;
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

