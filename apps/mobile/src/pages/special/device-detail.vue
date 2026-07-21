<script setup lang="ts">
import { computed, nextTick, reactive, ref } from "vue";
import { onLoad, onUnload } from "@dcloudio/uni-app";

import type {
  CabinetEventRecord,
  CabinetOpenRequest,
  CabinetPreSettlement,
  CabinetReservationRecord,
  DeviceRecord,
  GoodsCategory,
  ReservationSettings
} from "@vm/shared-types";

import { mobileApi } from "../../api/mobile";
import EmptyState from "../../components/ui/EmptyState.vue";
import FlowSteps from "../../components/ui/FlowSteps.vue";
import GlassCard from "../../components/ui/GlassCard.vue";
import MenuIcon from "../../components/ui/MenuIcon.vue";
import ServiceMetric from "../../components/ui/ServiceMetric.vue";
import MobileShell from "../../layouts/MobileShell.vue";
import { categoryLabelMap } from "../../constants/labels";
import { appCopy } from "../../constants/copy";
import { useSessionStore } from "../../stores/session";
import { useUiPreferencesStore } from "../../stores/ui-preferences";
import { formatBeijingShortDateTime } from "../../utils/datetime";
import { getDeviceStatusPresentation } from "../../utils/device-readiness";
import { getErrorMessage } from "../../utils/error-message";
import { isOpenOutcomeUncertain } from "../../utils/open-outcome";

const sessionStore = useSessionStore();
const uiPreferencesStore = useUiPreferencesStore();
const FAR_DISTANCE_WARNING_METERS = 500;
const loading = ref(false);
const submitting = ref(false);
const deviceCode = ref("");
const scanMode = ref(false);
const deviceName = ref("柜机详情");
const location = ref("");
const deviceAddress = ref("");
const deviceLongitude = ref<number>();
const deviceLatitude = ref<number>();
const currentDevice = ref<DeviceRecord>();
const manualDistanceMeters = ref<number>();
const manualDistanceState = ref<"near" | "far" | "unknown">("unknown");
const goodsList = ref<Array<{
  goodsCode: string;
  goodsId: string;
  name: string;
  price: number;
  imageUrl: string;
  category: GoodsCategory;
  stock?: number;
  expiresAt?: string;
}>>([]);
const selectedMap = reactive<Record<string, number>>({});
const preSettlement = ref<CabinetPreSettlement>();
const reservationSettings = ref<ReservationSettings>();
const reservations = ref<CabinetReservationRecord[]>([]);
const reservationFulfillmentIssue = ref<{ reservationId: string; message: string }>();
const openConfirmation = ref<{
  payload: CabinetOpenRequest;
  settlement?: CabinetPreSettlement;
  quoteId?: string;
  quoteExpiresAt?: string;
}>();
const openConfirmationDialog = ref<HTMLElement | { $el?: HTMLElement }>();
type OpenConfirmationDecision = "confirmed" | "cancelled" | "expired";
let openConfirmationResolver: ((decision: OpenConfirmationDecision) => void) | undefined;
let openConfirmationPreviousFocus: HTMLElement | undefined;
let openConfirmationExpiryTimer: ReturnType<typeof setTimeout> | undefined;
let pendingBillingPromptShown = false;

uiPreferencesStore.hydrate();

const selectedItems = computed(() =>
  goodsList.value
    .map((item) => ({
      goodsId: item.goodsId,
      goodsName: item.name,
      quantity: selectedMap[item.goodsId] ?? 0,
      category: item.category
    }))
    .filter((item) => item.quantity > 0)
);

const selectedSummary = computed(() =>
  selectedItems.value.map((item) => `${item.goodsName} x${item.quantity}`).join("、")
);

const selectedTotal = computed(() =>
  selectedItems.value.reduce((total, item) => total + item.quantity, 0)
);

const activeReservations = computed(() =>
  reservations.value
    .filter((item) => item.status === "active" && item.deviceCode === deviceCode.value)
    .sort((left, right) => Date.parse(left.expiresAt) - Date.parse(right.expiresAt))
);

const nearestReservation = computed(() => activeReservations.value[0]);

const reservationSummary = computed(() => {
  const reservation = nearestReservation.value;

  if (!reservation) {
    return "";
  }

  return reservation.items.map((item) => `${item.goodsName} x${item.quantity}`).join("、");
});
const reservationRuleLines = computed(() => {
  const settings = reservationSettings.value;

  if (!settings) {
    return ["正在读取预约规则，请稍候。"];
  }

  if (!settings.enabled) {
    return ["当前暂未开放提前预约，请到柜机旁直接扫码或手动开柜。"];
  }

  return [
    `预约成功后会保留所选货品种类和数量 ${settings.holdMinutes} 分钟。`,
    "预约不锁定当前批次或当前保质期；到柜开门时，系统会从仍有效的批次中分配。",
    `累计超时 ${settings.maxTimeouts} 次后，账号可能会被暂停预约功能。`,
    "到达柜机后请进入同一台柜机详情，使用当前预约开柜。"
  ];
});

const selectedGoodsDetails = computed(() =>
  selectedItems.value.map((item) => {
    const goods = goodsList.value.find((entry) => entry.goodsId === item.goodsId);
    const freeQuantity = Math.min(item.quantity, Math.max(0, getRemaining(item.goodsId)));
    const paidQuantity = Math.max(0, item.quantity - freeQuantity);
    const unitPrice = goods?.price ?? 0;

    return {
      ...item,
      stock: goods?.stock ?? 0,
      unitPrice,
      freeQuantity,
      paidQuantity,
      paidAmount: paidQuantity * unitPrice
    };
  })
);

const selectedFreeTotal = computed(() =>
  selectedGoodsDetails.value.reduce((total, item) => total + item.freeQuantity, 0)
);

const selectedPaidTotal = computed(() =>
  selectedGoodsDetails.value.reduce((total, item) => total + item.paidQuantity, 0)
);

const estimatedPayableAmount = computed(() =>
  selectedGoodsDetails.value.reduce((total, item) => total + item.paidAmount, 0)
);

const availableGoodsCount = computed(() =>
  goodsList.value.filter((item) => (item.stock ?? 0) > 0).length
);
const accessibilityEnabled = computed(() => uiPreferencesStore.isAccessibilityEnabled(sessionStore.user?.role));
const hasNavigationTarget = computed(
  () => typeof deviceLongitude.value === "number" && typeof deviceLatitude.value === "number"
);
const navigationAddress = computed(
  () => deviceAddress.value || location.value || deviceName.value || "柜机位置"
);
const deviceStatusPresentation = computed(() =>
  currentDevice.value
    ? getDeviceStatusPresentation(currentDevice.value)
    : {
        canOpen: false,
        label: "状态加载中",
        tone: "warning" as const,
        actionHint: "请等待柜机状态加载完成后再开柜。"
      }
);
const deviceCanOpen = computed(() => deviceStatusPresentation.value.canOpen);

const distanceBanner = computed(() => {
  if (manualDistanceState.value === "far") {
    return {
      tone: "warning",
      title: "请先核对你与柜机的相对距离",
      lines: [
        `当前检测你距离这台柜机约 ${formatDistance(manualDistanceMeters.value)}，可能不是你身边的设备。`,
        "请先确认柜机名称、位置和实际站位，避免误开其他柜机。"
      ]
    };
  }

  if (scanMode.value) {
    return manualDistanceState.value === "near"
      ? {
          tone: "accent",
          title: "已用相机扫码并核对距离",
          lines: [
            `当前检测距离约 ${formatDistance(manualDistanceMeters.value)}，请继续核对柜机编号和现场位置。`,
            "扫码只用于识别柜机，不会单独作为你已经在现场的证明。"
          ]
        }
      : {
          tone: "warning",
          title: "已使用相机识别柜机",
          lines: [
            "系统暂未确认你与柜机的相对距离，扫码不等于已经在柜机旁。",
            "开门前请核对柜机编号、现场位置，并确认准备立即取货。"
          ]
        };
  }

  if (manualDistanceState.value === "near") {
    return {
      tone: "accent",
      title: "已确认你就在柜机附近",
      lines: [
        `当前检测距离约 ${formatDistance(manualDistanceMeters.value)}，可以继续选择物资。`,
        "本页展示柜内有库存的物资，超出免费额度的部分会按物资价格计费。"
      ]
    };
  }

  return {
    tone: "warning",
    title: "暂未确认你与柜机的相对距离",
    lines: ["如果不是扫码进入，建议站到柜机旁后再继续操作。", "超出免费额度的部分会按物资价格计费。"]
  };
});

const openGuideText = computed(() =>
  scanMode.value
    ? "当前通过相机扫码识别柜机；开门前仍需核对现场位置、物资和预结算。"
    : "建议站在柜机旁再操作，先选好计划领取的物资，取货后及时关门。"
);
const distanceStepText = computed(() => {
  if (manualDistanceState.value === "far") {
    return "距离较远";
  }

  if (manualDistanceState.value === "near") {
    return "距离已确认";
  }

  if (scanMode.value) {
    return "扫码完成，距离待确认";
  }

  return "距离待确认";
});
const pickupFlowSteps = computed(() => [
  {
    label: "资格校验",
    description: distanceStepText.value,
    state:
      manualDistanceState.value === "far"
        ? ("warning" as const)
        : manualDistanceState.value === "near"
          ? ("done" as const)
          : ("todo" as const)
  },
  {
    label: "开柜",
    description: selectedItems.value.length ? "可发起开柜" : "先选物资",
    state: selectedItems.value.length ? ("current" as const) : ("todo" as const)
  },
  {
    label: "取货关门",
    description: "及时关门",
    state: "todo" as const
  },
  {
    label: "完成结算",
    description: "自动核对",
    state: "todo" as const
  }
]);

const findPendingBillingEvent = async () => {
  if (!sessionStore.user) {
    return undefined;
  }

  const events = await mobileApi.listCabinetEvents(sessionStore.user.id);
  return events.find((entry) => {
    if (entry.role !== "special" || entry.refundedAt || entry.billingResolvedAt) {
      return false;
    }

    const pendingAdjustment = entry.adjustments?.some(
      (adjustment) =>
        adjustment.amount > 0 &&
        adjustment.paymentNotifyStatus !== "success" &&
        !adjustment.refundedAt
    );

    if (pendingAdjustment) {
      return true;
    }

    return (
      (entry.status === "settled" || entry.status === "closed") &&
      entry.amount > 0 &&
      entry.paymentNotifyStatus !== "success" &&
      entry.billingStatus !== "mismatch"
    );
  });
};

const promptPendingBillingIfNeeded = async (force = false) => {
  if (pendingBillingPromptShown && !force) {
    return false;
  }

  let pendingEvent: CabinetEventRecord | undefined;

  try {
    pendingEvent = await findPendingBillingEvent();
  } catch {
    return false;
  }

  if (!pendingEvent) {
    return false;
  }

  pendingBillingPromptShown = true;
  const pendingAdjustment = pendingEvent.adjustments?.find(
    (adjustment) =>
      adjustment.amount > 0 &&
      adjustment.paymentNotifyStatus !== "success" &&
      !adjustment.refundedAt
  );
  const amount = pendingAdjustment?.amount ?? pendingEvent.amount;
  const orderNo = pendingAdjustment?.orderNo ?? pendingEvent.orderNo;
  const confirmed = await new Promise<boolean>((resolve) => {
    uni.showModal({
      title: pendingAdjustment ? "补扣待支付" : "结算待支付",
      content: `订单 ${orderNo} 仍需支付 ${formatCurrency(amount)}，处理完成后才能继续开柜或预约。`,
      confirmText: "去支付",
      cancelText: "稍后",
      success: ({ confirm }) => resolve(confirm),
      fail: () => resolve(false)
    });
  });

  if (!confirmed) {
    return false;
  }

  uni.navigateTo({
    url: `/pages/common/door-closed?eventId=${encodeURIComponent(pendingEvent.eventId)}`
  });
  return true;
};

const load = async () => {
  await sessionStore.bootstrap();

  if (!sessionStore.user || !deviceCode.value) {
    uni.reLaunch({
      url: "/pages/common/login"
    });
    return;
  }

  if (await promptPendingBillingIfNeeded()) {
    return;
  }

  loading.value = true;
  try {
    const [device, goods, quota, settings, reservationList] = await Promise.all([
      mobileApi.getDevice(deviceCode.value),
      mobileApi.queryGoods(deviceCode.value),
      mobileApi.getQuotaSummary(sessionStore.user.phone),
      mobileApi.reservationSettings(),
      mobileApi.myReservations()
    ]);

    deviceName.value = device.name;
    currentDevice.value = device;
    location.value = device.location;
    deviceAddress.value = device.address ?? "";
    deviceLongitude.value = device.longitude;
    deviceLatitude.value = device.latitude;
    sessionStore.setQuota(quota);
    reservationSettings.value = settings;
    reservations.value = reservationList;
    reservationFulfillmentIssue.value = undefined;
    goodsList.value = goods.filter((item) => (item.stock ?? 0) > 0);
    for (const key of Object.keys(selectedMap)) {
      delete selectedMap[key];
    }
    await inspectRelativeDistance(device);
  } catch (error) {
    uni.showToast({
      title: getErrorMessage(error),
      icon: "none"
    });
  } finally {
    loading.value = false;
  }
};

const calculateDistanceMeters = (
  latitudeA: number,
  longitudeA: number,
  latitudeB: number,
  longitudeB: number
) => {
  const toRadians = (value: number) => (value * Math.PI) / 180;
  const earthRadius = 6371_000;
  const latitudeDelta = toRadians(latitudeB - latitudeA);
  const longitudeDelta = toRadians(longitudeB - longitudeA);
  const sinLatitude = Math.sin(latitudeDelta / 2);
  const sinLongitude = Math.sin(longitudeDelta / 2);
  const a =
    sinLatitude * sinLatitude +
    Math.cos(toRadians(latitudeA)) * Math.cos(toRadians(latitudeB)) * sinLongitude * sinLongitude;

  return Math.round(earthRadius * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a)));
};

const inspectRelativeDistance = async (device: {
  longitude?: number;
  latitude?: number;
  name: string;
}) => {
  if (device.longitude === undefined || device.latitude === undefined) {
    if (manualDistanceMeters.value !== undefined) {
      manualDistanceState.value =
        manualDistanceMeters.value > FAR_DISTANCE_WARNING_METERS ? "far" : "near";
      return;
    }

    manualDistanceState.value = "unknown";
    return;
  }

  try {
    const currentLocation = await new Promise<UniApp.GetLocationSuccess>((resolve, reject) => {
      uni.getLocation({
        type: "gcj02",
        success: resolve,
        fail: reject
      });
    });

    manualDistanceMeters.value = calculateDistanceMeters(
      currentLocation.latitude,
      currentLocation.longitude,
      device.latitude,
      device.longitude
    );
    manualDistanceState.value =
      manualDistanceMeters.value > FAR_DISTANCE_WARNING_METERS ? "far" : "near";

    if (manualDistanceState.value === "far") {
      uni.showModal({
        title: "距离提醒",
        content: `系统检测你距离 ${device.name} 约 ${formatDistance(manualDistanceMeters.value)}。如果这不是你身边的柜机，请返回重新选择或改用扫码进入。`,
        showCancel: false
      });
    }
  } catch {
    if (manualDistanceMeters.value !== undefined) {
      manualDistanceState.value =
        manualDistanceMeters.value > FAR_DISTANCE_WARNING_METERS ? "far" : "near";
      return;
    }

    manualDistanceState.value = "unknown";
  }
};

function getRemaining(goodsId: string) {
  return sessionStore.quota?.remainingByGoods?.[goodsId] ?? 0;
}

const updateSelected = (goodsId: string, delta: number) => {
  const current = selectedMap[goodsId] ?? 0;
  const goods = goodsList.value.find((item) => item.goodsId === goodsId);
  const max = Math.max(0, goods?.stock ?? 0);
  const next = Math.min(max, Math.max(0, current + delta));

  if (delta > 0 && current >= max) {
    uni.showToast({
      title: max > 0 ? `最多可选 ${max} 件` : "当前暂无库存",
      icon: "none"
    });
    return;
  }

  preSettlement.value = undefined;
  selectedMap[goodsId] = next;
};

const buildOpenPayload = (reservation?: CabinetReservationRecord): CabinetOpenRequest | undefined => {
  const items = reservation?.items ?? selectedItems.value;

  if (!sessionStore.user || !items.length) {
    return undefined;
  }

  return {
    phone: sessionStore.user.phone,
    deviceCode: deviceCode.value,
    doorNum: "1",
    reservationId: reservation?.id,
    category: items[0]?.category,
    openMode: scanMode.value ? "scan" : "manual",
    intentItems: items.map((item) => ({
      goodsId: item.goodsId,
      goodsName: item.goodsName,
      quantity: item.quantity,
      category: item.category
    }))
  };
};

const performOpen = async (
  payload: CabinetOpenRequest,
  knownMatchingEventIds?: Set<string>
): Promise<"handled" | "requote"> => {
  submitting.value = true;
  const requestedAt = Date.now();
  try {
    const response = await mobileApi.openCabinet(payload);
    preSettlement.value = response.preSettlement;

    if (response.remainingQuota) {
      sessionStore.setQuota({
        ...sessionStore.quota,
        remainingToday: response.remainingQuota
      });
    }

    uni.redirectTo({
      url: `/pages/common/opening?eventId=${encodeURIComponent(response.eventId)}&deviceCode=${encodeURIComponent(response.deviceCode)}`
    });
    return "handled";
  } catch (error) {
    const message = getErrorMessage(error);

    if (isOpenQuoteRefreshRequired(message)) {
      return "requote";
    }

    if (isOpenOutcomeUncertain(message, error)) {
      const pendingEvent = await findLikelyOpenEvent(payload, requestedAt, knownMatchingEventIds);

      if (pendingEvent) {
        uni.redirectTo({
          url: `/pages/common/opening?eventId=${encodeURIComponent(pendingEvent.eventId)}&deviceCode=${encodeURIComponent(pendingEvent.deviceCode)}`
        });
        return "handled";
      }

      uni.reLaunch({
        url: `/pages/common/result?status=warning&resultType=open-pending&title=${encodeURIComponent(appCopy.openOutcomePending.title)}&detail=${encodeURIComponent(appCopy.openOutcomePending.detail)}&actionText=${encodeURIComponent(appCopy.openOutcomePending.actionText)}`
      });
      return "handled";
    }

    uni.reLaunch({
      url: `/pages/common/result?status=danger&title=${encodeURIComponent(scanMode.value ? "扫码开柜失败" : "手动开柜失败")}&detail=${encodeURIComponent(message)}&actionText=${encodeURIComponent("返回首页")}`
    });
    return "handled";
  } finally {
    submitting.value = false;
  }
};

const isOpenQuoteRefreshRequired = (message: string) =>
  [
    "需要重新获取并确认预结算报价",
    "预结算报价已失效",
    "商品、额度或价格已经变化",
    "请重新确认预结算报价"
  ].some((keyword) => message.includes(keyword));

const sameIntentItems = (
  expected: CabinetOpenRequest["intentItems"],
  actual: CabinetEventRecord["intentItems"]
) => {
  if (!expected?.length || !actual?.length || expected.length !== actual.length) {
    return false;
  }

  const toQuantityMap = (
    items: Array<{ goodsId: string; quantity: number }>
  ) => new Map(items.map((item) => [item.goodsId, item.quantity]));
  const expectedQuantities = toQuantityMap(expected);

  return actual.every((item) => expectedQuantities.get(item.goodsId) === item.quantity);
};

const findLikelyOpenEvent = async (
  payload: CabinetOpenRequest,
  requestedAt: number,
  knownMatchingEventIds?: Set<string>
) => {
  if (!sessionStore.user) {
    return undefined;
  }

  try {
    const events = await listMatchingOpenEvents(payload);
    const earliestAcceptedCreatedAt = requestedAt - 5_000;
    const newlyCreatedEvents = knownMatchingEventIds
      ? events.filter((entry) => !knownMatchingEventIds.has(entry.eventId))
      : events.filter((entry) => Date.parse(entry.createdAt) >= earliestAcceptedCreatedAt);

    return newlyCreatedEvents
      .sort((left, right) => Date.parse(right.createdAt) - Date.parse(left.createdAt))[0];
  } catch {
    return undefined;
  }
};

const listMatchingOpenEvents = async (payload: CabinetOpenRequest) => {
  if (!sessionStore.user) {
    return [];
  }

  const events = await mobileApi.listCabinetEvents(sessionStore.user.id);

  return events.filter(
    (entry) =>
      entry.userId === sessionStore.user?.id &&
      entry.deviceCode === payload.deviceCode &&
      entry.doorNum === (payload.doorNum || "1") &&
      (!payload.reservationId || entry.reservationId === payload.reservationId) &&
      sameIntentItems(payload.intentItems, entry.intentItems)
  );
};

const captureMatchingOpenEventIds = async (payload: CabinetOpenRequest) => {
  try {
    return new Set((await listMatchingOpenEvents(payload)).map((entry) => entry.eventId));
  } catch {
    return undefined;
  }
};

const readKnownEventIdsWithoutDelayingOpen = (
  eventIdsPromise: Promise<Set<string> | undefined>
) =>
  Promise.race([
    eventIdsPromise,
    new Promise<undefined>((resolve) => {
      setTimeout(() => resolve(undefined), 300);
    })
  ]);

const showOpenBlocked = () => {
  uni.showModal({
    title: deviceStatusPresentation.value.label,
    content: deviceStatusPresentation.value.actionHint,
    confirmText: "我知道了",
    showCancel: false
  });
};

const openNoticeText = () => {
  if (manualDistanceState.value === "far") {
    return `当前检测你距离柜机约 ${formatDistance(manualDistanceMeters.value)}，请确认不是误点其他柜机。`;
  }

  if (scanMode.value) {
    return "当前已使用相机扫码，请再次核对现场柜机编号和位置，并在取货后及时关门。";
  }

  return "请确认你已经在柜机旁，并准备好立即取货和及时关门。";
};

const distanceVerificationText = () => {
  if (manualDistanceState.value === "near") {
    return `已确认，约 ${formatDistance(manualDistanceMeters.value)}`;
  }

  if (manualDistanceState.value === "far") {
    return `警告：距离较远，约 ${formatDistance(manualDistanceMeters.value)}`;
  }

  return scanMode.value
    ? "警告：未确认（已扫码识别柜机，但未取得真实距离）"
    : "警告：未确认（手动模式，系统无法确认你已在现场）";
};

const resolveOpenConfirmationElement = () => {
  const target = openConfirmationDialog.value;

  if (typeof HTMLElement !== "undefined" && target instanceof HTMLElement) {
    return target;
  }

  return target?.$el;
};

const getOpenConfirmationFocusableElements = () => {
  const dialog = resolveOpenConfirmationElement();

  if (!dialog || typeof HTMLElement === "undefined") {
    return [];
  }

  return Array.from(
    dialog.querySelectorAll<HTMLElement>(
      'button:not([disabled]), uni-button:not([disabled]), [role="button"]:not([aria-disabled="true"]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'
    )
  ).filter(
    (element) =>
      !element.hasAttribute("disabled") &&
      element.getAttribute("aria-disabled") !== "true" &&
      element.getAttribute("aria-hidden") !== "true"
  );
};

const trapOpenConfirmationFocus = (event: KeyboardEvent) => {
  const dialog = resolveOpenConfirmationElement();
  const focusableElements = getOpenConfirmationFocusableElements();

  if (!dialog || !focusableElements.length) {
    event.preventDefault();
    dialog?.focus();
    return;
  }

  const first = focusableElements[0];
  const last = focusableElements.at(-1);
  const activeElement = typeof document !== "undefined" ? document.activeElement : undefined;

  if (event.shiftKey && (activeElement === first || activeElement === dialog)) {
    event.preventDefault();
    last?.focus();
    return;
  }

  if (!event.shiftKey && activeElement === last) {
    event.preventDefault();
    first?.focus();
  }
};

const clearOpenConfirmationExpiryTimer = () => {
  if (openConfirmationExpiryTimer) {
    clearTimeout(openConfirmationExpiryTimer);
    openConfirmationExpiryTimer = undefined;
  }
};

const restoreOpenConfirmationFocus = async () => {
  const target = openConfirmationPreviousFocus;
  openConfirmationPreviousFocus = undefined;
  await nextTick();

  if (target?.isConnected) {
    target.focus();
  }
};

const requestOpenConfirmation = (
  payload: CabinetOpenRequest,
  preview: {
    preSettlement?: CabinetPreSettlement;
    quoteId?: string;
    quoteExpiresAt?: string;
  }
) =>
  new Promise<OpenConfirmationDecision>((resolve) => {
    clearOpenConfirmationExpiryTimer();
    openConfirmationPreviousFocus =
      typeof document !== "undefined" &&
      typeof HTMLElement !== "undefined" &&
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : undefined;
    openConfirmationResolver = resolve;
    openConfirmation.value = {
      payload,
      settlement: preview.preSettlement,
      quoteId: preview.quoteId,
      quoteExpiresAt: preview.quoteExpiresAt
    };

    const expiresAt = preview.quoteExpiresAt ? Date.parse(preview.quoteExpiresAt) : Number.NaN;

    if (Number.isFinite(expiresAt)) {
      const remainingMs = Math.max(0, expiresAt - Date.now());
      openConfirmationExpiryTimer = setTimeout(() => {
        void finishOpenConfirmation("expired");
      }, Math.min(remainingMs, 2_147_483_647));
    }

    void nextTick(() => resolveOpenConfirmationElement()?.focus());
  });

const finishOpenConfirmation = async (decision: OpenConfirmationDecision) => {
  if (
    decision === "confirmed" &&
    openConfirmation.value?.quoteExpiresAt &&
    Date.parse(openConfirmation.value.quoteExpiresAt) <= Date.now()
  ) {
    decision = "expired";
  }

  if (
    decision === "confirmed" &&
    (!openConfirmation.value?.settlement || !openConfirmation.value.quoteId)
  ) {
    return;
  }

  const resolve = openConfirmationResolver;
  clearOpenConfirmationExpiryTimer();
  openConfirmationResolver = undefined;
  openConfirmation.value = undefined;
  resolve?.(decision);
  await restoreOpenConfirmationFocus();
};

const previewAndConfirmOpen = async (
  payload: CabinetOpenRequest,
  reservation?: CabinetReservationRecord
) => {
  if (submitting.value) {
    return;
  }

  if (!deviceCanOpen.value) {
    showOpenBlocked();
    return;
  }

  submitting.value = true;
  try {
    let preview = await mobileApi.previewOpenSettlement(payload);
    let knownMatchingEventIdsPromise = captureMatchingOpenEventIds(payload);

    while (true) {
      preSettlement.value = preview.preSettlement;
      const decision = await requestOpenConfirmation(payload, preview);

      if (decision === "cancelled") {
        return;
      }

      if (decision === "expired") {
        uni.showToast({
          title: "报价已过期，正在重新核对",
          icon: "none"
        });
        preview = await mobileApi.previewOpenSettlement(payload);
        knownMatchingEventIdsPromise = captureMatchingOpenEventIds(payload);
        continue;
      }

      const knownMatchingEventIds = await readKnownEventIdsWithoutDelayingOpen(
        knownMatchingEventIdsPromise
      );
      const quoteExpiresAt = preview.quoteExpiresAt
        ? Date.parse(preview.quoteExpiresAt)
        : Number.NaN;

      if (Number.isFinite(quoteExpiresAt) && quoteExpiresAt <= Date.now()) {
        uni.showToast({
          title: "报价已过期，正在重新核对",
          icon: "none"
        });
        preview = await mobileApi.previewOpenSettlement(payload);
        knownMatchingEventIdsPromise = captureMatchingOpenEventIds(payload);
        continue;
      }

      submitting.value = false;
      const openResult = await performOpen(
        {
          ...payload,
          quoteId: preview.quoteId
        },
        knownMatchingEventIds
      );

      if (openResult === "requote") {
        submitting.value = true;
        uni.showToast({
          title: "物资、额度或报价已变化，正在重新核对",
          icon: "none"
        });
        preview = await mobileApi.previewOpenSettlement(payload);
        knownMatchingEventIdsPromise = captureMatchingOpenEventIds(payload);
        continue;
      }

      return;
    }
  } catch (error) {
    const message = getErrorMessage(error);

    if (reservation && (message.includes("库存不足") || message.includes("有效批次"))) {
      reservationFulfillmentIssue.value = {
        reservationId: reservation.id,
        message: "预约仍在，但当前没有可履约的有效批次。你可以保留预约并重新查看物资，或取消本次预约。"
      };
      return;
    }

    if ((message.includes("待完成结算") || message.includes("费用")) && await promptPendingBillingIfNeeded(true)) {
      return;
    }

    uni.showToast({
      title: message,
      icon: "none"
    });
  } finally {
    submitting.value = false;
  }
};

const submit = async () => {
  if (submitting.value) {
    return;
  }

  if (!deviceCanOpen.value) {
    showOpenBlocked();
    return;
  }

  if (!selectedItems.value.length) {
    uni.showModal({
      title: "请选择物资",
      content: "正式开柜前需要先选择本次计划领取的物资。",
      showCancel: false
    });
    return;
  }

  const payload = buildOpenPayload();

  if (!payload) {
    return;
  }

  await previewAndConfirmOpen(payload);
};

const createReservation = async () => {
  if (submitting.value) {
    return;
  }

  if (!selectedItems.value.length) {
    uni.showModal({
      title: "请选择物资",
      content: "预约前需要先选择要保留的物资。",
      showCancel: false
    });
    return;
  }

  submitting.value = true;
  try {
    const reservation = await mobileApi.createReservation({
      deviceCode: deviceCode.value,
      doorNum: "1",
      intentItems: selectedItems.value.map((item) => ({
        goodsId: item.goodsId,
        goodsName: item.goodsName,
        quantity: item.quantity,
        category: item.category
      }))
    });
    reservations.value = [reservation, ...reservations.value.filter((item) => item.id !== reservation.id)];
    uni.showModal({
      title: "预约成功",
      content: `已保留 ${reservation.items.map((item) => `${item.goodsName} x${item.quantity}`).join("、")} 至 ${formatBeijingShortDateTime(reservation.expiresAt)}。\n预约不锁定当前批次或保质期；到柜开门时将使用仍有效的库存。`,
      confirmText: "我知道了",
      showCancel: false
    });
  } catch (error) {
    uni.showToast({
      title: getErrorMessage(error),
      icon: "none"
    });
  } finally {
    submitting.value = false;
  }
};

const openWithReservation = async (reservation: CabinetReservationRecord) => {
  if (submitting.value) {
    return;
  }

  if (!deviceCanOpen.value) {
    showOpenBlocked();
    return;
  }

  const payload = buildOpenPayload(reservation);

  if (!payload) {
    return;
  }

  reservationFulfillmentIssue.value = undefined;
  await previewAndConfirmOpen(payload, reservation);
};

const cancelReservation = async (reservation: CabinetReservationRecord) => {
  if (submitting.value) {
    return;
  }

  const confirmed = await new Promise<boolean>((resolve) => {
    uni.showModal({
      title: "确认取消预约",
      content: `将取消 ${reservation.items.map((item) => `${item.goodsName} x${item.quantity}`).join("、")}。原预约保留到 ${formatBeijingShortDateTime(reservation.expiresAt)}，取消后可重新选择物资预约。`,
      confirmText: "取消预约",
      cancelText: "再想想",
      success: ({ confirm }) => resolve(confirm),
      fail: () => resolve(false)
    });
  });

  if (!confirmed) {
    return;
  }

  submitting.value = true;
  try {
    const updated = await mobileApi.cancelReservation(reservation.id);
    reservations.value = reservations.value.map((item) => (item.id === updated.id ? updated : item));
    uni.showModal({
      title: "预约已取消",
      content: "本次预约已释放；如果仍需领取，可重新选择物资并发起预约。",
      showCancel: false
    });
  } catch (error) {
    uni.showToast({
      title: getErrorMessage(error),
      icon: "none"
    });
  } finally {
    submitting.value = false;
  }
};

const formatSettlementBreakdown = (item: {
  freeQuantity: number;
  paidQuantity: number;
  paidAmount: number;
}) =>
  `免费 ${item.freeQuantity} 件 · 付费 ${item.paidQuantity} 件${
    item.paidQuantity > 0 ? ` · ${formatCurrency(item.paidAmount)}` : ""
  }`;

const goFeedback = () => {
  uni.navigateTo({
    url: `/pages/common/feedback?deviceCode=${deviceCode.value}`
  });
};

const openNavigation = () => {
  if (!hasNavigationTarget.value) {
    uni.showModal({
      title: "暂无导航坐标",
      content: "这台柜机还没有设置经纬度，暂时无法打开导航。",
      showCancel: false
    });
    return;
  }

  uni.openLocation({
    longitude: deviceLongitude.value as number,
    latitude: deviceLatitude.value as number,
    name: deviceName.value || "柜机位置",
    address: navigationAddress.value,
    scale: 18,
    fail: (error) => {
      uni.showModal({
        title: "无法打开导航",
        content: `系统未能打开地图能力：${getErrorMessage(error)}`,
        showCancel: false
      });
    }
  });
};

const formatCurrency = (amount: number) => `￥${(amount / 100).toFixed(2)}`;

const formatDistance = (distanceMeters?: number) => {
  if (distanceMeters === undefined) {
    return "未知距离";
  }

  if (distanceMeters < 1000) {
    return `${distanceMeters} 米`;
  }

  return `${(distanceMeters / 1000).toFixed(1)} 公里`;
};

onLoad((query) => {
  deviceCode.value = typeof query.deviceCode === "string" ? query.deviceCode : "";
  scanMode.value = query.scan === "1";
  manualDistanceMeters.value =
    typeof query.distanceMeters === "string" && !Number.isNaN(Number(query.distanceMeters))
      ? Number(query.distanceMeters)
      : undefined;
  load();
});

onUnload(() => {
  clearOpenConfirmationExpiryTimer();
  const resolve = openConfirmationResolver;
  openConfirmationResolver = undefined;
  openConfirmation.value = undefined;
  resolve?.("cancelled");
});
</script>

<template>
  <MobileShell eyebrow="柜机详情" :title="deviceName" :subtitle="location || deviceAddress || '请先确认柜机位置和物资信息'">
    <view
      class="device-detail-background"
      :aria-hidden="openConfirmation ? 'true' : undefined"
      :inert="Boolean(openConfirmation)"
    >
      <GlassCard tone="accent">
        <view class="vm-stack">
        <FlowSteps v-if="!accessibilityEnabled" :steps="pickupFlowSteps" />

        <view
          class="device-readiness"
          :class="`device-readiness--${deviceStatusPresentation.tone}`"
          :role="deviceCanOpen ? 'status' : 'alert'"
          aria-live="polite"
        >
          <view class="device-readiness__main">
            <text class="device-readiness__label">柜机连接状态</text>
            <text class="device-readiness__title">{{ deviceStatusPresentation.label }}</text>
            <text class="device-readiness__body">{{ deviceStatusPresentation.actionHint }}</text>
          </view>
          <view v-if="!deviceCanOpen" class="device-readiness__actions">
            <button class="reservation-panel__button" :loading="loading" @tap="load">重新加载状态</button>
            <button class="reservation-panel__button reservation-panel__button--ghost" @tap="goFeedback">反馈设备问题</button>
          </view>
        </view>

        <view v-if="!accessibilityEnabled" class="section-heading">
          <text class="section-heading__title">本次领取计划</text>
          <text class="vm-subtitle">请先选择本次要领取的物资，再确认开柜。</text>
        </view>

        <view v-if="!accessibilityEnabled" class="overview-grid">
          <ServiceMetric label="已选种类" :value="selectedItems.length" hint="已加入本次计划的物资种类" tone="accent" />
          <ServiceMetric label="已选件数" :value="selectedTotal" :hint="`免费 ${selectedFreeTotal} 件，付费 ${selectedPaidTotal} 件`" />
          <ServiceMetric label="可选物资" :value="availableGoodsCount" hint="当前柜机仍有库存的物资种类" />
        </view>

        <view v-if="!accessibilityEnabled" class="selection-banner">
          <text class="selection-banner__label">{{ scanMode ? "扫码模式" : "手动模式" }}</text>
          <text class="selection-banner__value">{{ selectedSummary || "暂未选择物资" }}</text>
          <text class="selection-banner__hint">{{ openGuideText }}</text>
          <text class="selection-banner__hint">
            {{ estimatedPayableAmount > 0 ? `当前预估需支付 ${formatCurrency(estimatedPayableAmount)}` : "当前选择预计免费" }}，正式结算仍以柜门关闭后的平台识别结果为准。
          </text>
        </view>

        <view v-if="reservationSettings?.enabled && nearestReservation" class="reservation-panel">
          <view class="reservation-panel__main">
            <text class="reservation-panel__label">当前预约</text>
            <text class="reservation-panel__title">{{ reservationSummary }}</text>
            <text class="reservation-panel__hint">保留到 {{ formatBeijingShortDateTime(nearestReservation.expiresAt) }}</text>
            <text class="reservation-panel__hint">按开柜时仍有效的批次履约，不锁定当前批次或保质期。</text>
          </view>
          <view class="reservation-panel__actions">
            <button class="reservation-panel__button" :disabled="!deviceCanOpen || submitting" :loading="submitting" @tap="openWithReservation(nearestReservation)">
              {{ deviceCanOpen ? "用预约开柜" : "状态待刷新" }}
            </button>
            <button class="reservation-panel__button reservation-panel__button--ghost" :loading="submitting" @tap="cancelReservation(nearestReservation)">取消</button>
          </view>
        </view>

        <view
          v-if="nearestReservation && reservationFulfillmentIssue?.reservationId === nearestReservation.id"
          class="reservation-rules reservation-rules--disabled"
          role="alert"
          aria-live="assertive"
        >
          <text class="reservation-rules__title">当前预约暂时无法履约</text>
          <text class="reservation-rules__body">{{ reservationFulfillmentIssue.message }}</text>
          <view class="reservation-panel__actions">
            <button class="reservation-panel__button" :loading="submitting" @tap="load">重新查看物资</button>
            <button class="reservation-panel__button reservation-panel__button--ghost" :loading="submitting" @tap="cancelReservation(nearestReservation)">取消预约</button>
          </view>
        </view>

        <view class="reservation-rules" :class="{ 'reservation-rules--disabled': reservationSettings && !reservationSettings.enabled }">
          <view class="reservation-rules__head">
            <text class="reservation-rules__title">提前预约规则</text>
            <text class="vm-status" :class="reservationSettings?.enabled ? 'vm-status--success' : 'vm-status--warning'">
              {{ reservationSettings?.enabled ? "已开放" : "未开放" }}
            </text>
          </view>
          <text v-for="line in reservationRuleLines" :key="line" class="reservation-rules__body">{{ line }}</text>
        </view>

        <view v-if="selectedGoodsDetails.length" class="settlement-preview">
          <view class="settlement-preview__head">
            <text class="settlement-preview__title">预结算明细</text>
            <text class="settlement-preview__amount">
              {{ estimatedPayableAmount > 0 ? formatCurrency(estimatedPayableAmount) : "免费" }}
            </text>
          </view>
          <view v-for="item in selectedGoodsDetails" :key="item.goodsId" class="settlement-row">
            <text class="settlement-row__name">{{ item.goodsName }} x{{ item.quantity }}</text>
            <text class="settlement-row__meta">
              {{ formatSettlementBreakdown(item) }}
            </text>
          </view>
        </view>

        <view class="distance-banner" :class="`distance-banner--${distanceBanner.tone}`">
          <text class="distance-banner__title">{{ distanceBanner.title }}</text>
          <text v-for="line in distanceBanner.lines" :key="line" class="distance-banner__body">{{ line }}</text>
        </view>

        <view v-if="goodsList.length" class="goods-list">
          <view v-for="goods in goodsList" :key="goods.goodsId" class="goods-item">
            <MenuIcon :name="goods.category === 'food' ? 'food' : goods.category === 'daily' ? 'daily' : 'drink'" size="md" tone="accent" />
            <view class="goods-item__main">
              <text class="goods-item__name">{{ goods.name }}</text>
              <text class="goods-item__meta">
                {{
                  accessibilityEnabled
                    ? `现有 ${goods.stock ?? 0} 件，今日免费额度 ${getRemaining(goods.goodsId)} 件，超出按 ${formatCurrency(goods.price)} 每件计费`
                    : `${categoryLabelMap[goods.category]} · 现有 ${goods.stock ?? 0} 件 · 免费 ${getRemaining(goods.goodsId)} 件 · 超出 ${formatCurrency(goods.price)}/件`
                }}
              </text>
              <text v-if="goods.expiresAt" class="goods-item__hint">
                批次到期 {{ formatBeijingShortDateTime(goods.expiresAt) }}
              </text>
            </view>
            <view class="stepper">
              <button class="stepper__button" :disabled="submitting" :aria-label="`为${goods.name}减少一件`" @tap="updateSelected(goods.goodsId, -1)">-</button>
              <text class="stepper__value" aria-live="polite" aria-atomic="true">{{ selectedMap[goods.goodsId] ?? 0 }}</text>
              <button class="stepper__button" :disabled="submitting" :aria-label="`为${goods.name}增加一件`" @tap="updateSelected(goods.goodsId, 1)">+</button>
            </view>
          </view>
        </view>
        <EmptyState
          v-else
          :title="loading ? '正在加载物资信息' : '当前柜机暂无可选物资'"
          :description="loading ? '请稍候，系统正在同步柜机物资列表。' : accessibilityEnabled ? '' : '柜内有库存的物资会在这里展示，超出免费额度的部分会按物资价格计费。'"
        />

        <view class="action-stack">
          <button class="vm-button vm-button--warning" :disabled="!deviceCanOpen || submitting" :loading="submitting" @tap="submit">
            {{ deviceCanOpen ? (scanMode ? "确认物资并扫码开柜" : "确认物资并手动开柜") : "柜机状态待刷新" }}
          </button>
          <button v-if="reservationSettings?.enabled" class="vm-button vm-button--ghost" :loading="submitting" @tap="createReservation">
            提前预约所选物资
          </button>
          <button v-if="hasNavigationTarget" class="vm-button vm-button--ghost" @tap="openNavigation">
            导航到此柜机
          </button>
          <button class="vm-button vm-button--ghost" @tap="goFeedback">反馈这台柜机的问题</button>
        </view>
        </view>
      </GlassCard>
    </view>

    <view v-if="openConfirmation" class="open-confirmation-mask">
      <view
        ref="openConfirmationDialog"
        class="open-confirmation-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="open-confirmation-title"
        aria-describedby="open-confirmation-summary open-confirmation-notice"
        tabindex="-1"
        @keydown.esc.stop.prevent="finishOpenConfirmation('cancelled')"
        @keydown.tab.stop="trapOpenConfirmationFocus"
      >
        <view class="open-confirmation-dialog__header">
          <text class="open-confirmation-dialog__eyebrow">开门前最后核对</text>
          <text id="open-confirmation-title" class="open-confirmation-dialog__title">
            {{
              openConfirmation.settlement?.chargeRequired
                ? "确认预结算"
                : openConfirmation.settlement
                  ? "确认免费领取"
                  : "确认开柜"
            }}
          </text>
          <text class="open-confirmation-dialog__hint">请逐项核对现场柜机、距离和费用，再决定是否开门。</text>
        </view>

        <scroll-view class="open-confirmation-dialog__body" scroll-y aria-label="开柜核对信息">
          <view
            class="open-confirmation-risk"
            :class="manualDistanceState === 'near' ? 'open-confirmation-risk--success' : 'open-confirmation-risk--warning'"
          >
            <text class="open-confirmation-risk__label">距离验证</text>
            <text class="open-confirmation-risk__value">{{ distanceVerificationText() }}</text>
            <text class="open-confirmation-risk__body">{{ openNoticeText() }}</text>
          </view>

          <view class="open-confirmation-context">
            <view class="open-confirmation-context__row">
              <text class="open-confirmation-context__label">柜机</text>
              <text class="open-confirmation-context__value">{{ deviceName || "未命名柜机" }}</text>
            </view>
            <view class="open-confirmation-context__row">
              <text class="open-confirmation-context__label">柜机编号</text>
              <text class="open-confirmation-context__value">{{ openConfirmation.payload.deviceCode }}</text>
            </view>
            <view class="open-confirmation-context__row">
              <text class="open-confirmation-context__label">柜门</text>
              <text class="open-confirmation-context__value">{{ openConfirmation.payload.doorNum || "1" }} 号门</text>
            </view>
          </view>

          <view v-if="openConfirmation.settlement" class="open-confirmation-settlement">
            <view class="open-confirmation-settlement__summary">
              <view>
                <text id="open-confirmation-summary" class="open-confirmation-settlement__label">
                  {{ openConfirmation.settlement.chargeRequired ? "预计需支付" : "本次预计" }}
                </text>
                <text class="open-confirmation-settlement__count">
                  免费 {{ openConfirmation.settlement.freeQuantity }} 件 · 付费
                  {{ openConfirmation.settlement.paidQuantity }} 件
                </text>
              </view>
              <text
                class="open-confirmation-settlement__amount"
                :class="{ 'open-confirmation-settlement__amount--free': !openConfirmation.settlement.chargeRequired }"
              >
                {{
                  openConfirmation.settlement.chargeRequired
                    ? formatCurrency(openConfirmation.settlement.payableAmount)
                    : "免费"
                }}
              </text>
            </view>
            <view
              v-for="item in openConfirmation.settlement.items"
              :key="item.goodsId"
              class="open-confirmation-settlement__item"
            >
              <text class="open-confirmation-settlement__name">{{ item.goodsName }} x{{ item.quantity }}</text>
              <text class="open-confirmation-settlement__detail">{{ formatSettlementBreakdown(item) }}</text>
            </view>
          </view>

          <view v-else class="open-confirmation-risk open-confirmation-risk--warning">
            <text id="open-confirmation-summary" class="open-confirmation-risk__label">预结算明细暂不可用</text>
            <text class="open-confirmation-risk__body">请返回重新加载；不要在费用未确认时继续开门。</text>
          </view>

          <view v-if="!openConfirmation.quoteId" class="open-confirmation-risk open-confirmation-risk--warning">
            <text class="open-confirmation-risk__label">服务端报价暂不可用</text>
            <text class="open-confirmation-risk__body">当前不会允许开门，请返回修改后重新核对。</text>
          </view>

          <text id="open-confirmation-notice" class="open-confirmation-dialog__notice">
            {{
              openConfirmation.settlement?.chargeRequired
                ? "柜门关闭后，若实际拿取与选择一致，将按以上金额支付；物资、额度或价格变化时系统会要求重新确认。"
                : "柜门关闭后仍以平台实际识别结果为准；如物资、额度或价格变化，系统会要求重新确认。"
            }}
          </text>
        </scroll-view>

        <view class="open-confirmation-dialog__actions">
          <button
            class="vm-button vm-button--ghost"
            tabindex="0"
            @tap="finishOpenConfirmation('cancelled')"
          >
            返回修改
          </button>
          <button
            class="vm-button vm-button--warning"
            tabindex="0"
            :disabled="!openConfirmation.settlement || !openConfirmation.quoteId"
            @tap="finishOpenConfirmation('confirmed')"
          >
            确认并开柜
          </button>
        </view>
      </view>
    </view>
  </MobileShell>
</template>

<style scoped>
.section-heading,
.goods-item__main {
  display: flex;
  flex-direction: column;
  gap: 10rpx;
}

.device-detail-background {
  display: contents;
}

.section-heading__title,
.goods-item__name {
  font-size: 30rpx;
  font-weight: 700;
  color: var(--vm-text);
}

.goods-item__meta,
.goods-item__hint,
.selection-banner__hint,
.distance-banner__body,
.settlement-row__meta {
  font-size: 22rpx;
  color: var(--vm-text-soft);
  line-height: 1.6;
}

.overview-grid,
.goods-list,
.action-stack,
.distance-banner,
.device-readiness,
.device-readiness__actions,
.settlement-preview,
.reservation-panel__actions,
.reservation-rules {
  display: grid;
  gap: 16rpx;
}

.device-readiness {
  grid-template-columns: minmax(0, 1fr) auto;
  align-items: center;
  padding: 20rpx 22rpx;
  border-radius: 22rpx;
  border: 1rpx solid var(--vm-line);
  background: var(--vm-surface-soft);
}

.device-readiness--success {
  border-color: var(--vm-success-line);
  background: var(--vm-success-bg);
}

.device-readiness--warning {
  border-color: var(--vm-warning-line);
  background: var(--vm-warning-bg);
}

.device-readiness--danger {
  border-color: var(--vm-danger-line);
  background: var(--vm-danger-bg);
}

.device-readiness__main {
  display: grid;
  gap: 8rpx;
  min-width: 0;
}

.device-readiness__label,
.device-readiness__body {
  font-size: 22rpx;
  line-height: 1.6;
  color: var(--vm-text-soft);
}

.device-readiness__title {
  font-size: 30rpx;
  font-weight: 800;
  color: var(--vm-text);
}

.overview-grid {
  grid-template-columns: repeat(3, minmax(0, 1fr));
}

.selection-banner,
.goods-item,
.settlement-preview,
.reservation-panel,
.reservation-rules {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 18rpx;
  padding: 20rpx 22rpx;
  border-radius: 22rpx;
  background: var(--vm-surface-soft);
  border: 1rpx solid var(--vm-line);
}

.goods-item {
  display: grid;
  grid-template-columns: auto minmax(0, 1fr) auto;
}

.selection-banner {
  display: grid;
}

.reservation-panel {
  align-items: stretch;
}

.reservation-panel__main {
  display: grid;
  gap: 8rpx;
  min-width: 0;
}

.reservation-panel__label,
.reservation-panel__hint {
  font-size: 22rpx;
  color: var(--vm-text-soft);
}

.reservation-panel__title {
  font-size: 28rpx;
  font-weight: 700;
  color: var(--vm-text);
  line-height: 1.5;
}

.reservation-panel__actions {
  min-width: 190rpx;
}

.reservation-panel__button {
  min-height: 64rpx;
  border-radius: 18rpx;
  background: var(--vm-accent);
  color: #fff;
  font-size: 22rpx;
}

.reservation-panel__button--ghost {
  background: var(--vm-surface-strong);
  color: var(--vm-text);
  border: 1rpx solid var(--vm-line);
}

.settlement-preview {
  display: grid;
  align-items: stretch;
}

.reservation-rules {
  display: grid;
  align-items: stretch;
  background: rgba(255, 255, 255, 0.9);
  border-color: var(--vm-success-line);
}

.reservation-rules--disabled {
  border-color: var(--vm-warning-line);
  background: var(--vm-warning-bg);
}

.reservation-rules__head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 16rpx;
}

.reservation-rules__title {
  font-size: 28rpx;
  font-weight: 800;
  color: var(--vm-text);
}

.reservation-rules__body {
  font-size: 23rpx;
  line-height: 1.6;
  color: var(--vm-text-soft);
}

.settlement-preview__head,
.settlement-row {
  display: flex;
  justify-content: space-between;
  align-items: flex-start;
  gap: 16rpx;
}

.settlement-preview__title,
.settlement-row__name {
  font-size: 26rpx;
  font-weight: 700;
  color: var(--vm-text);
}

.settlement-preview__amount {
  font-size: 28rpx;
  font-weight: 800;
  color: var(--vm-accent-strong);
}

.settlement-row {
  padding-top: 14rpx;
  border-top: 1rpx solid var(--vm-line);
}

.settlement-row__name,
.settlement-row__meta {
  min-width: 0;
}

.settlement-row__meta {
  text-align: right;
}

.selection-banner__label {
  font-size: 22rpx;
  color: var(--vm-accent-strong);
}

.selection-banner__value {
  font-size: 28rpx;
  color: var(--vm-text);
  font-weight: 700;
  line-height: 1.5;
}

.distance-banner {
  padding: 22rpx 24rpx;
  border-radius: 24rpx;
  border: 1rpx solid var(--vm-line);
}

.distance-banner--accent {
  background: var(--vm-info-bg);
  border-color: var(--vm-info-line);
}

.distance-banner--warning {
  background: var(--vm-warning-bg);
  border-color: var(--vm-warning-line);
}

.distance-banner--success {
  background: var(--vm-success-bg);
  border-color: var(--vm-success-line);
}

.distance-banner__title {
  font-size: 28rpx;
  font-weight: 700;
  color: var(--vm-text);
}

.stepper {
  display: flex;
  align-items: center;
  gap: 16rpx;
}

.stepper__button {
  width: 76rpx;
  min-height: 76rpx;
  border-radius: 22rpx;
  border: 1rpx solid var(--vm-line-strong);
  background: var(--vm-surface-strong);
  font-size: 34rpx;
  color: var(--vm-text);
}

.stepper__value {
  min-width: 48rpx;
  text-align: center;
  font-size: 30rpx;
  font-weight: 700;
}

.vm-page--accessible .goods-item {
  grid-template-columns: 1fr;
  align-items: stretch;
}

.vm-page--accessible .device-readiness {
  grid-template-columns: 1fr;
}

.vm-page--accessible .goods-item__name {
  font-size: 38rpx;
}

.vm-page--accessible .goods-item__meta {
  font-size: 28rpx;
  color: var(--vm-text);
}

.vm-page--accessible .stepper {
  justify-content: space-between;
}

.vm-page--accessible .stepper__button {
  width: 120rpx;
  min-height: 100rpx;
  border-width: 3rpx;
  font-size: 42rpx;
}

.vm-page--accessible .stepper__value {
  min-width: 96rpx;
  font-size: 40rpx;
}

.open-confirmation-mask {
  position: fixed;
  inset: 0;
  z-index: 99;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 32rpx 24rpx calc(32rpx + env(safe-area-inset-bottom));
  background: rgba(10, 24, 38, 0.56);
}

.open-confirmation-dialog {
  display: flex;
  flex-direction: column;
  width: 100%;
  max-width: 700rpx;
  max-height: 90vh;
  border-radius: 28rpx;
  border: 1rpx solid var(--vm-line-strong);
  background: var(--vm-surface-strong);
  box-shadow: 0 28rpx 80rpx rgba(10, 24, 38, 0.24);
  overflow: hidden;
}

.open-confirmation-dialog__header {
  display: grid;
  gap: 8rpx;
  padding: 26rpx 28rpx 22rpx;
  border-bottom: 1rpx solid var(--vm-line);
}

.open-confirmation-dialog__eyebrow,
.open-confirmation-settlement__label,
.open-confirmation-risk__label,
.open-confirmation-context__label {
  font-size: 22rpx;
  font-weight: 700;
  color: var(--vm-accent-strong);
}

.open-confirmation-dialog__title {
  font-size: 36rpx;
  font-weight: 800;
  color: var(--vm-text);
}

.open-confirmation-dialog__hint,
.open-confirmation-dialog__notice,
.open-confirmation-risk__body,
.open-confirmation-settlement__count,
.open-confirmation-settlement__detail {
  font-size: 23rpx;
  line-height: 1.55;
  color: var(--vm-text-soft);
}

.open-confirmation-dialog__body {
  box-sizing: border-box;
  width: 100%;
  min-width: 0;
  max-height: 58vh;
  padding: 22rpx 28rpx;
}

/* #ifndef H5 */
.open-confirmation-dialog__body {
  flex: 1 1 58vh;
  min-height: 0;
  height: 58vh;
}
/* #endif */

.open-confirmation-risk,
.open-confirmation-context,
.open-confirmation-settlement {
  display: grid;
  gap: 14rpx;
  margin-bottom: 20rpx;
  padding: 20rpx 22rpx;
  border-radius: 22rpx;
  border: 1rpx solid var(--vm-line);
}

.open-confirmation-risk--warning {
  background: var(--vm-warning-bg);
  border-color: var(--vm-warning-line);
}

.open-confirmation-risk--success {
  background: var(--vm-success-bg);
  border-color: var(--vm-success-line);
}

.open-confirmation-risk__value {
  font-size: 28rpx;
  line-height: 1.4;
  font-weight: 800;
  color: var(--vm-text);
}

.open-confirmation-context {
  background: var(--vm-surface-soft);
}

.open-confirmation-context__row,
.open-confirmation-settlement__summary,
.open-confirmation-settlement__item {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  min-width: 0;
  gap: 18rpx;
}

.open-confirmation-context__row + .open-confirmation-context__row,
.open-confirmation-settlement__item {
  padding-top: 14rpx;
  border-top: 1rpx solid var(--vm-line);
}

.open-confirmation-context__value,
.open-confirmation-settlement__name {
  flex: 1 1 auto;
  min-width: 0;
  text-align: right;
  font-size: 25rpx;
  line-height: 1.45;
  font-weight: 700;
  color: var(--vm-text);
  overflow-wrap: anywhere;
}

.open-confirmation-settlement {
  background: var(--vm-surface-soft);
  border-color: var(--vm-warning-line);
}

.open-confirmation-settlement__summary {
  align-items: center;
  flex-wrap: wrap;
}

.open-confirmation-settlement__summary > view {
  display: grid;
  flex: 1 1 220rpx;
  min-width: 0;
  gap: 6rpx;
}

.open-confirmation-settlement__amount {
  flex-shrink: 0;
  font-size: 42rpx;
  line-height: 1.1;
  font-weight: 900;
  color: var(--vm-warning);
}

.open-confirmation-settlement__amount--free {
  color: var(--vm-success);
}

.open-confirmation-settlement__item {
  align-items: center;
  flex-wrap: wrap;
}

.open-confirmation-settlement__detail {
  flex: 1 1 260rpx;
  min-width: 0;
  text-align: right;
  overflow-wrap: anywhere;
}

.open-confirmation-dialog__notice {
  display: block;
  padding-bottom: 6rpx;
  overflow-wrap: anywhere;
}

.open-confirmation-dialog__actions {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 14rpx;
  padding: 20rpx 28rpx 26rpx;
  border-top: 1rpx solid var(--vm-line);
  background: var(--vm-surface-soft);
}
</style>

