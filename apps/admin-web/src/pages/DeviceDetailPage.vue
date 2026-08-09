<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from "vue";
import { RouterLink, useRoute } from "vue-router";
import { ApiError } from "@vm/shared-client";
import type { DeviceRecord } from "@vm/shared-types";

import { adminApi } from "../api/admin";
import AmapLocationPicker from "../components/AmapLocationPicker.vue";
import { useAdminSessionStore } from "../stores/session";
import { formatDate, formatDateTime, formatDateTimeSeconds, formatNowInBeijing } from "../utils/datetime";
import { getAdminErrorMessage as readErrorMessage } from "../utils/error-message";
import {
  canManuallyConfirmPayment,
  classifyRefundOutcome,
  isFinancialActionOutcomeUncertain,
  validateLegacyFullRefundAmount
} from "../utils/financial-action-safety";
import { categoryLabelMap } from "../utils/labels";
import {
  buildAlertContextSummary,
  buildAlertIdentitySummary,
  buildAlertReferenceSummary,
  buildLogContextSummary,
  buildLogReferenceSummary,
  buildLogSubjectSummary,
  formatActorTypeLabel,
  formatLogCategoryLabel
} from "../utils/business-context";

const route = useRoute();
const sessionStore = useAdminSessionStore();
const canOperateDevice = computed(() => sessionStore.can("devices:operate"));
const canRecoverManualSettlement = computed(
  () =>
    sessionStore.isAdmin &&
    canOperateDevice.value &&
    sessionStore.can("goods:stock-adjust")
);
const canManageDevice = computed(() => sessionStore.can("devices:manage"));
const canManageGoods = computed(() => sessionStore.can("goods:manage"));
const canManageAlerts = computed(() => sessionStore.can("alerts:manage"));
const canRefundPayments = computed(() => sessionStore.can("payments:refund"));
const canViewCallbackLogs = computed(() => sessionStore.can("operation-logs:view"));
const canViewSystemAudit = computed(() => sessionStore.can("system-audit:view"));
const canViewDebugPanel = computed(
  () => canViewCallbackLogs.value || canViewSystemAudit.value
);
const canManualPaymentSuccess = computed(() =>
  canManuallyConfirmPayment(canOperateDevice.value, canRefundPayments.value)
);

type DeviceDetailResponse = Awaited<ReturnType<typeof adminApi.deviceDetail>>;
type DeviceRecentEvent = DeviceDetailResponse["recentEvents"][number];
type FinancialActionKind = "payment" | "refund";
type FinancialActionStep = "input" | "confirm";

interface FinancialActionDraft {
  kind: FinancialActionKind;
  step: FinancialActionStep;
  event: DeviceRecentEvent;
  adjustmentOrderNo?: string;
  orderNo: string;
  label: string;
  targetUrl?: string;
  expectedAmount?: number;
  transactionId: string;
  refundNo: string;
  refundRecordId?: string;
  amountInput: string;
}

const detail = ref<Awaited<ReturnType<typeof adminApi.deviceDetail>>>();
const loading = ref(false);
const refreshing = ref(false);
const confirmingDoorClosed = ref(false);
const doorClosedDialog = ref<HTMLDialogElement>();
const doorClosedSafeButton = ref<HTMLButtonElement>();
const doorClosedSubmitError = ref("");
const syncing = ref(false);
const remoteOpening = ref(false);
const remoteOpenDialogStep = ref<"reason" | "confirm">();
const remoteOpenReason = ref("");
const remoteOpenDialog = ref<HTMLDialogElement>();
const remoteOpenReasonInput = ref<HTMLTextAreaElement>();
const remoteOpenSafeButton = ref<HTMLButtonElement>();
const remoteOpenSubmitError = ref("");
const remoteOpenOutcomePending = ref(false);
const financialAction = ref<FinancialActionDraft>();
const financialDialog = ref<HTMLDialogElement>();
const financialPrimaryInput = ref<HTMLInputElement>();
const financialAmountInput = ref<HTMLInputElement>();
const financialSafeButton = ref<HTMLButtonElement>();
const financialSubmitError = ref("");
const financialOutcomePending = ref<Array<{
  kind: FinancialActionKind;
  orderNo: string;
}>>([]);
const resolvingTaskId = ref("");
const selectedDoorNum = ref("1");
const lastUpdatedAt = ref("");
const mapPickerVisible = ref(false);
const updatingLocation = ref(false);
const goodsCatalog = ref<Awaited<ReturnType<typeof adminApi.goodsCatalog>>>([]);
const addingGoods = ref(false);
const removingGoodsId = ref("");
const selectedGoodsToAdd = ref("");
const debugPanelVisible = ref(false);
const debugLoading = ref(false);
const debugLoaded = ref(false);
const debugAuditLimit = ref(100);
const debugCallbackLimit = ref(100);
const debugCallbackLogs = ref<Awaited<ReturnType<typeof adminApi.deviceCallbackLogs>>>([]);
const debugSystemAuditLogs = ref<Awaited<ReturnType<typeof adminApi.systemAuditLogs>>>([]);
const notifyingPaymentOrderNo = ref("");
const completingZeroCostEventId = ref("");
const refundingOrderNo = ref("");
const reconcilingRefundId = ref("");
const loadError = ref("");
const actionMessage = ref<{ type: "success" | "error"; text: string }>();

let timer: ReturnType<typeof setInterval> | undefined;
let visibilityHandler: (() => void) | undefined;
let remoteOpenPreviousFocus: HTMLElement | undefined;
let financialPreviousFocus: HTMLElement | undefined;
let doorClosedPreviousFocus: HTMLElement | undefined;

const createCompactReference = (prefix: string) =>
  `${prefix}-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
const isRemoteOpenOutcomePendingError = (error: unknown, message: string) => {
  if (/柜机平台开柜失败/.test(message)) {
    return false;
  }

  return (
    /结果待确认|请勿重复|请求超时|设备回调已确认|指令在途|重复下发|failed to fetch|fetch failed|network error|网络/i.test(message)
    || (error instanceof ApiError && (error.status === 408 || error.status === 409 || error.status >= 500))
    || !(error instanceof ApiError)
  );
};
const showActionMessage = (type: "success" | "error", text: string) => {
  actionMessage.value = { type, text };
};

const financialReferencePattern = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const findPersistedPendingRefund = (orderNo: string) => {
  for (const event of detail.value?.recentEvents ?? []) {
    if (event.orderNo === orderNo) {
      return event.paymentRecovery?.pendingRefund;
    }
    const adjustment = event.adjustments?.find(
      (entry) => entry.orderNo === orderNo
    );
    if (adjustment) {
      return adjustment.paymentRecovery?.pendingRefund;
    }
  }
  return undefined;
};
const financialAmount = computed(() => {
  const value = financialAction.value?.amountInput.trim() ?? "";
  return /^\d+$/.test(value) ? Number(value) : Number.NaN;
});
const isFinancialOutcomePending = (
  kind: FinancialActionKind,
  orderNo: string
) =>
  financialOutcomePending.value.some(
    (entry) => entry.kind === kind && entry.orderNo === orderNo
  ) ||
  (
    kind === "refund" &&
    Boolean(findPersistedPendingRefund(orderNo))
  );
const isCurrentFinancialOutcomePending = computed(() =>
  financialAction.value
    ? isFinancialOutcomePending(
        financialAction.value.kind,
        financialAction.value.orderNo
      )
    : false
);
const financialInputError = computed(() => {
  const draft = financialAction.value;
  if (!draft) {
    return "";
  }

  const transactionId = draft.transactionId.trim();
  if (!financialReferencePattern.test(transactionId)) {
    return "交易号需为 1–128 位，仅可包含字母、数字、点、下划线、冒号或短横线。";
  }

  if (draft.kind === "refund" && !financialReferencePattern.test(draft.refundNo.trim())) {
    return "操作请求编号需为 1–128 位，仅可包含字母、数字、点、下划线、冒号或短横线。";
  }

  const amount = financialAmount.value;
  if (!Number.isSafeInteger(amount)) {
    return "金额必须是安全范围内的整数，单位为分。";
  }

  if (draft.kind === "payment") {
    if (amount < 0) {
      return "支付金额不能为负数。";
    }
    if (draft.expectedAmount !== undefined && amount !== draft.expectedAmount) {
      return `支付金额必须与订单金额一致：${draft.expectedAmount} 分。`;
    }
  } else {
    if (amount <= 0) {
      return "退款金额必须大于 0 分。";
    }
    const fullRefundError = validateLegacyFullRefundAmount(
      amount,
      draft.expectedAmount
    );
    if (fullRefundError) {
      return fullRefundError;
    }
  }

  return "";
});

const selectedDoorGoods = computed(() => {
  const device = detail.value?.device;

  if (!device) {
    return [];
  }

  if (!selectedDoorNum.value) {
    return device.doors.flatMap((door) => door.goods);
  }

  return device.doors.find((door) => door.doorNum === selectedDoorNum.value)?.goods ?? [];
});
const pendingTasks = computed(() => detail.value?.pendingTasks ?? []);
const manualSettlementTaskEventIds = computed(
  () =>
    new Set(
      pendingTasks.value
        .filter(
          (task) =>
            task.title === "结算回调超时待补记" &&
            task.status !== "resolved" &&
            Boolean(task.relatedEventId)
        )
        .map((task) => task.relatedEventId as string)
    )
);
const recentEvents = computed(() => detail.value?.recentEvents ?? []);
const recentLogs = computed(() => detail.value?.recentLogs ?? []);
const businessDayServedUsers = computed(() => detail.value?.businessDayServedUsers ?? []);
const servedUserNameMap = computed(
  () => new Map(businessDayServedUsers.value.map((item) => [item.userId, item.userName]))
);
const stockChangeMap = computed(
  () => new Map((detail.value?.stockChanges ?? []).map((item) => [item.goodsId, item]))
);
const addableGoodsOptions = computed(() => {
  const existingGoodsIds = new Set(selectedDoorGoods.value.map((item) => item.goodsId));

  return goodsCatalog.value.filter(
    (item) => item.status !== "inactive" && !existingGoodsIds.has(item.goodsId)
  );
});
const debugSystemAuditRows = computed(() =>
  debugSystemAuditLogs.value.filter(
    (entry) =>
      entry.path.includes("/external/smartvm") ||
      entry.path.includes("/api/cabinet-events/payment-success") ||
      entry.path.includes("/api/inventory-orders/refund") ||
      entry.path.includes("/api/cabinet-events/callbacks") ||
      entry.path.includes("/api/inventory-orders/callbacks/refund")
  )
);

const getDeviceStatusPresentation = (device?: DeviceRecord) => {
  if (!device) {
    return { label: "状态加载中", tone: "warning", hint: "请等待柜机状态加载完成。" } as const;
  }

  if (device.readiness?.blocker === "maintenance" || device.status === "maintenance") {
    return {
      label: "维护中",
      tone: "warning",
      hint: "柜机处于维护状态，解除维护前不能远程开门。"
    } as const;
  }

  if (device.readiness?.blocker === "door_open") {
    return {
      label: "柜门未关闭",
      tone: "danger",
      hint: "柜门仍处于开启状态；请先在现场关闭柜门并等待回调，或由管理员现场确认已关闭。"
    } as const;
  }

  if (device.readiness?.blocker === "door_unconfirmed") {
    return {
      label: "门状态待确认",
      tone: "warning",
      hint: "上一条开门操作结果仍未知；收到可信关门回调或管理员现场确认前，不会再次下发。"
    } as const;
  }

  if (device.readiness?.blocker === "stale") {
    return {
      label: "状态已过期",
      tone: "warning",
      hint: "最近一次平台确认已超过有效时限，请先刷新；刷新成功前不能远程开门。"
    } as const;
  }

  if (
    device.readiness?.blocker === "offline" ||
    (!device.readiness && device.status === "offline")
  ) {
    return {
      label: "离线",
      tone: "danger",
      hint: "尚未取得可用的平台确认，请先排查连接并刷新状态。"
    } as const;
  }

  if (
    device.readiness?.platformRecognition === "confirmed" &&
    device.readiness.connectivity !== "online"
  ) {
    return {
      label: "平台已识别",
      tone: "warning",
      hint: "平台已确认凭据与设备编号，但这不等同于物理在线；开门结果仍以设备回调为准。"
    } as const;
  }

  return { label: "在线", tone: "success", hint: "最近收到可信设备回调，可继续操作。" } as const;
};

const deviceCanOpen = computed(() => {
  const device = detail.value?.device;
  if (!device) {
    return false;
  }

  return device.readiness?.canOpen ?? device.status === "online";
});
const doorNeedsPhysicalConfirmation = computed(() => {
  const deviceDetail = detail.value;

  return Boolean(
    deviceDetail &&
    canOperateDevice.value &&
    (deviceDetail.device.readiness?.blocker === "door_unconfirmed" ||
      deviceDetail.runtime.doorState !== "closed")
  );
});
const remoteOpenBlockedHint = computed(() => {
  if (!detail.value?.device) {
    return "柜机详情尚未加载，请先刷新页面。";
  }

  if (!deviceCanOpen.value) {
    return getDeviceStatusPresentation(detail.value.device).hint;
  }

  if (detail.value.runtime.doorState === "open") {
    return "柜门当前已开启，请确认现场并等待关门后再操作。";
  }

  return "";
});
const remoteOpenDisabled = computed(() =>
  remoteOpening.value || Boolean(remoteOpenBlockedHint.value)
);
const remoteOpenDeviceSummary = computed(() => {
  const device = detail.value?.device;
  const deviceCode = device?.deviceCode ?? String(route.params.deviceCode);
  const deviceName = device?.name.trim() || "未知柜机";

  return deviceCode && !deviceName.includes(deviceCode)
    ? `${deviceName}（编号 ${deviceCode}）`
    : deviceName;
});

const formatDoorState = (state?: "open" | "closed" | "unknown") =>
  state === "open" ? "门已开" : state === "closed" ? "门已关" : "门状态未知";

const formatEventStatus = (status: string) => {
  if (status === "created") return "已创建";
  if (status === "opening") return "开门中";
  if (status === "opened") return "门已开";
  if (status === "closed") return "门已关";
  if (status === "settled") return "已结算";
  if (status === "failed") return "失败";
  if (status === "timeout_unopened") return "超时未开门";
  if (status === "stuck_open") return "久开未关";
  if (status === "refunded") return "已退款";
  return status;
};

const getEventAdjustments = (event: NonNullable<typeof recentEvents.value>[number]) =>
  event.adjustments?.length
    ? event.adjustments
    : event.adjustmentOrderNo
      ? [
          {
            orderNo: event.adjustmentOrderNo,
            noticeUrl: event.adjustmentNoticeUrl,
            amount: event.adjustmentAmount ?? 0,
            createdAt: event.updatedAt,
            updatedAt: event.updatedAt,
            paymentNotifyStatus: event.adjustmentPaymentNotifyStatus,
            paymentNotifyMessage: event.adjustmentPaymentNotifyMessage,
            paymentNotifiedAt: event.adjustmentPaymentNotifiedAt,
            paymentTransactionId: event.adjustmentPaymentTransactionId,
            refundNo: event.adjustmentRefundNo,
            refundTransactionId: event.adjustmentRefundTransactionId,
            refundedAt: event.adjustmentRefundedAt
          }
        ]
      : [];

const formatOrderSyncStatus = (order: {
  orderNo: string;
  paymentNotifyStatus?: string;
  paymentNotifyMessage?: string;
  paymentTransactionId?: string;
  refundNo?: string;
  refundedAt?: string;
  amount?: number;
}, kind: "original" | "adjustment") => {
  if (order.refundedAt) {
    return `${kind === "adjustment" ? "补扣已退款" : "已退款"}${order.refundNo ? ` / ${order.refundNo}` : ""}`;
  }

  if (order.paymentNotifyStatus === "success") {
    return `${kind === "adjustment" ? "补扣已回写付款成功" : "已回写付款成功"}${order.paymentTransactionId ? ` / ${order.paymentTransactionId}` : ""}`;
  }

  if (order.paymentNotifyStatus === "failed") {
    return `${kind === "adjustment" ? "补扣回写失败" : "回写失败"}${order.paymentNotifyMessage ? `：${order.paymentNotifyMessage}` : ""}`;
  }

  if (kind === "adjustment" && (order.amount ?? 0) > 0) {
    return `补扣待支付 / ${order.orderNo}`;
  }

  if (kind === "adjustment") {
    return `补扣已产生 / ${order.orderNo}`;
  }

  if (order.paymentNotifyStatus === "pending") {
    return order.paymentNotifyMessage || "待回写";
  }

  return "未关联平台动作";
};

const resolvePlatformOrderContext = (
  event: NonNullable<typeof recentEvents.value>[number],
  intent: "payment" | "refund",
  adjustmentOrderNo?: string
) => {
  const adjustment = adjustmentOrderNo
    ? getEventAdjustments(event).find((entry) => entry.orderNo === adjustmentOrderNo)
    : undefined;

  return {
    orderNo: adjustment?.orderNo ?? event.orderNo,
    amount: adjustment?.amount ?? event.amount,
    targetUrl: adjustment?.noticeUrl ?? event.paymentNotifyUrl,
    label: adjustment ? "补扣订单" : "原始订单",
    isAdjustmentOrder: Boolean(adjustment),
    transactionId: adjustment?.paymentTransactionId ?? event.paymentTransactionId,
    refundedAt: adjustment?.refundedAt ?? event.refundedAt,
    refundNo: adjustment?.refundNo ?? event.refundNo,
    refundTransactionId: adjustment?.refundTransactionId ?? event.refundTransactionId,
    pendingRefund:
      adjustment?.paymentRecovery?.pendingRefund ??
      event.paymentRecovery?.pendingRefund
  };
};

const paymentActionLabel = (event: NonNullable<typeof recentEvents.value>[number], adjustmentOrderNo?: string) =>
  resolvePlatformOrderContext(event, "payment", adjustmentOrderNo).isAdjustmentOrder ? "补扣付款成功" : "付款成功";

const refundActionLabel = (event: NonNullable<typeof recentEvents.value>[number], adjustmentOrderNo?: string) =>
  resolvePlatformOrderContext(event, "refund", adjustmentOrderNo).isAdjustmentOrder ? "补扣退款" : "退款";

const formatLogStatus = (status: string) =>
  status === "success" ? "成功" : status === "warning" ? "预警" : status === "failed" ? "失败" : "待处理";

const formatUserRole = (role: "admin" | "merchant" | "special") =>
  role === "admin" ? "管理员" : role === "merchant" ? "商家" : "用户";

const formatDebugPayload = (value: unknown) => {
  if (value === undefined || value === null) {
    return "-";
  }

  if (typeof value === "string") {
    return value;
  }

  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
};

const getAuditDirection = (entry: NonNullable<typeof debugSystemAuditRows.value>[number]) =>
  entry.path.startsWith("/external/smartvm") ? "发" : "收";

const getAuditSource = (entry: NonNullable<typeof debugSystemAuditRows.value>[number]) => {
  if (entry.path.startsWith("/external/smartvm")) {
    return "后端";
  }

  if (entry.path.includes("/callbacks/")) {
    return "平台";
  }

  return "外部调用方";
};

const getAuditTarget = (entry: NonNullable<typeof debugSystemAuditRows.value>[number]) => {
  if (entry.path.startsWith("/external/smartvm")) {
    return "平台";
  }

  return "后端";
};

const getAuditRequestUrl = (entry: NonNullable<typeof debugSystemAuditRows.value>[number]) => {
  const metadata = entry.metadata as Record<string, unknown> | undefined;
  return typeof metadata?.requestUrl === "string" ? metadata.requestUrl : "";
};

const getAuditLabel = (entry: NonNullable<typeof debugSystemAuditRows.value>[number]) => {
  if (entry.path.includes("/api/pay/container/opendoor")) {
    return "开门接口";
  }

  if (entry.path.includes("/api/pay/container/getCabinetGoodsInfo")) {
    return "获取设备商品列表";
  }

  if (entry.path.includes("/payment-success")) {
    return "付款成功异步通知";
  }

  if (entry.path.includes("/refund")) {
    return "退款接口";
  }

  if (entry.path.includes("/callbacks/door-status")) {
    return "门状态推送";
  }

  if (entry.path.includes("/callbacks/settlement")) {
    return "结算商品推送";
  }

  if (entry.path.includes("/callbacks/adjustment")) {
    return "补扣商品推送";
  }

  if (entry.path.includes("/callbacks/payment-success")) {
    return "外部付款成功通知";
  }

  return entry.path;
};

const getAuditRequestLabel = (entry: NonNullable<typeof debugSystemAuditRows.value>[number]) =>
  getAuditDirection(entry) === "发" ? "发送内容" : "收到内容";

const getAuditResponseLabel = (entry: NonNullable<typeof debugSystemAuditRows.value>[number]) =>
  getAuditDirection(entry) === "发" ? "平台实际响应" : "后端实际响应";

const formatCallbackTypeLabel = (type: string) => {
  if (type === "door-status") return "门状态推送";
  if (type === "settlement") return "结算商品推送";
  if (type === "adjustment") return "补扣商品推送";
  if (type === "payment-success") return "付款成功异步通知";
  if (type === "refund") return "退款接口";
  return type;
};

const formatGoodsStock = (goods: NonNullable<typeof selectedDoorGoods.value>[number]) => {
  const base =
    goods.thresholdEnabled && goods.lowStockThreshold !== undefined
      ? `${goods.stock}/${goods.lowStockThreshold}`
      : `${goods.stock}`;
  const tags: string[] = [];

  if (goods.thresholdEnabled && goods.lowStockThreshold !== undefined && goods.stock <= 0) {
    tags.push("缺货");
  } else if (
    goods.thresholdEnabled &&
    goods.lowStockThreshold !== undefined &&
    goods.stock <= goods.lowStockThreshold
  ) {
    tags.push("低库存");
  }

  if (goods.expiringSoon) {
    tags.push("临期");
  }

  return tags.length ? `${base}（${tags.join("，")}）` : base;
};

const taskActionLabel = (task: NonNullable<typeof pendingTasks.value>[number]) =>
  task.grade === "fault" ? "标记已知晓" : "手动完成";

const taskGradeLabel = (grade: "fault" | "feedback" | "warning") =>
  grade === "fault" ? "故障" : grade === "feedback" ? "反馈" : "预警";

const taskContextSummary = (task: NonNullable<typeof pendingTasks.value>[number]) =>
  buildAlertContextSummary(task) || "未关联到明确的商品、人员或柜机";

const taskIdentitySummary = (task: NonNullable<typeof pendingTasks.value>[number]) =>
  buildAlertIdentitySummary(task);

const taskReferenceSummary = (task: NonNullable<typeof pendingTasks.value>[number]) =>
  buildAlertReferenceSummary(task);

const logContextSummary = (log: NonNullable<typeof recentLogs.value>[number]) =>
  buildLogContextSummary(log) || buildLogSubjectSummary(log) || "未识别到明确业务对象";

const logReferenceSummary = (log: NonNullable<typeof recentLogs.value>[number]) =>
  buildLogReferenceSummary(log);

const logSubjectSummary = (log: NonNullable<typeof recentLogs.value>[number]) =>
  buildLogSubjectSummary(log);

const resolveEventUserLabel = (event: NonNullable<typeof recentEvents.value>[number]) =>
  servedUserNameMap.value.get(event.userId) ?? event.userId;

const summarizeEventGoods = (event: NonNullable<typeof recentEvents.value>[number]) =>
  event.goods.length
    ? event.goods.map((goods) => `${goods.goodsName} ×${goods.quantity}`).join("；")
    : "未记录结算货品";

const shouldShowPaymentAction = (
  event: NonNullable<typeof recentEvents.value>[number],
  adjustmentOrderNo?: string
) => {
  const platformContext = resolvePlatformOrderContext(event, "payment", adjustmentOrderNo);

  if (platformContext.isAdjustmentOrder) {
    const adjustment = getEventAdjustments(event).find((entry) => entry.orderNo === adjustmentOrderNo);
    return Boolean(adjustment?.noticeUrl) && adjustment?.paymentNotifyStatus === "pending";
  }

  return Boolean(event.paymentNotifyUrl) && event.paymentNotifyStatus === "pending";
};

const shouldShowRefundAction = (
  event: NonNullable<typeof recentEvents.value>[number],
  adjustmentOrderNo?: string
) => {
  const platformContext = resolvePlatformOrderContext(event, "refund", adjustmentOrderNo);

  if (platformContext.refundedAt || !platformContext.transactionId) {
    return false;
  }

  if (platformContext.isAdjustmentOrder) {
    const adjustment = getEventAdjustments(event).find((entry) => entry.orderNo === adjustmentOrderNo);
    return adjustment?.paymentNotifyStatus === "success";
  }

  return event.paymentNotifyStatus === "success";
};

const load = async () => {
  loading.value = true;
  loadError.value = "";
  try {
    const [deviceDetail, catalogResponse] = await Promise.all([
      adminApi.deviceDetail(String(route.params.deviceCode)),
      adminApi.goodsCatalog()
    ]);
    detail.value = deviceDetail;
    goodsCatalog.value = catalogResponse;
    financialOutcomePending.value = financialOutcomePending.value.filter(
      (pending) =>
        recentEvents.value.some((event) => {
          const adjustmentOrderNo =
            event.orderNo === pending.orderNo
              ? undefined
              : getEventAdjustments(event).find(
                  (entry) => entry.orderNo === pending.orderNo
                )?.orderNo;

          if (
            event.orderNo !== pending.orderNo &&
            adjustmentOrderNo === undefined
          ) {
            return false;
          }

          return pending.kind === "payment"
            ? shouldShowPaymentAction(event, adjustmentOrderNo)
            : shouldShowRefundAction(event, adjustmentOrderNo);
        })
    );
    if (!detail.value.device.doors.some((door) => door.doorNum === selectedDoorNum.value)) {
      selectedDoorNum.value = detail.value.device.doors[0]?.doorNum ?? "1";
    }
    if (!selectedGoodsToAdd.value || !addableGoodsOptions.value.some((item) => item.goodsId === selectedGoodsToAdd.value)) {
      selectedGoodsToAdd.value = addableGoodsOptions.value[0]?.goodsId ?? "";
    }
    lastUpdatedAt.value = formatNowInBeijing();
  } catch (error) {
    loadError.value = readErrorMessage(error, "柜机详情加载失败");
  } finally {
    loading.value = false;
  }
};

const loadDebugPanel = async () => {
  if (!canViewDebugPanel.value) {
    return;
  }

  debugLoading.value = true;
  try {
    const [callbackLogs, systemAuditLogs] = await Promise.all([
      canViewCallbackLogs.value
        ? adminApi.deviceCallbackLogs(
            String(route.params.deviceCode),
            Number(debugCallbackLimit.value)
          )
        : Promise.resolve([]),
      canViewSystemAudit.value
        ? adminApi.systemAuditLogs({
            deviceCode: String(route.params.deviceCode),
            limit: Number(debugAuditLimit.value)
          })
        : Promise.resolve([])
    ]);
    debugCallbackLogs.value = callbackLogs;
    debugSystemAuditLogs.value = systemAuditLogs;
    debugLoaded.value = true;
  } finally {
    debugLoading.value = false;
  }
};

const refreshDevice = async () => {
  if (!canOperateDevice.value) {
    showActionMessage("error", "当前账号没有柜机操作权限，不能刷新远端状态。");
    return;
  }

  refreshing.value = true;
  try {
    detail.value = await adminApi.refreshDevice(String(route.params.deviceCode));
    lastUpdatedAt.value = formatNowInBeijing();
    showActionMessage("success", `已刷新柜机状态，最近刷新时间 ${lastUpdatedAt.value}。`);
  } catch (error) {
    showActionMessage("error", `刷新失败：${readErrorMessage(error, "请稍后重试")}`);
  } finally {
    refreshing.value = false;
  }

  if (debugPanelVisible.value) {
    await loadDebugPanel();
  }
};

const isClosedZeroCostRestockWithoutSettlement = (event: DeviceRecentEvent) =>
  event.status === "closed" &&
  event.role !== "special" &&
  event.hasInboundGoods === true &&
  event.amount === 0 &&
  !event.orderNo.startsWith("pending-");

const canRecoverZeroCostCompletion = (event: DeviceRecentEvent) => {
  if (!canOperateDevice.value || event.paymentNotifyStatus === "success") {
    return false;
  }

  if (isClosedZeroCostRestockWithoutSettlement(event)) {
    return true;
  }

  return (
    event.status === "settled" &&
    event.amount === 0 &&
    Boolean(event.paymentNotifyUrl) &&
    ["free", "admin_confirmed", "mismatch", "blocked"].includes(event.billingStatus ?? "")
  );
};

const recoverZeroCostCompletion = async (event: DeviceRecentEvent) => {
  if (!canRecoverZeroCostCompletion(event) || completingZeroCostEventId.value) {
    return;
  }

  const requiresConfirmation = event.billingStatus === "mismatch" || event.billingStatus === "blocked";
  const prompt = isClosedZeroCostRestockWithoutSettlement(event)
    ? "确认本次为已关门的零元补货操作，并结束柜机平台中的对应订单？"
    : requiresConfirmation
    ? "确认已核对本次公益领取差异，并向柜机平台回写零元订单完成状态？"
    : "确认重试向柜机平台回写这笔零元订单的完成状态？";

  if (!window.confirm(prompt)) {
    return;
  }

  completingZeroCostEventId.value = event.eventId;
  try {
    if (requiresConfirmation) {
      await adminApi.confirmBillingResolution(
        event.eventId,
        "已核对公益零元领取结果，确认订单结束并回写平台。"
      );
    } else {
      await adminApi.retryZeroCostPlatformCompletion(event.eventId);
    }
    await load();

    const refreshed = recentEvents.value.find((entry) => entry.eventId === event.eventId);
    if (refreshed?.paymentNotifyStatus === "success") {
      showActionMessage("success", "平台已确认零元订单完成。");
    } else {
      showActionMessage(
        "error",
        refreshed?.paymentNotifyMessage
          ? `平台回写尚未完成：${refreshed.paymentNotifyMessage}`
          : "平台回写尚未完成，请查看订单同步状态。"
      );
    }
  } catch (error) {
    showActionMessage(
      "error",
      `零元订单回写失败：${readErrorMessage(error, "请稍后重试")}`
    );
  } finally {
    completingZeroCostEventId.value = "";
  }
};

const closeDoorClosedDialog = async (restoreFocus = true) => {
  if (confirmingDoorClosed.value) {
    return;
  }

  if (doorClosedDialog.value?.open) {
    doorClosedDialog.value.close();
  }
  doorClosedSubmitError.value = "";
  if (restoreFocus) {
    await nextTick();
    doorClosedPreviousFocus?.focus();
  }
  doorClosedPreviousFocus = undefined;
};

const openDoorClosedDialog = async () => {
  if (!doorNeedsPhysicalConfirmation.value || confirmingDoorClosed.value) {
    return;
  }

  doorClosedPreviousFocus = document.activeElement instanceof HTMLElement
    ? document.activeElement
    : undefined;
  doorClosedSubmitError.value = "";
  await nextTick();
  if (doorClosedDialog.value && !doorClosedDialog.value.open) {
    doorClosedDialog.value.showModal();
  }
  doorClosedSafeButton.value?.focus();
};

const confirmDoorClosed = async () => {
  if (!doorNeedsPhysicalConfirmation.value || confirmingDoorClosed.value) {
    return;
  }

  confirmingDoorClosed.value = true;
  try {
    detail.value = await adminApi.confirmDeviceDoorClosed(String(route.params.deviceCode));
    lastUpdatedAt.value = formatNowInBeijing();
    confirmingDoorClosed.value = false;
    await closeDoorClosedDialog();
    showActionMessage("success", "已记录全部柜门关闭确认；请再次刷新平台状态后再决定是否开门。");
  } catch (error) {
    doorClosedSubmitError.value = `确认失败：${readErrorMessage(error, "请稍后重试")}`;
  } finally {
    confirmingDoorClosed.value = false;
  }
};

const syncGoods = async () => {
  if (!canManageGoods.value) {
    showActionMessage("error", "当前账号没有货品资料管理权限，不能同步货品种类。");
    return;
  }

  syncing.value = true;
  try {
    await adminApi.syncDeviceGoods(String(route.params.deviceCode), selectedDoorNum.value);
    await load();
    showActionMessage("success", `已同步 ${String(route.params.deviceCode)} / ${selectedDoorNum.value} 号货门的货品种类。`);
  } catch (error) {
    showActionMessage("error", `同步货品失败：${readErrorMessage(error, "请稍后重试")}`);
  } finally {
    syncing.value = false;
  }

  if (debugPanelVisible.value) {
    await loadDebugPanel();
  }
};

const canRestoreFocus = (target?: HTMLElement) =>
  Boolean(target?.isConnected && !target.matches(":disabled") && target.getAttribute("aria-disabled") !== "true");

const restoreRemoteOpenFocus = async () => {
  const target = remoteOpenPreviousFocus;
  remoteOpenPreviousFocus = undefined;
  await nextTick();

  if (canRestoreFocus(target)) {
    target?.focus();
  }
};

const resetRemoteOpenDialog = async (restoreFocus = true) => {
  if (remoteOpenDialog.value?.open) {
    remoteOpenDialog.value.close();
  }
  remoteOpenDialogStep.value = undefined;
  remoteOpenReason.value = "";
  remoteOpenSubmitError.value = "";
  remoteOpenOutcomePending.value = false;

  if (restoreFocus) {
    await restoreRemoteOpenFocus();
  } else {
    remoteOpenPreviousFocus = undefined;
  }
};

const closeRemoteOpenDialog = async () => {
  if (!remoteOpening.value) {
    await resetRemoteOpenDialog();
  }
};

const remoteOpen = async () => {
  if (remoteOpening.value) {
    return;
  }

  if (!canOperateDevice.value) {
    showActionMessage("error", "当前账号没有柜机操作权限，不能远程开门。");
    return;
  }

  const device = detail.value?.device;
  if (!device) {
    showActionMessage("error", "柜机详情尚未加载，不能下发远程开门指令。请先刷新页面。");
    return;
  }

  if (!deviceCanOpen.value) {
    showActionMessage("error", remoteOpenBlockedHint.value || "当前柜机不可开门，请先核对状态。");
    return;
  }

  if (detail.value?.runtime.doorState === "open") {
    showActionMessage("error", "当前门状态已是开启，已阻止重复下发开门指令。请先确认现场并等待关门。");
    return;
  }

  remoteOpenPreviousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : undefined;
  remoteOpenReason.value = "";
  remoteOpenSubmitError.value = "";
  remoteOpenOutcomePending.value = false;
  remoteOpenDialogStep.value = "reason";
  await nextTick();
  if (remoteOpenDialog.value && !remoteOpenDialog.value.open) {
    remoteOpenDialog.value.showModal();
  }
  remoteOpenReasonInput.value?.focus();
};

const continueRemoteOpen = async () => {
  const reason = remoteOpenReason.value.trim();
  if (!reason) {
    showActionMessage("error", "请填写操作原因。");
    return;
  }

  remoteOpenReason.value = reason;
  remoteOpenSubmitError.value = "";
  remoteOpenOutcomePending.value = false;
  remoteOpenDialogStep.value = "confirm";
  await nextTick();
  remoteOpenSafeButton.value?.focus();
};

const returnToRemoteOpenReason = async () => {
  if (remoteOpening.value) {
    return;
  }

  remoteOpenSubmitError.value = "";
  remoteOpenOutcomePending.value = false;
  remoteOpenDialogStep.value = "reason";
  await nextTick();
  remoteOpenReasonInput.value?.focus();
};

const confirmRemoteOpen = async () => {
  if (remoteOpening.value || remoteOpenDialogStep.value !== "confirm") {
    return;
  }

  const device = detail.value?.device;
  const reason = remoteOpenReason.value.trim();

  if (
    !device ||
    !deviceCanOpen.value ||
    detail.value?.runtime.doorState === "open"
  ) {
    await closeRemoteOpenDialog();
    showActionMessage("error", "柜机状态已变化，已阻止远程开门。请刷新后重新核对。");
    return;
  }

  if (!reason) {
    remoteOpenDialogStep.value = "reason";
    showActionMessage("error", "请填写操作原因。");
    await nextTick();
    remoteOpenReasonInput.value?.focus();
    return;
  }

  let completed = false;
  remoteOpenSubmitError.value = "";
  remoteOpenOutcomePending.value = false;
  remoteOpening.value = true;
  try {
    const result = await adminApi.remoteOpenDevice(String(route.params.deviceCode), selectedDoorNum.value, reason);
    await load();
    showActionMessage("success", `远程开门指令已下发：订单 ${result.orderNo}，事件 ${result.eventId}。请继续关注门状态和关联日志。`);
    completed = true;
  } catch (error) {
    const message = readErrorMessage(error, "请求结果无法确认");
    remoteOpenOutcomePending.value = isRemoteOpenOutcomePendingError(error, message);
    remoteOpenSubmitError.value = remoteOpenOutcomePending.value
      ? `开门结果待确认：${message} 请勿再次下发；请关闭对话框并查看最新门状态和关联日志。`
      : `远程开门失败：${message}`;
    showActionMessage("error", remoteOpenSubmitError.value);

    if (remoteOpenOutcomePending.value) {
      await load();
    }
  } finally {
    remoteOpening.value = false;
    await nextTick();

    if (completed) {
      await resetRemoteOpenDialog();
    } else {
      remoteOpenSafeButton.value?.focus();
    }
  }

  if (debugPanelVisible.value) {
    await loadDebugPanel();
  }
};

const restoreFinancialFocus = async () => {
  const target = financialPreviousFocus;
  financialPreviousFocus = undefined;
  await nextTick();

  if (canRestoreFocus(target)) {
    target?.focus();
  }
};

const resetFinancialDialog = async (restoreFocus = true) => {
  if (financialDialog.value?.open) {
    financialDialog.value.close();
  }
  financialAction.value = undefined;
  financialSubmitError.value = "";

  if (restoreFocus) {
    await restoreFinancialFocus();
  } else {
    financialPreviousFocus = undefined;
  }
};

const closeFinancialDialog = async () => {
  if (
    !notifyingPaymentOrderNo.value &&
    !refundingOrderNo.value &&
    !reconcilingRefundId.value
  ) {
    const shouldRefresh = isCurrentFinancialOutcomePending.value;
    await resetFinancialDialog();
    if (shouldRefresh) {
      await load();
    }
  }
};

const openFinancialDialog = async (
  kind: FinancialActionKind,
  event: DeviceRecentEvent,
  adjustmentOrderNo?: string
) => {
  if (kind === "payment" && !canManualPaymentSuccess.value) {
    showActionMessage("error", "手工回写付款成功需要同时具备柜机操作和退款支付处理权限。");
    return;
  }
  if (kind === "refund" && !canRefundPayments.value) {
    showActionMessage("error", "当前账号没有退款处理权限，不能发起退款。");
    return;
  }

  const platformContext = resolvePlatformOrderContext(event, kind, adjustmentOrderNo);
  const pendingRefund =
    kind === "refund" ? platformContext.pendingRefund : undefined;
  if (isFinancialOutcomePending(kind, platformContext.orderNo) && !pendingRefund) {
    showActionMessage(
      "error",
      `${kind === "refund" ? "退款" : "付款回写"}结果仍待确认，请先刷新订单状态，不要重复提交。`
    );
    return;
  }
  financialPreviousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : undefined;
  financialSubmitError.value = "";
  financialAction.value = {
    kind,
    step: pendingRefund ? "confirm" : "input",
    event,
    adjustmentOrderNo,
    orderNo: platformContext.orderNo,
    label: platformContext.label,
    targetUrl: platformContext.targetUrl,
    expectedAmount: pendingRefund?.amount ?? platformContext.amount,
    transactionId: platformContext.transactionId ?? "",
    refundNo:
      kind === "refund"
        ? pendingRefund?.sourceRequestId ??
          platformContext.refundNo ??
          createCompactReference("rfd")
        : "",
    refundRecordId: pendingRefund?.id,
    amountInput:
      (pendingRefund?.amount ?? platformContext.amount) === undefined
        ? ""
        : String(pendingRefund?.amount ?? platformContext.amount)
  };
  if (pendingRefund) {
    financialOutcomePending.value = [
      ...financialOutcomePending.value.filter(
        (entry) =>
          entry.kind !== "refund" ||
          entry.orderNo !== platformContext.orderNo
      ),
      { kind: "refund", orderNo: platformContext.orderNo }
    ];
    financialSubmitError.value =
      `本地退款单 ${pendingRefund.refundNo} 仍待支付渠道确认。主动核对会复用原退款号，不会新建退款单。`;
  }

  await nextTick();
  if (financialDialog.value && !financialDialog.value.open) {
    financialDialog.value.showModal();
  }
  if (pendingRefund) {
    financialSafeButton.value?.focus();
  } else {
    focusFinancialInput();
  }
};

const notifyPaymentSuccess = (event: DeviceRecentEvent, adjustmentOrderNo?: string) =>
  openFinancialDialog("payment", event, adjustmentOrderNo);

const refundEvent = (event: DeviceRecentEvent, adjustmentOrderNo?: string) =>
  openFinancialDialog("refund", event, adjustmentOrderNo);

const focusFinancialInput = () => {
  if (financialAction.value?.kind === "refund") {
    financialAmountInput.value?.focus();
    return;
  }

  financialPrimaryInput.value?.focus();
};

const continueFinancialAction = async () => {
  if (!financialAction.value || financialInputError.value) {
    financialSubmitError.value = financialInputError.value || "请先完整填写并核对操作信息。";
    return;
  }

  financialSubmitError.value = "";
  financialAction.value.step = "confirm";
  await nextTick();
  financialSafeButton.value?.focus();
};

const returnToFinancialInput = async () => {
  if (
    !financialAction.value ||
    notifyingPaymentOrderNo.value ||
    refundingOrderNo.value ||
    isCurrentFinancialOutcomePending.value
  ) {
    return;
  }

  financialAction.value.step = "input";
  financialSubmitError.value = "";
  await nextTick();
  focusFinancialInput();
};

const confirmFinancialAction = async () => {
  const draft = financialAction.value;
  if (!draft || draft.step !== "confirm" || financialInputError.value) {
    financialSubmitError.value = financialInputError.value || "操作信息已失效，请返回重新核对。";
    return;
  }

  if ((draft.kind === "payment" && !canManualPaymentSuccess.value) || (draft.kind === "refund" && !canRefundPayments.value)) {
    await resetFinancialDialog();
    showActionMessage(
      "error",
      draft.kind === "refund"
        ? "当前账号退款权限已变化，已阻止本次退款。请重新登录后再试。"
        : "当前账号的柜机操作或退款支付处理权限已变化，已阻止本次付款回写。请重新登录后再试。"
    );
    return;
  }

  const currentEvent = recentEvents.value.find((entry) => entry.eventId === draft.event.eventId);
  const actionStillAvailable = currentEvent && (
    draft.kind === "payment"
      ? shouldShowPaymentAction(currentEvent, draft.adjustmentOrderNo)
      : shouldShowRefundAction(currentEvent, draft.adjustmentOrderNo)
  );
  const currentContext = currentEvent
    ? resolvePlatformOrderContext(currentEvent, draft.kind, draft.adjustmentOrderNo)
    : undefined;
  const sourceStillMatches = currentContext &&
    currentContext.orderNo === draft.orderNo &&
    currentContext.amount === draft.expectedAmount &&
    (draft.kind === "payment" || currentContext.transactionId === draft.transactionId.trim());
  if (!currentEvent || !actionStillAvailable || !sourceStillMatches) {
    await resetFinancialDialog();
    showActionMessage("error", "订单状态或金额已变化，已阻止重复处理。请刷新后重新核对。");
    return;
  }

  const amount = financialAmount.value;
  const transactionId = draft.transactionId.trim();
  const refundNo = draft.refundNo.trim();
  financialSubmitError.value = "";

  if (draft.kind === "payment") {
    notifyingPaymentOrderNo.value = draft.orderNo;
  } else {
    refundingOrderNo.value = draft.orderNo;
  }

  let completed = false;
  try {
    if (draft.kind === "payment") {
      await adminApi.notifyPaymentSuccess({
        orderNo: draft.orderNo,
        eventId: currentEvent.eventId,
        transactionId,
        deviceCode: currentEvent.deviceCode,
        amount,
        targetUrl: draft.targetUrl
      });
      await load();
      completed = true;
      showActionMessage(
        "success",
        `已向平台回写${draft.label}付款成功：订单 ${draft.orderNo}，交易号 ${transactionId}，金额 ${(amount / 100).toFixed(2)} 元。`
      );
    } else {
      const refund = await adminApi.refundOrder({
        orderNo: draft.orderNo,
        transactionId,
        deviceCode: currentEvent.deviceCode,
        refundNo,
        amount
      });
      await load();
      const outcome = classifyRefundOutcome(refund);

      if (outcome === "completed") {
        completed = true;
        showActionMessage(
          "success",
          `${draft.label}退款已完成：订单 ${draft.orderNo}，操作请求编号 ${refundNo}，金额 ${(amount / 100).toFixed(2)} 元。`
        );
      } else if (outcome === "failed") {
        financialSubmitError.value = `退款失败：${refund.failReason || "支付渠道已明确拒绝退款，请核对后再试。"}`;
        showActionMessage("error", financialSubmitError.value);
      } else {
        draft.refundRecordId = refund.id;
        financialOutcomePending.value = [
          ...financialOutcomePending.value.filter(
            (entry) => entry.kind !== "refund" || entry.orderNo !== draft.orderNo
          ),
          { kind: "refund", orderNo: draft.orderNo }
        ];
        financialSubmitError.value =
          `退款请求已记录（操作请求编号 ${refundNo}，本地退款单 ${refund.refundNo}），但渠道或业务结果尚未全部确认。可复用原退款单主动核对，不会新建退款单；确认前不要重复提交。`;
        showActionMessage("error", financialSubmitError.value);
      }
    }
  } catch (error) {
    const prefix = draft.kind === "payment" ? "付款回写失败" : "退款失败";
    if (isFinancialActionOutcomeUncertain(error)) {
      if (draft.kind === "refund") {
        await load();
        const recoveredRefund = findPersistedPendingRefund(draft.orderNo);
        if (recoveredRefund) {
          draft.refundRecordId = recoveredRefund.id;
          draft.refundNo =
            recoveredRefund.sourceRequestId ??
            recoveredRefund.refundNo;
          draft.amountInput = String(recoveredRefund.amount);
          draft.expectedAmount = recoveredRefund.amount;
          financialSubmitError.value =
            `退款请求已经由服务端记录为待确认（本地退款单 ${recoveredRefund.refundNo}）。可复用原退款单主动核对，不会新建退款单；确认前不要重复提交。`;
        }
      }
      financialOutcomePending.value = [
        ...financialOutcomePending.value.filter(
          (entry) =>
            entry.kind !== draft.kind || entry.orderNo !== draft.orderNo
        ),
        { kind: draft.kind, orderNo: draft.orderNo }
      ];
      financialSubmitError.value ||=
        `${draft.kind === "payment" ? "付款回写" : "退款"}请求已经发出，但结果尚未确认。请刷新订单状态，确认前不要重复提交。`;
      showActionMessage("error", financialSubmitError.value);
    } else {
      financialSubmitError.value = `${prefix}：${readErrorMessage(error, "请稍后重试")}`;
    }
  } finally {
    notifyingPaymentOrderNo.value = "";
    refundingOrderNo.value = "";
    await nextTick();
  }

  if (completed) {
    await resetFinancialDialog();
  } else {
    financialSafeButton.value?.focus();
  }

  if (debugPanelVisible.value) {
    await loadDebugPanel();
  }
};

const reconcilePendingRefund = async () => {
  const draft = financialAction.value;
  const refundRecordId = draft?.refundRecordId;
  if (
    !draft ||
    draft.kind !== "refund" ||
    !refundRecordId ||
    !isCurrentFinancialOutcomePending.value
  ) {
    financialSubmitError.value = "当前没有可主动核对的本地退款单，请关闭后刷新订单状态。";
    return;
  }
  if (!canRefundPayments.value) {
    await resetFinancialDialog();
    showActionMessage("error", "当前账号退款权限已变化，已阻止主动核对。请重新登录后再试。");
    return;
  }

  reconcilingRefundId.value = refundRecordId;
  financialSubmitError.value = "";
  try {
    const refund = await adminApi.reconcileRefund(refundRecordId);
    await load();
    const outcome = classifyRefundOutcome(refund);

    if (outcome === "completed") {
      financialOutcomePending.value = financialOutcomePending.value.filter(
        (entry) => entry.kind !== "refund" || entry.orderNo !== draft.orderNo
      );
      showActionMessage(
        "success",
        `${draft.label}退款已由支付渠道确认完成：本地退款单 ${refund.refundNo}，金额 ${(refund.amount / 100).toFixed(2)} 元。`
      );
      await resetFinancialDialog();
      return;
    }

    if (outcome === "failed") {
      financialOutcomePending.value = financialOutcomePending.value.filter(
        (entry) => entry.kind !== "refund" || entry.orderNo !== draft.orderNo
      );
      showActionMessage(
        "error",
        `支付渠道已明确退款失败：${refund.failReason || "请核对渠道账单后重新发起新的退款。"}`
      );
      await resetFinancialDialog();
      return;
    }

    financialSubmitError.value =
      `支付渠道尚未返回退款终态。本地退款单 ${refund.refundNo} 继续保留；再次核对会复用原退款号，不会新建退款单。`;
    showActionMessage("error", financialSubmitError.value);
  } catch (error) {
    const message = readErrorMessage(error, "支付渠道暂时无法完成核对");
    financialSubmitError.value = isFinancialActionOutcomeUncertain(error)
      ? `主动核对结果仍待确认：${message}。系统继续保留原退款单，不会新建退款单。`
      : `主动核对失败：${message}。请先核对渠道账单，不要重新发起退款。`;
    showActionMessage("error", financialSubmitError.value);
  } finally {
    reconcilingRefundId.value = "";
    await nextTick();
    financialSafeButton.value?.focus();
  }
};

const resolveTask = async (taskId: string) => {
  if (!canManageAlerts.value) {
    showActionMessage("error", "当前账号没有预警处理权限，不能处理待办。");
    return;
  }

  const task = pendingTasks.value.find((entry) => entry.id === taskId);
  if (!task || !window.confirm(task.grade === "fault" ? "确认标记为已知晓？故障任务仍会保留为需继续跟进的状态。" : `确认${taskActionLabel(task)}？完成后会移入处理记录。`)) {
    return;
  }
  resolvingTaskId.value = taskId;
  try {
    await adminApi.resolveAlert(
      taskId,
      task?.grade === "fault" ? "管理员已知晓并接手处理" : "管理员手动完成"
    );
    await load();
    showActionMessage("success", task.grade === "fault" ? "已标记为知晓，请继续跟进柜机状态或关联日志。" : "待办已完成。");
  } catch (error) {
    showActionMessage("error", `处理待办失败：${readErrorMessage(error, "请稍后重试")}`);
  } finally {
    resolvingTaskId.value = "";
  }
};

const saveLocation = async (payload: {
  longitude: number;
  latitude: number;
  location: string;
  address: string;
}) => {
  if (!canManageDevice.value) {
    showActionMessage("error", "当前账号没有柜机资料管理权限，不能保存位置。");
    return;
  }

  updatingLocation.value = true;
  try {
    await adminApi.updateDeviceLocation(String(route.params.deviceCode), {
      location: payload.location,
      address: payload.address,
      longitude: payload.longitude,
      latitude: payload.latitude
    });
    mapPickerVisible.value = false;
    await load();
    showActionMessage("success", `柜机位置已保存：${payload.location || payload.address || "已更新坐标"}。移动端会按新坐标参与距离排序。`);
  } catch (error) {
    showActionMessage("error", `保存位置失败：${readErrorMessage(error, "请稍后重试")}`);
  } finally {
    updatingLocation.value = false;
  }
};

const toggleDebugPanel = async () => {
  debugPanelVisible.value = !debugPanelVisible.value;

  if (debugPanelVisible.value && !debugLoaded.value) {
    await loadDebugPanel();
  }
};

const addGoods = async () => {
  if (!canManageDevice.value) {
    showActionMessage("error", "当前账号没有柜机资料管理权限，不能加入货品。");
    return;
  }

  if (!selectedGoodsToAdd.value) {
    showActionMessage("error", "加入货品失败：请先选择要加入当前货门的货品。");
    return;
  }

  addingGoods.value = true;
  try {
    const goodsName = goodsCatalog.value.find((item) => item.goodsId === selectedGoodsToAdd.value)?.name ?? selectedGoodsToAdd.value;
    detail.value = await adminApi.addDeviceGoods(String(route.params.deviceCode), {
      goodsId: selectedGoodsToAdd.value,
      doorNum: selectedDoorNum.value
    });
    selectedGoodsToAdd.value = addableGoodsOptions.value[0]?.goodsId ?? "";
    showActionMessage("success", `已将“${goodsName}”加入 ${String(route.params.deviceCode)} / ${selectedDoorNum.value} 号货门，可继续维护库存或阈值。`);
  } catch (error) {
    showActionMessage("error", `加入货品失败：${readErrorMessage(error, "请稍后重试")}`);
  } finally {
    addingGoods.value = false;
  }
};

const removeGoods = async (goodsId: string) => {
  if (!canManageDevice.value) {
    showActionMessage("error", "当前账号没有柜机资料管理权限，不能移除货品。");
    return;
  }

  if (!window.confirm("确认移除这条零库存货品？")) {
    return;
  }

  removingGoodsId.value = goodsId;
  try {
    const goodsName = selectedDoorGoods.value.find((item) => item.goodsId === goodsId)?.name ?? goodsId;
    detail.value = await adminApi.removeDeviceGoods(String(route.params.deviceCode), goodsId, selectedDoorNum.value);
    if (selectedGoodsToAdd.value === goodsId) {
      selectedGoodsToAdd.value = "";
    }
    showActionMessage("success", `已从 ${String(route.params.deviceCode)} / ${selectedDoorNum.value} 号货门移除“${goodsName}”。历史库存和领取记录仍保留。`);
  } catch (error) {
    showActionMessage("error", `移除货品失败：${readErrorMessage(error, "请稍后重试")}`);
  } finally {
    removingGoodsId.value = "";
  }
};

watch(
  () => route.params.deviceCode,
  async () => {
    await resetRemoteOpenDialog(false);
    await resetFinancialDialog(false);
    await load();
  }
);

onMounted(async () => {
  await load();
  timer = setInterval(load, 8_000);
  if (typeof document !== "undefined") {
    visibilityHandler = () => {
      if (document.hidden) {
        if (timer) {
          clearInterval(timer);
          timer = undefined;
        }
        return;
      }

      void load();
      if (timer) {
        clearInterval(timer);
      }
      timer = setInterval(load, 8_000);
    };
    document.addEventListener("visibilitychange", visibilityHandler);
  }
});

onUnmounted(() => {
  doorClosedDialog.value?.close();
  remoteOpenDialog.value?.close();
  financialDialog.value?.close();
  if (timer) {
    clearInterval(timer);
  }
  if (visibilityHandler) {
    document.removeEventListener("visibilitychange", visibilityHandler);
  }
});
</script>

<template>
  <section class="admin-page">
    <section class="admin-page__section">
      <div class="admin-page__section-head">
        <div>
          <p class="admin-kicker">单柜机值守页</p>
          <h3 class="admin-page__section-title">{{ detail?.device.name ?? "加载中" }}</h3>
        </div>
        <div class="admin-toolbar">
          <span class="admin-copy">自动刷新 8 秒一次</span>
          <span class="admin-copy">最近刷新：{{ lastUpdatedAt || "尚未加载" }}</span>
        </div>
      </div>
    </section>

    <div v-if="loadError" class="admin-alert admin-alert--danger" role="alert" aria-live="assertive">
      {{ loadError }}
      <button class="admin-text-button" type="button" @click="load">重试</button>
    </div>
    <div
      v-if="actionMessage"
      class="admin-alert"
      :class="{ 'admin-alert--danger': actionMessage.type === 'error' }"
      :role="actionMessage.type === 'error' ? 'alert' : 'status'"
      :aria-live="actionMessage.type === 'error' ? 'assertive' : 'polite'"
      aria-atomic="true"
    >
      {{ actionMessage.text }}
    </div>

    <section v-if="detail" class="admin-grid">
      <article class="admin-panel admin-panel-block">
        <div class="device-detail-status">
          <div class="device-detail-status__item">
            <span class="admin-kicker">柜机状态</span>
            <strong>{{ getDeviceStatusPresentation(detail.device).label }}</strong>
            <span class="admin-table__subtext">{{ detail.device.deviceCode }} · {{ getDeviceStatusPresentation(detail.device).hint }}</span>
          </div>
          <div class="device-detail-status__item">
            <span class="admin-kicker">门状态</span>
            <strong>{{ formatDoorState(detail.runtime.doorState) }}</strong>
            <span class="admin-table__subtext">{{ detail.runtime.doorState === "unknown" ? "状态待回传；存在未决开门记录时会阻止重复下发" : detail.runtime.openedAfterLastCommand ? "已收到开门反馈" : "未收到开门反馈" }}</span>
          </div>
          <div class="device-detail-status__item">
            <span class="admin-kicker">最近开门指令</span>
            <strong class="admin-code">{{ formatDateTime(detail.runtime.lastCommandAt) }}</strong>
            <span class="admin-table__subtext">{{ detail.runtime.openedAfterLastCommand ? "指令后已收到开门反馈" : "指令后尚未收到开门反馈" }}</span>
          </div>
          <div class="device-detail-status__item">
            <span class="admin-kicker">最近开门</span>
            <strong class="admin-code">{{ formatDateTime(detail.runtime.lastOpenedAt) }}</strong>
            <span class="admin-table__subtext">最近关门：{{ formatDateTime(detail.runtime.lastClosedAt) }}</span>
          </div>
          <div class="device-detail-status__item">
            <span class="admin-kicker">库存与服务</span>
            <strong class="admin-code">{{ detail.totalStock }} 件</strong>
            <span class="admin-table__subtext">累计服务 {{ detail.servedUsers }} 人 / 今日 {{ businessDayServedUsers.length }} 人</span>
          </div>
          <div class="device-detail-status__item">
            <span class="admin-kicker">待处理</span>
            <strong class="admin-code">{{ pendingTasks.length }} 项</strong>
            <span class="admin-table__subtext">
              最近设备回调：{{ formatDateTime(detail.device.lastSeenAt) }}
              <template v-if="detail.device.readiness?.lastPlatformRecognizedAt">
                · 最近平台识别：{{ formatDateTime(detail.device.readiness.lastPlatformRecognizedAt) }}
              </template>
            </span>
          </div>
        </div>
      </article>

      <section class="admin-grid admin-grid--main-aside device-detail__layout">
        <article class="admin-panel admin-panel-block device-detail__main">
          <div class="admin-panel__head">
            <div>
              <span class="admin-kicker">货品台账</span>
              <h3 class="admin-panel__title">本地库存由服务端维护，相对业务日起点显示变化量</h3>
            </div>
            <div class="admin-toolbar">
              <label class="admin-field admin-field--inline">
                <span class="admin-field__label">货门</span>
                <select v-model="selectedDoorNum" class="admin-select">
                  <option v-for="door in detail.device.doors" :key="door.doorNum" :value="door.doorNum">
                    {{ door.label }} / {{ door.doorNum }}
                  </option>
                </select>
              </label>
              <button v-if="canManageGoods" class="admin-button admin-button--ghost" :disabled="syncing" @click="syncGoods">
                {{ syncing ? "同步中" : "同步货品种类" }}
              </button>
            </div>
          </div>

          <div v-if="canManageDevice" class="device-goods-toolbar">
            <label class="admin-field admin-field--inline device-goods-toolbar__field">
              <span class="admin-field__label">新增货品</span>
              <select v-model="selectedGoodsToAdd" class="admin-select">
                <option value="">请选择货品</option>
                <option v-for="item in addableGoodsOptions" :key="item.goodsId" :value="item.goodsId">
                  {{ item.name }} / {{ item.goodsCode }}
                </option>
              </select>
            </label>
            <button class="admin-button" :disabled="addingGoods || !selectedGoodsToAdd" @click="addGoods">
              {{ addingGoods ? "加入中" : "加入柜机" }}
            </button>
            <span class="admin-copy">零库存且已移除的货品将不再显示；未开启阈值时即使库存为 0 也不会触发缺货提醒。</span>
          </div>

          <div class="device-table-scroll">
            <table class="admin-table">
              <thead>
                <tr>
                  <th>货品</th>
                  <th>分类</th>
                  <th>库存</th>
                  <th>今日变化</th>
                  <th>临期</th>
                  <th>操作</th>
                </tr>
              </thead>
              <tbody>
                <tr v-for="goods in selectedDoorGoods" :key="goods.goodsId">
                  <td>
                    <span class="admin-table__strong">{{ goods.name }}</span>
                    <span class="admin-table__subtext">{{ goods.goodsId }}</span>
                  </td>
                  <td>{{ categoryLabelMap[goods.category] ?? goods.category }}</td>
                  <td class="admin-code">{{ formatGoodsStock(goods) }}</td>
                  <td>
                    <span
                      class="admin-pill"
                      :class="(stockChangeMap.get(goods.goodsId)?.deltaSinceStartOfBusinessDay ?? 0) >= 0 ? 'admin-pill--success' : 'admin-pill--warning'"
                    >
                      {{ (stockChangeMap.get(goods.goodsId)?.deltaSinceStartOfBusinessDay ?? 0) >= 0 ? "+" : "" }}{{ stockChangeMap.get(goods.goodsId)?.deltaSinceStartOfBusinessDay ?? 0 }}
                    </span>
                  </td>
                  <td class="admin-code">
                    {{ formatDate(goods.expiresAt) }}
                  </td>
                  <td>
                    <button
                      v-if="canManageDevice && goods.stock <= 0"
                      class="admin-button admin-button--ghost"
                      :disabled="removingGoodsId === goods.goodsId"
                      @click="removeGoods(goods.goodsId)"
                    >
                      {{ removingGoodsId === goods.goodsId ? "移除中" : "移除" }}
                    </button>
                    <span v-else class="admin-table__subtext">{{ canManageDevice ? "库存未清零" : "无柜机资料管理权限" }}</span>
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
        </article>

        <aside class="admin-grid device-detail__aside">
          <article class="admin-panel admin-panel-block">
            <div class="admin-panel__head">
              <div>
                <span class="admin-kicker">地图位置</span>
                <h3 class="admin-panel__title">保存柜机坐标后，移动端会按距离排序</h3>
              </div>
              <button v-if="canManageDevice" class="admin-button admin-button--ghost" :disabled="updatingLocation" @click="mapPickerVisible = true">
                {{ updatingLocation ? "保存中" : "设置位置" }}
              </button>
            </div>
            <div class="admin-kv">
              <div class="admin-kv__row">
                <span class="admin-kv__label">位置说明</span>
                <span class="admin-kv__value">{{ detail.device.location }}</span>
              </div>
              <div class="admin-kv__row">
                <span class="admin-kv__label">坐标</span>
                <span class="admin-kv__value admin-code">
                  {{
                    detail.device.longitude !== undefined && detail.device.latitude !== undefined
                      ? `${detail.device.longitude.toFixed(6)}, ${detail.device.latitude.toFixed(6)}`
                      : "未设置"
                  }}
                </span>
              </div>
            </div>
          </article>

          <article class="admin-panel admin-panel-block">
            <div class="admin-panel__head">
              <div>
                <span class="admin-kicker">今日服务人员</span>
                <h3 class="admin-panel__title">业务日 {{ detail.businessDateKey }} 内的领取 / 补货情况</h3>
              </div>
            </div>
            <div v-if="businessDayServedUsers.length" class="device-served-list">
              <article v-for="entry in businessDayServedUsers" :key="entry.userId" class="device-served-card">
                <div class="device-served-card__head">
                  <RouterLink class="admin-link" :to="`/users/${entry.userId}`">{{ entry.userName }}</RouterLink>
                  <span class="admin-badge">{{ formatUserRole(entry.role) }}</span>
                </div>
                <dl class="device-served-card__details">
                  <div>
                    <dt>商品</dt>
                    <dd>{{ entry.goodsSummary }}</dd>
                  </div>
                  <div>
                    <dt>总数量</dt>
                    <dd class="admin-code">{{ entry.totalQuantity }}</dd>
                  </div>
                  <div>
                    <dt>最近时间</dt>
                    <dd class="admin-code">{{ formatDateTime(entry.lastServedAt) }}</dd>
                  </div>
                </dl>
              </article>
            </div>
            <div v-else class="admin-empty">
              <div class="admin-empty__title">今日还没有人员操作这台柜机</div>
              <div class="admin-empty__body">领取、补货和手工补扣都会在这里汇总。</div>
            </div>
          </article>

          <article class="admin-panel admin-panel-block">
            <div class="admin-panel__head">
              <div>
                <span class="admin-kicker">控制区</span>
                <h3 class="admin-panel__title">主动刷新与远程开门</h3>
              </div>
            </div>
            <div class="device-detail-actions">
              <button v-if="canOperateDevice" class="admin-button admin-button--ghost" :disabled="refreshing" @click="refreshDevice">
                {{ refreshing ? "刷新中" : "立即刷新" }}
              </button>
              <button v-if="canOperateDevice" class="admin-button" :disabled="remoteOpenDisabled" @click="remoteOpen">
                {{ remoteOpening ? "下发中" : remoteOpenBlockedHint ? "暂不可开门" : "远程开门" }}
              </button>
              <button
                v-if="doorNeedsPhysicalConfirmation"
                class="admin-button admin-button--ghost"
                :disabled="confirmingDoorClosed"
                @click="openDoorClosedDialog"
              >
                {{ confirmingDoorClosed ? "确认中" : "现场确认全部柜门已关闭" }}
              </button>
              <span v-if="!canOperateDevice" class="admin-table__subtext">当前账号没有柜机操作权限。</span>
            </div>
            <div class="admin-note">
              平台识别只证明凭据与设备编号有效，不代表柜机物理在线。上一条开门结果未知时，系统会持续阻止重复下发；只有可信关门回调或现场确认才能解除。
            </div>
            <div v-if="canOperateDevice && remoteOpenBlockedHint" class="admin-alert admin-alert--danger" role="alert">
              {{ remoteOpenBlockedHint }}
              <button v-if="!deviceCanOpen" class="admin-text-button" type="button" :disabled="refreshing" @click="refreshDevice">
                {{ refreshing ? "刷新中" : "立即刷新状态" }}
              </button>
            </div>
          </article>

          <article class="admin-panel admin-panel-block">
            <div class="admin-panel__head">
              <div>
                <span class="admin-kicker">待处理任务</span>
                <h3 class="admin-panel__title">故障、缺货、反馈统一处理</h3>
              </div>
            </div>
            <div v-if="pendingTasks.length" class="admin-list">
              <div v-for="task in pendingTasks" :key="task.id" class="admin-list__row">
                <div class="admin-list__main">
                  <span class="admin-list__title">{{ task.title }}</span>
                  <span class="admin-context-main">{{ taskContextSummary(task) }}</span>
                  <span class="admin-list__meta">
                    {{ taskGradeLabel(task.grade) }} · {{ task.status === "acknowledged" ? "已知晓" : "待处理" }} · 发生 {{ formatDateTime(task.createdAt) }}
                  </span>
                  <span class="admin-table__subtext">应处理：{{ formatDateTime(task.dueAt) }}</span>
                  <span class="admin-table__subtext">{{ task.previewDetail || task.detail }}</span>
                  <span v-if="taskIdentitySummary(task)" class="admin-context-meta admin-code">{{ taskIdentitySummary(task) }}</span>
                  <span v-if="taskReferenceSummary(task)" class="admin-context-meta admin-code">{{ taskReferenceSummary(task) }}</span>
                </div>
                <div class="device-task-actions">
                  <RouterLink
                    v-if="canRecoverManualSettlement && task.title === '结算回调超时待补记' && task.targetUserId && task.relatedEventId"
                    class="admin-button admin-button--ghost"
                    :to="{ path: `/users/${task.targetUserId}`, query: { manualSettlementEventId: task.relatedEventId } }"
                  >
                    处理缺失结算
                  </RouterLink>
                  <button
                    v-if="canManageAlerts && task.status === 'open' && task.title !== '结算回调超时待补记'"
                    class="admin-button admin-button--ghost"
                    :disabled="resolvingTaskId === task.id"
                    @click="resolveTask(task.id)"
                  >
                    {{ resolvingTaskId === task.id ? "处理中" : taskActionLabel(task) }}
                  </button>
                  <span v-else-if="task.title !== '结算回调超时待补记'" class="admin-table__subtext">{{ task.status === "open" ? "需要预警处理权限" : "已知晓" }}</span>
                  <span v-else-if="!canRecoverManualSettlement" class="admin-table__subtext">需要实例管理员同时具备柜机操作和库存调整权限</span>
                  <RouterLink class="admin-link" :to="`/logs?subjectType=alert&subjectId=${task.id}`">日志</RouterLink>
                </div>
              </div>
            </div>
            <div v-else class="admin-empty">
              <div class="admin-empty__title">当前没有待处理任务</div>
              <div class="admin-empty__body">低库存、长时间敞门和用户反馈会显示在这里。</div>
            </div>
          </article>

          <article class="admin-panel admin-panel-block">
            <div class="admin-panel__head">
              <div>
                <span class="admin-kicker">最近开柜事件</span>
                <h3 class="admin-panel__title">按事件分组查看，一次开门下的补扣单单独列出</h3>
              </div>
            </div>
            <div v-if="recentEvents.length" class="device-event-list">
              <article v-for="event in recentEvents" :key="event.eventId" class="device-event-card">
                <div class="device-event-card__head">
                  <div class="device-event-card__title-wrap">
                    <span class="admin-table__strong">{{ summarizeEventGoods(event) }}</span>
                    <span class="admin-table__subtext">
                      用户 {{ resolveEventUserLabel(event) }} · {{ formatUserRole(event.role) }} · {{ formatEventStatus(event.status) }} · {{ formatDateTime(event.updatedAt) }}
                    </span>
                    <span class="admin-context-meta admin-code">事件 {{ event.eventId }}</span>
                  </div>
                  <RouterLink class="admin-link" :to="`/logs?subjectType=event&subjectId=${event.eventId}`">
                    查看关联日志
                  </RouterLink>
                </div>

                <div class="device-event-order-row">
                  <div class="device-event-order-row__kind">
                    <span class="admin-pill admin-pill--neutral">原始订单</span>
                  </div>
                  <div class="device-event-order-row__main">
                    <span class="admin-table__strong">原始订单 {{ event.orderNo }}</span>
                    <span class="admin-table__subtext">
                      用户 {{ resolveEventUserLabel(event) }} · {{ summarizeEventGoods(event) }}
                    </span>
                    <span class="admin-table__subtext">{{ formatOrderSyncStatus(event, "original") }}</span>
                    <span v-if="event.paymentNotifyMessage" class="admin-table__subtext">{{ event.paymentNotifyMessage }}</span>
                    <span v-if="event.refundNo || event.refundTransactionId" class="admin-table__subtext">
                      {{ event.refundNo ? `退款单 ${event.refundNo}` : "" }}{{ event.refundNo && event.refundTransactionId ? " / " : "" }}{{ event.refundTransactionId ? `交易号 ${event.refundTransactionId}` : "" }}
                    </span>
                  </div>
                  <div class="device-event-order-row__actions">
                    <RouterLink
                      v-if="canRecoverManualSettlement && event.role === 'special' && event.userId && (Boolean(event.manualSettlement) || manualSettlementTaskEventIds.has(event.eventId))"
                      class="admin-button admin-button--ghost"
                      :to="{ path: `/users/${event.userId}`, query: { manualSettlementEventId: event.eventId } }"
                    >
                      {{ event.manualSettlement ? "查看人工结算补记" : "处理缺失结算" }}
                    </RouterLink>
                    <button
                      v-if="canRecoverZeroCostCompletion(event)"
                      class="admin-button admin-button--ghost"
                      :disabled="Boolean(completingZeroCostEventId)"
                      @click="recoverZeroCostCompletion(event)"
                    >
                      {{ completingZeroCostEventId === event.eventId ? "回写中" : isClosedZeroCostRestockWithoutSettlement(event) ? "结束零元补货订单" : event.billingStatus === "mismatch" || event.billingStatus === "blocked" ? "核对并结束订单" : "重试完成回写" }}
                    </button>
                    <button
                      v-if="canManualPaymentSuccess && shouldShowPaymentAction(event)"
                      class="admin-button admin-button--ghost"
                      :disabled="notifyingPaymentOrderNo === event.orderNo || isFinancialOutcomePending('payment', event.orderNo)"
                      @click="notifyPaymentSuccess(event)"
                    >
                      {{ notifyingPaymentOrderNo === event.orderNo ? "回写中" : isFinancialOutcomePending('payment', event.orderNo) ? "结果待确认" : paymentActionLabel(event) }}
                    </button>
                    <button
                      v-if="canRefundPayments && shouldShowRefundAction(event)"
                      class="admin-button admin-button--ghost"
                      :disabled="refundingOrderNo === event.orderNo || (isFinancialOutcomePending('refund', event.orderNo) && !findPersistedPendingRefund(event.orderNo)) || Boolean(resolvePlatformOrderContext(event, 'refund').refundedAt)"
                      @click="refundEvent(event)"
                    >
                      {{ refundingOrderNo === event.orderNo ? "退款中" : findPersistedPendingRefund(event.orderNo) ? "核对退款状态" : isFinancialOutcomePending('refund', event.orderNo) ? "结果待确认" : resolvePlatformOrderContext(event, 'refund').refundedAt ? "已退款" : refundActionLabel(event) }}
                    </button>
                    <span
                      v-if="!canRecoverZeroCostCompletion(event) && (!canManualPaymentSuccess || !shouldShowPaymentAction(event)) && (!canRefundPayments || !shouldShowRefundAction(event))"
                      class="admin-table__subtext"
                    >
                      当前没有待平台确认动作或权限不足
                    </span>
                  </div>
                </div>

                <div
                  v-for="adjustment in getEventAdjustments(event)"
                  :key="`${event.eventId}-${adjustment.orderNo}`"
                  class="device-event-order-row device-event-order-row--adjustment"
                >
                  <div class="device-event-order-row__kind">
                    <span class="admin-pill admin-pill--warning">补扣单</span>
                  </div>
                  <div class="device-event-order-row__main">
                    <span class="admin-table__strong">补扣单 {{ adjustment.orderNo }}</span>
                    <span class="admin-table__subtext">
                      {{
                        adjustment.goods?.length
                          ? `用户 ${resolveEventUserLabel(event)} · ${adjustment.goods.map((goods) => `${goods.goodsName} ×${goods.quantity}`).join("；")}`
                          : "未记录补扣货品"
                      }}
                    </span>
                    <span class="admin-table__subtext">{{ formatOrderSyncStatus(adjustment, "adjustment") }}</span>
                    <span class="admin-table__subtext">金额 {{ adjustment.amount ?? 0 }} 分 · {{ formatDateTime(adjustment.updatedAt ?? adjustment.createdAt) }}</span>
                    <span
                      v-if="adjustment.refundNo || adjustment.refundTransactionId"
                      class="admin-table__subtext"
                    >
                      {{ adjustment.refundNo ? `退款单 ${adjustment.refundNo}` : "" }}{{ adjustment.refundNo && adjustment.refundTransactionId ? " / " : "" }}{{ adjustment.refundTransactionId ? `交易号 ${adjustment.refundTransactionId}` : "" }}
                    </span>
                  </div>
                  <div class="device-event-order-row__actions">
                    <button
                      v-if="canManualPaymentSuccess && shouldShowPaymentAction(event, adjustment.orderNo)"
                      class="admin-button admin-button--ghost"
                      :disabled="notifyingPaymentOrderNo === adjustment.orderNo || isFinancialOutcomePending('payment', adjustment.orderNo)"
                      @click="notifyPaymentSuccess(event, adjustment.orderNo)"
                    >
                      {{ notifyingPaymentOrderNo === adjustment.orderNo ? "回写中" : isFinancialOutcomePending('payment', adjustment.orderNo) ? "结果待确认" : paymentActionLabel(event, adjustment.orderNo) }}
                    </button>
                    <button
                      v-if="canRefundPayments && shouldShowRefundAction(event, adjustment.orderNo)"
                      class="admin-button admin-button--ghost"
                      :disabled="refundingOrderNo === adjustment.orderNo || (isFinancialOutcomePending('refund', adjustment.orderNo) && !findPersistedPendingRefund(adjustment.orderNo)) || Boolean(resolvePlatformOrderContext(event, 'refund', adjustment.orderNo).refundedAt)"
                      @click="refundEvent(event, adjustment.orderNo)"
                    >
                      {{ refundingOrderNo === adjustment.orderNo ? "退款中" : findPersistedPendingRefund(adjustment.orderNo) ? "核对退款状态" : isFinancialOutcomePending('refund', adjustment.orderNo) ? "结果待确认" : resolvePlatformOrderContext(event, 'refund', adjustment.orderNo).refundedAt ? "已退款" : refundActionLabel(event, adjustment.orderNo) }}
                    </button>
                    <span
                      v-if="(!canManualPaymentSuccess || !shouldShowPaymentAction(event, adjustment.orderNo)) && (!canRefundPayments || !shouldShowRefundAction(event, adjustment.orderNo))"
                      class="admin-table__subtext"
                    >
                      当前没有待平台确认动作或权限不足
                    </span>
                  </div>
                </div>
              </article>
            </div>
            <div v-else class="admin-empty">
              <div class="admin-empty__title">{{ loading ? "正在加载事件" : "当前没有开柜事件" }}</div>
              <div class="admin-empty__body">远程开门、用户取货和商家补货都会在这里记录。</div>
            </div>
          </article>
        </aside>
      </section>

      <section v-if="canViewDebugPanel" class="admin-page__section">
        <div class="admin-page__section-head">
          <div>
            <p class="admin-kicker">底层调试</p>
            <h3 class="admin-page__section-title">默认忽略柜机底层操作，只有排查平台联调问题时再展开</h3>
          </div>
          <div class="admin-toolbar">
            <button class="admin-button admin-button--ghost" @click="toggleDebugPanel">
              {{ debugPanelVisible ? "收起底层调试" : "查看底层调试" }}
            </button>
            <button
              v-if="debugPanelVisible"
              class="admin-button admin-button--ghost"
              :disabled="debugLoading"
              @click="loadDebugPanel"
            >
              {{ debugLoading ? "刷新中" : "刷新调试信息" }}
            </button>
          </div>
        </div>

        <article v-if="debugPanelVisible" class="admin-panel admin-panel-block">
          <div class="debug-grid">
            <section v-if="canViewSystemAudit" class="debug-panel">
              <div class="debug-panel__head">
                <h4 class="debug-panel__title">平台外呼与系统审计</h4>
                <label class="admin-field admin-field--inline debug-panel__limit">
                  <span class="admin-field__label">显示条数</span>
                  <select v-model="debugAuditLimit" class="admin-select" @change="loadDebugPanel">
                    <option :value="50">50</option>
                    <option :value="100">100</option>
                    <option :value="200">200</option>
                  </select>
                </label>
              </div>
              <div v-if="debugSystemAuditRows.length" class="debug-list">
                <article v-for="entry in debugSystemAuditRows" :key="`${entry.occurredAt}-${entry.path}`" class="debug-card">
                  <div class="debug-card__meta">
                    <span class="admin-code">{{ formatDateTimeSeconds(entry.occurredAt) }}</span>
                    <span class="admin-pill" :class="getAuditDirection(entry) === '发' ? 'admin-pill--success' : 'admin-pill--neutral'">
                      {{ getAuditDirection(entry) }}
                    </span>
                    <span class="admin-pill admin-pill--neutral">{{ getAuditLabel(entry) }}</span>
                    <span class="admin-pill" :class="entry.statusCode >= 500 ? 'admin-pill--danger' : entry.statusCode >= 400 ? 'admin-pill--warning' : 'admin-pill--success'">
                      {{ entry.statusCode }}
                    </span>
                    <span class="debug-card__route">{{ getAuditSource(entry) }} → {{ getAuditTarget(entry) }}</span>
                  </div>
                  <div class="debug-card__endpoint">
                    <span class="admin-table__subtext">接口路径：{{ entry.path }}</span>
                    <span v-if="getAuditRequestUrl(entry)" class="admin-table__subtext">目标地址：{{ getAuditRequestUrl(entry) }}</span>
                  </div>
                  <p v-if="entry.error?.message" class="debug-card__error">错误：{{ entry.error.message }}</p>
                  <div class="debug-card__payload-grid">
                    <section class="debug-card__payload-panel">
                      <div class="debug-card__payload-title">{{ getAuditRequestLabel(entry) }}</div>
                      <pre class="debug-card__pre">{{ formatDebugPayload(entry.body) }}</pre>
                    </section>
                    <section class="debug-card__payload-panel">
                      <div class="debug-card__payload-title">{{ getAuditResponseLabel(entry) }}</div>
                      <pre class="debug-card__pre">{{ formatDebugPayload(entry.response ?? entry.error) }}</pre>
                    </section>
                  </div>
                </article>
              </div>
              <div v-else class="admin-empty">
                <div class="admin-empty__title">{{ debugLoading ? "正在加载系统审计" : "暂无底层系统审计" }}</div>
                <div class="admin-empty__body">这里会显示后端发给平台和平台发给后端的接口记录，并标出收/发方向。</div>
              </div>
            </section>

            <section v-if="canViewCallbackLogs" class="debug-panel">
              <div class="debug-panel__head">
                <h4 class="debug-panel__title">平台回调安全摘要</h4>
                <label class="admin-field admin-field--inline debug-panel__limit">
                  <span class="admin-field__label">显示条数</span>
                  <select v-model="debugCallbackLimit" class="admin-select" @change="loadDebugPanel">
                    <option :value="50">50</option>
                    <option :value="100">100</option>
                    <option :value="200">200</option>
                  </select>
                </label>
              </div>
              <div v-if="debugCallbackLogs.length" class="debug-list">
                <article v-for="entry in debugCallbackLogs" :key="entry.id" class="debug-card">
                  <div class="debug-card__meta">
                    <span class="admin-code">{{ formatDateTimeSeconds(entry.receivedAt) }}</span>
                    <span class="admin-pill admin-pill--neutral">收</span>
                    <span class="admin-pill admin-pill--neutral">{{ formatCallbackTypeLabel(entry.type) }}</span>
                    <span class="debug-card__route">平台 → 后端</span>
                  </div>
                  <div class="debug-card__payload-panel">
                    <div class="debug-card__payload-title">收到内容</div>
                    <pre class="debug-card__pre">{{ formatDebugPayload(entry.payload) }}</pre>
                  </div>
                </article>
              </div>
              <div v-else class="admin-empty">
                <div class="admin-empty__title">{{ debugLoading ? "正在加载回调记录" : "暂无相关回调" }}</div>
                <div class="admin-empty__body">这里仅显示门状态、结算、补扣、退款等平台回推的脱敏摘要。</div>
              </div>
            </section>
          </div>
        </article>
      </section>

      <section class="admin-page__section">
        <div class="admin-page__section-head">
          <div>
            <p class="admin-kicker">柜机日志</p>
            <h3 class="admin-page__section-title">查看该柜机的全部关键操作和异常</h3>
          </div>
          <RouterLink class="admin-link" :to="`/logs?subjectType=device&subjectId=${detail.device.deviceCode}`">进入日志总览</RouterLink>
        </div>

        <article class="admin-panel admin-panel-block">
          <div v-if="recentLogs.length" class="device-table-scroll">
            <table class="admin-table">
              <thead>
                <tr>
                  <th>时间</th>
                  <th>动作</th>
                  <th>业务对象</th>
                  <th>状态</th>
                  <th>详情</th>
                </tr>
              </thead>
              <tbody>
                <tr v-for="log in recentLogs" :key="log.id">
                  <td class="admin-code">{{ formatDateTime(log.occurredAt) }}</td>
                  <td>
                    <span class="admin-table__strong">{{ log.description }}</span>
                    <span class="admin-table__subtext">{{ log.actor.name }} · {{ formatActorTypeLabel(log.actor.type) }} · {{ formatLogCategoryLabel(log.category) }} · {{ log.type }}</span>
                  </td>
                  <td>
                    <span class="admin-context-main">{{ logContextSummary(log) }}</span>
                    <span v-if="logSubjectSummary(log)" class="admin-context-meta">{{ logSubjectSummary(log) }}</span>
                    <span v-if="logReferenceSummary(log)" class="admin-context-meta admin-code">{{ logReferenceSummary(log) }}</span>
                  </td>
                  <td>
                    <span class="admin-pill" :class="log.status === 'warning' ? 'admin-pill--warning' : log.status === 'failed' ? 'admin-pill--danger' : log.status === 'success' ? 'admin-pill--success' : 'admin-pill--neutral'">
                      {{ formatLogStatus(log.status) }}
                    </span>
                  </td>
                  <td>
                    <span class="admin-table__subtext">{{ log.detail }}</span>
                    <RouterLink class="admin-link" :to="`/logs/${log.id}`">详情</RouterLink>
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
          <div v-else class="admin-empty">
            <div class="admin-empty__title">当前没有柜机日志</div>
            <div class="admin-empty__body">刷新、远程开门、故障回调和货品流转会自动记录在这里。</div>
          </div>
        </article>
      </section>
    </section>

    <dialog
      v-if="remoteOpenDialogStep"
      ref="remoteOpenDialog"
      class="remote-open-dialog admin-panel"
      role="dialog"
      aria-modal="true"
      aria-labelledby="remote-open-dialog-title"
      aria-describedby="remote-open-dialog-description"
      @cancel.prevent="closeRemoteOpenDialog"
    >
      <header class="remote-open-dialog__head">
        <div>
          <p class="admin-kicker">高风险操作 · 第 {{ remoteOpenDialogStep === "reason" ? 1 : 2 }} 步，共 2 步</p>
          <h2 id="remote-open-dialog-title" class="remote-open-dialog__title">
            {{ remoteOpenDialogStep === "reason" ? "填写远程开门原因" : "最后核对开门信息" }}
          </h2>
        </div>
        <button
          type="button"
          class="admin-button admin-button--ghost"
          :disabled="remoteOpening"
          aria-label="关闭远程开门对话框"
          @click="closeRemoteOpenDialog"
        >
          取消
        </button>
      </header>

      <div v-if="remoteOpenDialogStep === 'reason'" class="remote-open-dialog__body">
          <p id="remote-open-dialog-description" class="admin-copy">
            原因会随操作写入审计日志，不能为空。
          </p>
          <label class="admin-field">
            <span class="admin-field__label">操作原因（必填）</span>
            <textarea
              ref="remoteOpenReasonInput"
              v-model="remoteOpenReason"
              class="admin-input remote-open-dialog__reason"
              placeholder="例如：现场工作人员来电确认柜门卡滞，需远程开门排查"
              @keydown.ctrl.enter.prevent="continueRemoteOpen"
            />
          </label>
          <div class="remote-open-dialog__reason-meta">
            <span class="admin-table__subtext">Ctrl + Enter 可继续</span>
          </div>
          <div class="admin-note">此步骤不会向柜机发送任何请求。</div>
          <div class="remote-open-dialog__actions">
            <button type="button" class="admin-button admin-button--ghost" @click="closeRemoteOpenDialog">取消</button>
            <button
              type="button"
              class="admin-button"
              :disabled="!remoteOpenReason.trim()"
              @click="continueRemoteOpen"
            >
              下一步：核对信息
            </button>
          </div>
      </div>

      <div v-else class="remote-open-dialog__body">
          <p id="remote-open-dialog-description" class="admin-copy">
            请逐项核对。点击“确认并立即下发”后，系统会立刻向柜机发送开门指令。
          </p>
          <dl class="remote-open-dialog__summary">
            <div>
              <dt>柜机</dt>
              <dd>{{ remoteOpenDeviceSummary }}</dd>
            </div>
            <div>
              <dt>货门</dt>
              <dd>{{ selectedDoorNum }}号门</dd>
            </div>
            <div>
              <dt>当前门状态</dt>
              <dd>{{ formatDoorState(detail?.runtime.doorState) }}</dd>
            </div>
            <div>
              <dt>操作原因</dt>
              <dd>{{ remoteOpenReason }}</dd>
            </div>
          </dl>
          <div class="admin-alert admin-alert--danger">
            这是实际开门动作。若设备、货门或现场授权有任何疑问，请返回修改或取消。
          </div>
          <div
            v-if="remoteOpenSubmitError"
            class="admin-alert admin-alert--danger"
            role="alert"
            aria-live="assertive"
            aria-atomic="true"
          >
            {{ remoteOpenSubmitError }}
          </div>
          <div class="remote-open-dialog__actions">
            <button
              v-if="remoteOpenOutcomePending"
              ref="remoteOpenSafeButton"
              type="button"
              class="admin-button"
              @click="closeRemoteOpenDialog"
            >
              关闭并查看最新状态
            </button>
            <template v-else>
              <button ref="remoteOpenSafeButton" type="button" class="admin-button admin-button--ghost" :disabled="remoteOpening" @click="returnToRemoteOpenReason">
                返回修改
              </button>
              <button type="button" class="admin-button admin-button--danger" :disabled="remoteOpening" @click="confirmRemoteOpen">
                {{ remoteOpening ? "正在下发" : "确认并立即下发" }}
              </button>
            </template>
          </div>
      </div>
    </dialog>

    <dialog
      ref="doorClosedDialog"
      class="remote-open-dialog admin-panel"
      role="dialog"
      aria-modal="true"
      aria-labelledby="door-closed-dialog-title"
      aria-describedby="door-closed-dialog-description"
      @cancel.prevent="closeDoorClosedDialog"
    >
      <header class="remote-open-dialog__head">
        <div>
          <p class="admin-kicker">现场状态确认</p>
          <h2 id="door-closed-dialog-title" class="remote-open-dialog__title">确认全部柜门均已关闭</h2>
        </div>
        <button
          type="button"
          class="admin-button admin-button--ghost"
          :disabled="confirmingDoorClosed"
          aria-label="关闭现场状态确认对话框"
          @click="closeDoorClosedDialog"
        >
          取消
        </button>
      </header>
      <div class="remote-open-dialog__body">
        <p id="door-closed-dialog-description" class="admin-copy">
          仅在现场或视频已经确认这台柜机的全部柜门均已关闭时继续。
        </p>
        <div class="admin-alert admin-alert--danger">
          此操作会协调该柜机全部未决开门记录并写入审计日志，不能撤销；它不会向柜机发送开门指令。
        </div>
        <div
          v-if="doorClosedSubmitError"
          class="admin-alert admin-alert--danger"
          role="alert"
          aria-live="assertive"
          aria-atomic="true"
        >
          {{ doorClosedSubmitError }}
        </div>
        <div class="remote-open-dialog__actions">
          <button
            ref="doorClosedSafeButton"
            type="button"
            class="admin-button admin-button--ghost"
            :disabled="confirmingDoorClosed"
            @click="closeDoorClosedDialog"
          >
            返回核对
          </button>
          <button
            type="button"
            class="admin-button admin-button--danger"
            :disabled="confirmingDoorClosed"
            @click="confirmDoorClosed"
          >
            {{ confirmingDoorClosed ? "正在记录" : "确认全部柜门已关闭" }}
          </button>
        </div>
      </div>
    </dialog>

    <dialog
      v-if="financialAction"
      ref="financialDialog"
      class="remote-open-dialog financial-action-dialog admin-panel"
      role="dialog"
      aria-modal="true"
      aria-labelledby="financial-action-dialog-title"
      aria-describedby="financial-action-dialog-description"
      @cancel.prevent="closeFinancialDialog"
    >
      <header class="remote-open-dialog__head">
        <div>
          <p class="admin-kicker">
            {{ financialAction.kind === "refund" ? "退款申请" : "付款状态回写" }} ·
            第 {{ financialAction.step === "input" ? 1 : 2 }} 步，共 2 步
          </p>
          <h2 id="financial-action-dialog-title" class="remote-open-dialog__title">
            {{
              financialAction.step === "input"
                ? `填写${financialAction.kind === "payment" ? "付款回写" : "退款"}信息`
                : financialAction.kind === "payment"
                  ? "最后核对付款回写信息"
                  : "最后核对退款信息"
            }}
          </h2>
        </div>
        <button
          type="button"
          class="admin-button admin-button--ghost"
          :disabled="Boolean(notifyingPaymentOrderNo || refundingOrderNo || reconcilingRefundId)"
          :aria-label="financialAction.kind === 'refund' ? '关闭退款对话框' : '关闭付款回写对话框'"
          @click="closeFinancialDialog"
        >
          {{ isCurrentFinancialOutcomePending ? "关闭并刷新" : "取消" }}
        </button>
      </header>

      <div
        v-if="financialAction.step === 'input'"
        class="remote-open-dialog__body"
        @keydown.ctrl.enter.prevent="continueFinancialAction"
      >
        <p id="financial-action-dialog-description" class="admin-copy">
          {{
            financialAction.kind === "refund"
              ? "将基于原付款交易发起退款。系统生成的操作请求编号和退款金额会写入审计记录，请核对原交易与退款金额。"
              : "订单和金额来自当前业务记录。交易号会进入审计记录，请只填写支付渠道中的真实编号。"
          }}
        </p>
        <label class="admin-field">
          <span class="admin-field__label">
            {{ financialAction.kind === "refund" ? "支付渠道原交易号（只读）" : "支付渠道交易号（必填）" }}
          </span>
          <input
            ref="financialPrimaryInput"
            v-model="financialAction.transactionId"
            class="admin-input"
            type="text"
            maxlength="128"
            autocomplete="off"
            :readonly="financialAction.kind === 'refund'"
            :placeholder="financialAction.kind === 'refund' ? '原付款交易号由订单记录带入' : '请输入支付渠道返回的真实交易号'"
          />
          <span v-if="financialAction.kind === 'refund'" class="admin-table__subtext">退款必须绑定原付款交易号，不能在此修改。</span>
        </label>
        <label v-if="financialAction.kind === 'refund'" class="admin-field">
          <span class="admin-field__label">操作请求编号（幂等标识，只读）</span>
          <input
            v-model="financialAction.refundNo"
            class="admin-input"
            type="text"
            maxlength="128"
            autocomplete="off"
            readonly
          />
          <span class="admin-table__subtext">
            此编号是本次请求的幂等标识；支付渠道受理后的渠道退款号应由回调或查询记录。
          </span>
        </label>
        <label class="admin-field">
          <span class="admin-field__label">{{ financialAction.kind === "payment" ? "支付" : "退款" }}金额（分）</span>
          <input
            ref="financialAmountInput"
            v-model="financialAction.amountInput"
            class="admin-input"
            type="text"
            inputmode="numeric"
            autocomplete="off"
            readonly
          />
          <span class="admin-table__subtext">
            {{ financialAction.kind === "payment" ? "付款回写金额锁定为订单金额。" : `当前入口仅支持整单全额退款，金额锁定为 ${financialAction.expectedAmount ?? "未知"} 分。` }}
          </span>
        </label>
        <div v-if="financialSubmitError || financialInputError" class="admin-alert admin-alert--danger" role="alert">
          {{ financialSubmitError || financialInputError }}
        </div>
        <div class="admin-note">
          {{
            financialAction.kind === "refund"
              ? "此步骤只校验退款信息，不会发起退款请求。"
              : "此步骤只校验付款回写信息，不会回写付款状态。"
          }}
          Ctrl + Enter 可继续。
        </div>
        <div class="remote-open-dialog__actions">
          <button type="button" class="admin-button admin-button--ghost" @click="closeFinancialDialog">取消</button>
          <button type="button" class="admin-button" :disabled="Boolean(financialInputError)" @click="continueFinancialAction">
            下一步：核对信息
          </button>
        </div>
      </div>

      <div v-else class="remote-open-dialog__body">
        <p id="financial-action-dialog-description" class="admin-copy">
          {{
            isCurrentFinancialOutcomePending
              ? financialAction.kind === "refund" && financialAction.refundRecordId
                ? "退款请求已经发出，但结果尚未确认。可复用当前本地退款单向支付渠道主动核对；确认前不要重新发起退款。"
                : "请求已经发出，但结果尚未确认。请关闭并刷新订单状态；确认前不要重复提交。"
              : financialAction.kind === "refund"
                ? "请逐项核对。确认后会立即向支付渠道发起退款请求；如有不一致，请返回修改或取消。"
                : "请逐项核对。确认后会立即回写付款成功状态；如有不一致，请返回修改或取消。"
          }}
        </p>
        <dl class="remote-open-dialog__summary">
          <div>
            <dt>操作</dt>
            <dd>{{ financialAction.kind === "payment" ? `回写${financialAction.label}付款成功` : `发起${financialAction.label}退款` }}</dd>
          </div>
          <div>
            <dt>订单号</dt>
            <dd class="admin-code">{{ financialAction.orderNo }}</dd>
          </div>
          <div>
            <dt>事件 / 柜机</dt>
            <dd class="admin-code">{{ financialAction.event.eventId }} / {{ financialAction.event.deviceCode }}</dd>
          </div>
          <div>
            <dt>交易号</dt>
            <dd class="admin-code">{{ financialAction.transactionId.trim() }}</dd>
          </div>
          <div v-if="financialAction.kind === 'refund'">
            <dt>操作请求编号</dt>
            <dd class="admin-code">{{ financialAction.refundNo.trim() }}</dd>
          </div>
          <div>
            <dt>金额</dt>
            <dd><strong>{{ financialAmount }} 分（{{ (financialAmount / 100).toFixed(2) }} 元）</strong></dd>
          </div>
        </dl>
        <div v-if="financialSubmitError" class="admin-alert admin-alert--danger" role="alert">
          {{ financialSubmitError }}
        </div>
        <div v-if="!isCurrentFinancialOutcomePending" class="admin-alert admin-alert--danger">
          {{
            financialAction.kind === "refund"
              ? "这是实际退款动作。若订单、原付款交易号、操作请求编号或金额任一项不一致，请返回修改或取消。"
              : "这是实际付款状态回写动作。若订单、事件、交易号或金额任一项不一致，请返回修改或取消。"
          }}
        </div>
        <div class="remote-open-dialog__actions">
          <template v-if="isCurrentFinancialOutcomePending">
            <button
              v-if="financialAction.kind !== 'refund' || !financialAction.refundRecordId"
              ref="financialSafeButton"
              type="button"
              class="admin-button"
              :disabled="Boolean(reconcilingRefundId)"
              @click="closeFinancialDialog"
            >
              关闭并刷新订单
            </button>
            <template v-else>
              <button
                type="button"
                class="admin-button admin-button--ghost"
                :disabled="Boolean(reconcilingRefundId)"
                @click="closeFinancialDialog"
              >
                关闭并刷新订单
              </button>
              <button
                ref="financialSafeButton"
                type="button"
                class="admin-button"
                :disabled="Boolean(reconcilingRefundId)"
                @click="reconcilePendingRefund"
              >
                {{ reconcilingRefundId ? "正在向渠道核对" : "向支付渠道核对退款状态" }}
              </button>
            </template>
          </template>
          <template v-else>
            <button
              ref="financialSafeButton"
              type="button"
              class="admin-button admin-button--ghost"
              :disabled="Boolean(notifyingPaymentOrderNo || refundingOrderNo)"
              @click="returnToFinancialInput"
            >
              返回修改
            </button>
            <button
              type="button"
              class="admin-button admin-button--danger"
              :disabled="Boolean(notifyingPaymentOrderNo || refundingOrderNo)"
              @click="confirmFinancialAction"
            >
              {{ notifyingPaymentOrderNo || refundingOrderNo ? "正在提交" : financialAction.kind === "payment" ? "确认回写付款成功" : "确认发起退款" }}
            </button>
          </template>
        </div>
      </div>
    </dialog>

    <div v-if="mapPickerVisible" class="device-map-backdrop">
      <section class="device-map-panel admin-panel">
        <AmapLocationPicker
          :initial-longitude="detail.device.longitude"
          :initial-latitude="detail.device.latitude"
          :initial-location="detail.device.location"
          :initial-address="detail.device.address"
          @close="mapPickerVisible = false"
          @confirm="saveLocation"
        />
      </section>
    </div>
  </section>
</template>

<style scoped>
.device-detail-status {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
  gap: 8px;
}

.device-detail-status__item {
  display: grid;
  gap: 6px;
  padding: 10px 12px;
  border: 1px solid var(--admin-line);
  border-radius: 8px;
  background: var(--admin-panel-muted);
}

.device-detail__layout {
  grid-template-columns: minmax(0, 1.4fr) minmax(280px, 0.95fr);
  min-width: 0;
}

.device-detail__main,
.device-detail__aside,
.device-detail-status__item {
  min-width: 0;
}

.device-detail__aside {
  min-width: 0;
  align-content: start;
  overflow: hidden;
}

.device-detail__aside > * {
  min-width: 0;
}

.device-detail__main {
  overflow: hidden;
}

.device-detail-actions {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 8px;
}

.device-event-actions {
  display: grid;
  gap: 6px;
  min-width: 0;
}

.device-event-actions--nested {
  margin-top: 4px;
  padding-top: 6px;
  border-top: 1px dashed var(--admin-line);
}

.device-event-list {
  display: grid;
  gap: 12px;
}

.device-event-card {
  display: grid;
  gap: 10px;
  padding: 12px;
  border: 1px solid var(--admin-line);
  border-radius: 10px;
  background: var(--admin-panel-muted);
  min-width: 0;
}

.device-event-card__head {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  align-items: start;
  gap: 12px;
}

.device-event-card__title-wrap {
  display: grid;
  gap: 4px;
  min-width: 0;
}

.device-event-order-row {
  display: grid;
  grid-template-columns: 76px minmax(0, 1fr);
  gap: 12px;
  align-items: start;
  padding: 10px;
  border: 1px solid var(--admin-line);
  border-radius: 8px;
  background: #fff;
  min-width: 0;
}

.device-event-order-row--adjustment {
  border-style: dashed;
}

.device-event-order-row__kind,
.device-event-order-row__main,
.device-event-order-row__actions {
  min-width: 0;
}

.device-event-order-row__main,
.device-event-order-row__actions {
  display: grid;
  gap: 4px;
}

.device-event-order-row__actions {
  grid-column: 2;
  align-content: start;
  justify-items: start;
}

.device-goods-toolbar {
  display: grid;
  grid-template-columns: minmax(0, 320px) auto minmax(0, 1fr);
  gap: 10px;
  align-items: end;
  margin-bottom: 12px;
  min-width: 0;
}

.device-goods-toolbar__field {
  min-width: 0;
}

.device-goods-toolbar > * {
  min-width: 0;
}

.device-detail__aside :deep(.admin-kv__value),
.device-detail__aside :deep(.admin-table__subtext),
.device-detail__aside :deep(.admin-note) {
  overflow-wrap: anywhere;
  word-break: break-word;
}

.device-detail__aside :deep(.admin-link),
.device-detail__aside :deep(.admin-table__strong),
.device-detail__aside :deep(.admin-context-main),
.device-detail__aside :deep(.admin-context-meta),
.device-detail__aside :deep(.admin-list__title),
.device-detail__aside :deep(.admin-code) {
  overflow-wrap: anywhere;
  word-break: break-word;
}

.device-detail__aside :deep(.admin-list__row) {
  display: grid;
  grid-template-columns: minmax(0, 1fr) minmax(0, 104px);
  align-items: start;
  gap: 10px;
}

.device-detail__aside :deep(.admin-list__main) {
  min-width: 0;
}

.debug-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 14px;
  min-width: 0;
}

.debug-panel {
  display: grid;
  gap: 10px;
  min-width: 0;
}

.debug-panel__head {
  display: flex;
  align-items: end;
  justify-content: space-between;
  gap: 10px;
}

.debug-panel__limit {
  min-width: 110px;
}

.debug-panel__title {
  margin: 0;
  font-size: 14px;
  font-weight: 700;
  color: var(--admin-text);
}

.debug-list {
  display: grid;
  gap: 10px;
  max-height: 78vh;
  overflow: auto;
  padding-right: 4px;
}

.debug-card {
  display: grid;
  gap: 8px;
  padding: 12px;
  border: 1px solid var(--admin-line);
  border-radius: 8px;
  background: var(--admin-panel-muted);
}

.debug-card__meta {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  align-items: center;
}

.debug-card__route {
  font-size: 12px;
  color: var(--admin-text-muted);
}

.debug-card__endpoint {
  display: grid;
  gap: 4px;
}

.debug-card__error {
  margin: 0;
  color: #b42318;
  font-size: 13px;
}

.debug-card__payload-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 10px;
}

.debug-card__payload-panel {
  display: grid;
  gap: 6px;
  min-width: 0;
}

.debug-card__payload-title {
  font-size: 12px;
  font-weight: 700;
  color: var(--admin-text);
}

.debug-card__pre {
  margin: 0;
  padding: 10px;
  border-radius: 6px;
  background: #fff;
  border: 1px solid var(--admin-line);
  font-size: 12px;
  line-height: 1.5;
  white-space: pre-wrap;
  word-break: break-word;
  overflow: auto;
  max-height: 260px;
}

.device-task-actions {
  display: grid;
  justify-items: start;
  gap: 6px;
  min-width: 0;
  width: 100%;
}

.remote-open-dialog::backdrop {
  background: rgba(15, 23, 42, 0.5);
}

.remote-open-dialog {
  box-sizing: border-box;
  width: min(620px, calc(100% - 48px));
  max-height: calc(100vh - 48px);
  max-height: calc(100dvh - 48px);
  margin: auto;
  overflow: auto;
  overscroll-behavior: contain;
  gap: 18px;
  padding: 22px;
  border: 1px solid var(--admin-line);
  border-top: 4px solid #b42318;
  box-shadow: 0 22px 55px rgba(15, 23, 42, 0.28);
}

.remote-open-dialog[open] {
  display: grid;
}

.remote-open-dialog__head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 18px;
}

.remote-open-dialog__title {
  margin: 5px 0 0;
  color: var(--admin-text);
  font-size: 1.3rem;
}

.remote-open-dialog__body {
  display: grid;
  gap: 14px;
}

.remote-open-dialog__reason {
  min-height: 118px;
  resize: vertical;
  line-height: 1.6;
}

.remote-open-dialog__reason-meta,
.remote-open-dialog__actions {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
}

.remote-open-dialog__summary {
  display: grid;
  gap: 0;
  margin: 0;
  border: 1px solid var(--admin-line);
  border-radius: 8px;
  overflow: hidden;
}

.remote-open-dialog__summary > div {
  display: grid;
  grid-template-columns: 110px minmax(0, 1fr);
  gap: 14px;
  padding: 11px 13px;
  background: #fff;
}

.remote-open-dialog__summary > div + div {
  border-top: 1px solid var(--admin-line);
}

.remote-open-dialog__summary dt {
  color: var(--admin-text-muted);
  font-size: 13px;
  font-weight: 700;
}

.remote-open-dialog__summary dd {
  min-width: 0;
  margin: 0;
  color: var(--admin-text);
  line-height: 1.55;
  overflow-wrap: anywhere;
}

.device-map-backdrop {
  position: fixed;
  inset: 0;
  z-index: 30;
  display: grid;
  place-items: center;
  padding: 24px;
  background: rgba(15, 23, 42, 0.32);
}

.device-map-panel {
  width: min(960px, 100%);
  padding: 14px;
}

.device-table-scroll {
  min-width: 0;
  overflow-x: auto;
  overflow-y: hidden;
}

.device-table-scroll :deep(table) {
  min-width: 780px;
}

.device-served-list {
  display: grid;
  gap: 10px;
}

.device-served-card {
  display: grid;
  gap: 10px;
  padding: 12px;
  border: 1px solid var(--admin-line);
  border-radius: 8px;
  background: #fff;
}

.device-served-card__head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
}

.device-served-card__details {
  display: grid;
  gap: 8px;
  margin: 0;
}

.device-served-card__details > div {
  display: grid;
  grid-template-columns: 84px minmax(0, 1fr);
  gap: 10px;
}

.device-served-card__details dt {
  color: var(--admin-text-muted);
  font-size: 13px;
  font-weight: 700;
}

.device-served-card__details dd {
  min-width: 0;
  margin: 0;
  color: var(--admin-text);
  overflow-wrap: anywhere;
}

.financial-action-dialog .admin-input[readonly] {
  background: #f6f8fa;
  color: var(--admin-text-muted);
}

.admin-field--inline {
  min-width: 160px;
}

@media (max-width: 1600px) {
  .device-detail__layout {
    grid-template-columns: minmax(0, 1fr) minmax(300px, 380px);
  }
}

@media (max-width: 1280px) {
  .device-detail-status {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }

  .device-detail__layout {
    grid-template-columns: 1fr;
  }

  .device-goods-toolbar {
    grid-template-columns: 1fr;
  }

  .device-detail__aside :deep(.admin-list__row) {
    grid-template-columns: 1fr;
  }

  .debug-grid {
    grid-template-columns: 1fr;
  }

  .debug-card__payload-grid {
    grid-template-columns: 1fr;
  }

  .device-event-order-row {
    grid-template-columns: 1fr;
  }

  .device-event-order-row__actions {
    grid-column: auto;
  }
}

@media (max-width: 720px) {
  .device-detail-status,
  .device-detail-actions {
    grid-template-columns: 1fr;
  }

  .remote-open-dialog {
    width: calc(100% - 24px);
    max-height: calc(100vh - 24px);
    max-height: calc(100dvh - 24px);
    margin: auto auto 12px;
  }

  .remote-open-dialog__head,
  .remote-open-dialog__actions {
    align-items: stretch;
    flex-direction: column;
  }

  .remote-open-dialog__summary > div {
    grid-template-columns: 1fr;
    gap: 4px;
  }
}
</style>
