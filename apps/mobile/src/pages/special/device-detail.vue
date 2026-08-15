<script setup lang="ts">
import { computed, reactive, ref } from "vue";
import { onLoad } from "@dcloudio/uni-app";

import type {
  CabinetEventRecord,
  CabinetOpenRequest,
  CabinetReservationRecord,
  DeviceRecord,
  GoodsCategory,
  ReservationSettings
} from "@vm/shared-types";

import { mobileApi } from "../../api/mobile";
import EmptyState from "../../components/ui/EmptyState.vue";
import GlassCard from "../../components/ui/GlassCard.vue";
import MenuIcon from "../../components/ui/MenuIcon.vue";
import { appCopy } from "../../constants/copy";
import MobileShell from "../../layouts/MobileShell.vue";
import { useSessionStore } from "../../stores/session";
import {
  buildPickupDeviceUrl,
  buildPickupLoginUrl,
  resolveCabinetEntry,
  shouldPreparePickupHomeStack
} from "../../utils/cabinet-entry";
import {
  formatBeijingAvailabilityWindow,
  formatBeijingShortDateTime
} from "../../utils/datetime";
import { getDeviceStatusPresentation } from "../../utils/device-readiness";
import { getErrorMessage } from "../../utils/error-message";
import { isOpenOutcomeUncertain } from "../../utils/open-outcome";
import { resolveHomePath } from "../../utils/role-routing";

type GoodsEntry = {
  goodsCode: string;
  goodsId: string;
  name: string;
  price: number;
  imageUrl: string;
  category: GoodsCategory;
  stock?: number;
  expiresAt?: string;
};

type IntentItem = NonNullable<CabinetOpenRequest["intentItems"]>[number];
type OpenAttemptResult =
  | { state: "navigated" }
  | { state: "rejected"; message: string };

const sessionStore = useSessionStore();
const loading = ref(false);
const loadFailed = ref(false);
const submitting = ref(false);
const confirmingOpen = ref(false);
const confirmingCancellation = ref(false);
const openFlowLocked = ref(false);
const deviceCode = ref("");
const scanMode = ref(false);
const deviceName = ref(appCopy.cabinetPickup.defaultDeviceName);
const currentDevice = ref<DeviceRecord>();
const goodsList = ref<GoodsEntry[]>([]);
const selectedMap = reactive<Record<string, number>>({});
const failedImageMap = reactive<Record<string, boolean>>({});
const reservationSettings = ref<ReservationSettings>();
const reservations = ref<CabinetReservationRecord[]>([]);
const actionError = ref("");
const pickupHomeStackAttempted = ref(false);

const selectedItems = computed<IntentItem[]>(() =>
  goodsList.value
    .map((item) => ({
      goodsId: item.goodsId,
      goodsName: item.name,
      quantity: selectedMap[item.goodsId] ?? 0,
      category: item.category
    }))
    .filter((item) => item.quantity > 0)
);

const selectedTotal = computed(() =>
  selectedItems.value.reduce((total, item) => total + item.quantity, 0)
);

const activeReservations = computed(() =>
  reservations.value
    .filter(
      (item) =>
        item.status === "active" &&
        item.deviceCode === deviceCode.value &&
        Date.parse(item.expiresAt) > Date.now()
    )
    .sort((left, right) => Date.parse(left.expiresAt) - Date.parse(right.expiresAt))
);

const nearestReservation = computed(() => activeReservations.value[0]);
const actionItemTotal = computed(
  () =>
    nearestReservation.value?.items.reduce(
      (total, item) => total + item.quantity,
      0
    ) ?? selectedTotal.value
);

const deviceStatusPresentation = computed(() =>
  currentDevice.value
    ? getDeviceStatusPresentation(currentDevice.value)
    : {
        canOpen: false,
        label: appCopy.cabinetPickup.loadingStatus.label,
        tone: "warning" as const,
        actionHint: appCopy.cabinetPickup.loadingStatus.hint
      }
);

const deviceCanOpen = computed(() => deviceStatusPresentation.value.canOpen);
const actionBusy = computed(
  () =>
    loading.value ||
    submitting.value ||
    confirmingOpen.value ||
    confirmingCancellation.value ||
    openFlowLocked.value
);
const showGoodsSelector = computed(() => !nearestReservation.value);
const showPrimaryAction = computed(
  () => scanMode.value || !nearestReservation.value
);

const primaryActionLabel = computed(() => {
  if (loadFailed.value) {
    return appCopy.cabinetPickup.action.reload;
  }

  if (scanMode.value) {
    if (!deviceCanOpen.value) {
      return appCopy.cabinetPickup.action.unavailable;
    }
    if (nearestReservation.value) {
      return appCopy.cabinetPickup.action.open;
    }
    return selectedTotal.value > 0
      ? appCopy.cabinetPickup.action.openCount(selectedTotal.value)
      : appCopy.cabinetPickup.action.selectQuantity;
  }

  if (!reservationSettings.value?.enabled) {
    return appCopy.cabinetPickup.action.reservationClosed;
  }

  return selectedTotal.value > 0
    ? appCopy.cabinetPickup.action.submitCount(selectedTotal.value)
    : appCopy.cabinetPickup.action.selectQuantity;
});

const primaryActionDisabled = computed(() => {
  if (loadFailed.value) {
    return loading.value;
  }

  if (actionBusy.value) {
    return true;
  }

  if (scanMode.value) {
    return (
      !deviceCanOpen.value ||
      (!nearestReservation.value &&
        (!reservationSettings.value?.enabled || !selectedItems.value.length))
    );
  }

  return !reservationSettings.value?.enabled || !selectedItems.value.length;
});

const actionHint = computed(() => {
  if (actionError.value) {
    return actionError.value;
  }

  if (loading.value) {
    return appCopy.cabinetPickup.hint.syncing;
  }

  if (scanMode.value && !deviceCanOpen.value) {
    return deviceStatusPresentation.value.actionHint;
  }

  if (!nearestReservation.value && !reservationSettings.value?.enabled) {
    return appCopy.cabinetPickup.hint.reservationClosed;
  }

  if (scanMode.value && nearestReservation.value) {
    return appCopy.cabinetPickup.hint.existingReservation;
  }

  if (!selectedItems.value.length) {
    return appCopy.cabinetPickup.hint.selectQuantity;
  }

  return scanMode.value
    ? appCopy.cabinetPickup.hint.pickupReady
    : appCopy.cabinetPickup.hint.reservationReady;
});

const clearSelection = () => {
  for (const key of Object.keys(selectedMap)) {
    delete selectedMap[key];
  }
};

const clearImageFailures = () => {
  for (const key of Object.keys(failedImageMap)) {
    delete failedImageMap[key];
  }
};

const handleGoodsImageError = (goodsId: string) => {
  failedImageMap[goodsId] = true;
};

const getRemaining = (goods: Pick<GoodsEntry, "goodsId" | "category">) => {
  const goodsQuota = sessionStore.quota?.remainingByGoods;
  if (goodsQuota && Object.keys(goodsQuota).length > 0) {
    return Math.max(0, goodsQuota[goods.goodsId] ?? 0);
  }

  return Math.max(0, sessionStore.quota?.remainingToday?.[goods.category] ?? 0);
};

const getSelectableMaximum = (goods: GoodsEntry) =>
  Math.min(Math.max(0, goods.stock ?? 0), getRemaining(goods));

const updateSelected = (goods: GoodsEntry, delta: number) => {
  if (actionBusy.value) {
    return;
  }

  actionError.value = "";
  const current = selectedMap[goods.goodsId] ?? 0;
  const maximum = getSelectableMaximum(goods);
  const next = Math.min(maximum, Math.max(0, current + delta));

  if (delta > 0 && current >= maximum) {
    uni.showToast({
      title:
        maximum > 0
          ? appCopy.cabinetPickup.quota.maximum(maximum)
          : appCopy.cabinetPickup.quota.empty,
      icon: "none"
    });
    return;
  }

  selectedMap[goods.goodsId] = next;
};

const redirectUnsupportedRole = () => {
  const role = sessionStore.user?.role;
  uni.switchTab({ url: resolveHomePath(role) });
};

const getCurrentPageCount = () => {
  const runtimeGlobals = globalThis as typeof globalThis & {
    getCurrentPages?: () => unknown[];
  };
  return runtimeGlobals.getCurrentPages?.().length;
};

const preparePickupHomeStack = () => {
  // #ifdef MP-WEIXIN
  if (
    !scanMode.value ||
    pickupHomeStackAttempted.value ||
    !shouldPreparePickupHomeStack(getCurrentPageCount())
  ) {
    return false;
  }

  pickupHomeStackAttempted.value = true;
  uni.switchTab({
    url: resolveHomePath(sessionStore.user?.role),
    success: () => {
      uni.navigateTo({
        url: buildPickupDeviceUrl(deviceCode.value)
      });
    },
    fail: () => {
      void load();
    }
  });
  return true;
  // #endif

  return false;
};

const load = async () => {
  if (!deviceCode.value) {
    return;
  }

  await sessionStore.bootstrap();

  if (!sessionStore.user) {
    uni.redirectTo({
      url: scanMode.value
        ? buildPickupLoginUrl(deviceCode.value)
        : "/pages/common/app-login"
    });
    return;
  }

  if (sessionStore.user.role !== "special") {
    redirectUnsupportedRole();
    return;
  }

  if (preparePickupHomeStack()) {
    return;
  }

  loading.value = true;
  loadFailed.value = false;
  actionError.value = "";

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
    sessionStore.setQuota(quota);
    reservationSettings.value = settings;
    reservations.value = reservationList;
    clearImageFailures();
    goodsList.value = goods.filter((item) => (item.stock ?? 0) > 0);
    clearSelection();
  } catch (error) {
    loadFailed.value = true;
    actionError.value = getErrorMessage(error);
  } finally {
    loading.value = false;
  }
};

const buildOpenPayload = (
  reservation?: CabinetReservationRecord,
  fallbackItems: IntentItem[] = selectedItems.value
): CabinetOpenRequest | undefined => {
  const items = reservation?.items ?? fallbackItems;

  if (!sessionStore.user || !items.length) {
    return undefined;
  }

  return {
    phone: sessionStore.user.phone,
    deviceCode: deviceCode.value,
    doorNum: "1",
    reservationId: reservation?.id,
    category: items[0]?.category,
    openMode: "scan",
    intentItems: items.map((item) => ({
      goodsId: item.goodsId,
      goodsName: item.goodsName,
      quantity: item.quantity,
      category: item.category
    }))
  };
};

const sameIntentItems = (
  expected: CabinetOpenRequest["intentItems"],
  actual: CabinetEventRecord["intentItems"]
) => {
  if (!expected?.length || !actual?.length || expected.length !== actual.length) {
    return false;
  }

  const expectedQuantities = new Map(
    expected.map((item) => [item.goodsId, item.quantity])
  );
  return actual.every(
    (item) => expectedQuantities.get(item.goodsId) === item.quantity
  );
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
    return new Set(
      (await listMatchingOpenEvents(payload)).map((entry) => entry.eventId)
    );
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

const findLikelyOpenEvent = async (
  payload: CabinetOpenRequest,
  requestedAt: number,
  knownMatchingEventIds?: Set<string>
) => {
  try {
    const events = await listMatchingOpenEvents(payload);
    const earliestAcceptedCreatedAt = requestedAt - 5_000;
    const newlyCreatedEvents = knownMatchingEventIds
      ? events.filter((entry) => !knownMatchingEventIds.has(entry.eventId))
      : events.filter(
          (entry) => Date.parse(entry.createdAt) >= earliestAcceptedCreatedAt
        );

    return newlyCreatedEvents.sort(
      (left, right) => Date.parse(right.createdAt) - Date.parse(left.createdAt)
    )[0];
  } catch {
    return undefined;
  }
};

const navigateToOpening = (eventId: string, targetDeviceCode: string) => {
  openFlowLocked.value = true;
  uni.redirectTo({
    url: `/pages/common/opening?eventId=${encodeURIComponent(eventId)}&deviceCode=${encodeURIComponent(targetDeviceCode)}`
  });
};

const showOpenPendingResult = () => {
  openFlowLocked.value = true;
  uni.reLaunch({
    url: `/pages/common/result?status=warning&resultType=open-pending&title=${encodeURIComponent(appCopy.openOutcomePending.title)}&detail=${encodeURIComponent(appCopy.openOutcomePending.detail)}&actionText=${encodeURIComponent(appCopy.openOutcomePending.actionText)}`
  });
};

const performOpen = async (
  payload: CabinetOpenRequest,
  knownMatchingEventIds?: Set<string>
): Promise<OpenAttemptResult> => {
  const requestedAt = Date.now();

  try {
    const response = await mobileApi.openCabinet(payload);

    if (response.remainingQuota) {
      sessionStore.setQuota({
        ...sessionStore.quota,
        remainingToday: response.remainingQuota
      });
    }

    navigateToOpening(response.eventId, response.deviceCode);
    return { state: "navigated" };
  } catch (error) {
    const message = getErrorMessage(error);

    if (!isOpenOutcomeUncertain(message, error)) {
      return { state: "rejected", message };
    }

    const pendingEvent = await findLikelyOpenEvent(
      payload,
      requestedAt,
      knownMatchingEventIds
    );

    if (pendingEvent) {
      navigateToOpening(pendingEvent.eventId, pendingEvent.deviceCode);
      return { state: "navigated" };
    }

    showOpenPendingResult();
    return { state: "navigated" };
  }
};

const createReservationFromItems = async (items: IntentItem[]) => {
  const reservation = await mobileApi.createReservation({
    deviceCode: deviceCode.value,
    doorNum: "1",
    intentItems: items.map((item) => ({
      goodsId: item.goodsId,
      goodsName: item.goodsName,
      quantity: item.quantity,
      category: item.category
    }))
  });

  reservations.value = [
    reservation,
    ...reservations.value.filter((item) => item.id !== reservation.id)
  ];
  return reservation;
};

const cancelTemporaryReservation = async (
  reservation: CabinetReservationRecord
) => {
  try {
    const updated = await mobileApi.cancelReservation(reservation.id);
    reservations.value = reservations.value.map((item) =>
      item.id === updated.id ? updated : item
    );
    return true;
  } catch {
    return false;
  }
};

const requestOpenConfirmation = (payload: CabinetOpenRequest) =>
  new Promise<boolean>((resolve) => {
    const goodsSummary =
      payload.intentItems
        ?.map(
          (item) =>
            `${item.goodsName ?? appCopy.cabinetPickup.confirmation.defaultGoods} x${item.quantity}`
        )
        .join("、") || appCopy.cabinetPickup.confirmation.noGoods;

    uni.showModal({
      title: appCopy.cabinetPickup.confirmation.title,
      content: appCopy.cabinetPickup.confirmation.content(
        deviceName.value,
        payload.deviceCode,
        goodsSummary
      ),
      confirmText: appCopy.cabinetPickup.confirmation.confirm,
      cancelText: appCopy.cabinetPickup.confirmation.cancel,
      success: ({ confirm }) => resolve(confirm),
      fail: () => resolve(false)
    });
  });

const handlePickup = async () => {
  if (actionBusy.value) {
    return;
  }

  actionError.value = "";
  if (!deviceCanOpen.value) {
    actionError.value = deviceStatusPresentation.value.actionHint;
    return;
  }

  const existingReservation = nearestReservation.value;
  const selectedSnapshot = selectedItems.value.map((item) => ({ ...item }));
  const previewPayload = buildOpenPayload(existingReservation, selectedSnapshot);

  if (!previewPayload) {
    actionError.value = appCopy.cabinetPickup.errors.selectPickup;
    return;
  }

  confirmingOpen.value = true;
  let temporaryReservation: CabinetReservationRecord | undefined;

  try {
    if (!(await requestOpenConfirmation(previewPayload))) {
      return;
    }

    submitting.value = true;
    const reservation =
      existingReservation ??
      (temporaryReservation = await createReservationFromItems(selectedSnapshot));
    const openPayload = buildOpenPayload(reservation, selectedSnapshot);

    if (!openPayload) {
      throw new Error(appCopy.cabinetPickup.errors.invalidOpenRequest);
    }

    const knownMatchingEventIds = await readKnownEventIdsWithoutDelayingOpen(
      captureMatchingOpenEventIds(openPayload)
    );
    const result = await performOpen(openPayload, knownMatchingEventIds);

    if (result.state === "rejected") {
      if (temporaryReservation) {
        const cancelled = await cancelTemporaryReservation(temporaryReservation);
        actionError.value = cancelled
          ? appCopy.cabinetPickup.errors.temporaryCancelled(result.message)
          : appCopy.cabinetPickup.errors.temporaryCancelUnknown(result.message, true);
      } else {
        actionError.value = result.message;
      }
    }
  } catch (error) {
    let message = getErrorMessage(error);
    if (temporaryReservation) {
      const cancelled = await cancelTemporaryReservation(temporaryReservation);
      message = cancelled
        ? appCopy.cabinetPickup.errors.temporaryCancelled(message)
        : appCopy.cabinetPickup.errors.temporaryCancelUnknown(message);
    }
    actionError.value = message;
  } finally {
    submitting.value = false;
    confirmingOpen.value = false;
  }
};

const createReservation = async () => {
  if (actionBusy.value || nearestReservation.value) {
    return;
  }

  if (!reservationSettings.value?.enabled || !selectedItems.value.length) {
    actionError.value = appCopy.cabinetPickup.errors.selectReservation;
    return;
  }

  submitting.value = true;
  actionError.value = "";

  try {
    await createReservationFromItems(
      selectedItems.value.map((item) => ({ ...item }))
    );
    clearSelection();
  } catch (error) {
    actionError.value = getErrorMessage(error);
  } finally {
    submitting.value = false;
  }
};

const cancelReservation = async (reservation: CabinetReservationRecord) => {
  if (actionBusy.value) {
    return;
  }

  confirmingCancellation.value = true;
  const confirmed = await new Promise<boolean>((resolve) => {
    uni.showModal({
      title: appCopy.cabinetPickup.cancellation.title,
      content: appCopy.cabinetPickup.cancellation.content(
        reservation.items
          .map((item) => `${item.goodsName} x${item.quantity}`)
          .join("、")
      ),
      confirmText: appCopy.cabinetPickup.cancellation.confirm,
      cancelText: appCopy.cabinetPickup.cancellation.keep,
      success: ({ confirm }) => resolve(confirm),
      fail: () => resolve(false)
    });
  });
  confirmingCancellation.value = false;

  if (!confirmed) {
    return;
  }

  submitting.value = true;
  actionError.value = "";

  try {
    const updated = await mobileApi.cancelReservation(reservation.id);
    reservations.value = reservations.value.map((item) =>
      item.id === updated.id ? updated : item
    );
    uni.showToast({
      title: appCopy.cabinetPickup.cancellation.success,
      icon: "success"
    });
  } catch (error) {
    actionError.value = getErrorMessage(error);
  } finally {
    submitting.value = false;
  }
};

const handlePrimaryAction = () => {
  if (loadFailed.value) {
    void load();
    return;
  }

  if (scanMode.value) {
    void handlePickup();
    return;
  }

  void createReservation();
};

const rejectInvalidEntry = () => {
  let redirected = false;
  const leave = () => {
    if (redirected) {
      return;
    }
    redirected = true;
    uni.reLaunch({ url: "/pages/common/login" });
  };

  uni.showModal({
    title: appCopy.cabinetPickup.invalidEntry.title,
    content: appCopy.cabinetPickup.invalidEntry.content,
    showCancel: false,
    confirmText: appCopy.cabinetPickup.invalidEntry.confirm,
    success: leave,
    fail: leave
  });
};

onLoad((query) => {
  const entry = resolveCabinetEntry(query);
  if (!entry) {
    rejectInvalidEntry();
    return;
  }

  deviceCode.value = entry.deviceCode;
  scanMode.value = entry.mode === "pickup";
  void load();
});
</script>

<template>
  <MobileShell
    class="pickup-page"
    :eyebrow="scanMode ? appCopy.cabinetPickup.entry.pickupEyebrow : appCopy.cabinetPickup.entry.reservationEyebrow"
    :title="deviceName"
    :subtitle="deviceCode ? appCopy.cabinetPickup.entry.code(deviceCode) : appCopy.cabinetPickup.entry.identifying"
  >
    <GlassCard tone="accent" class="pickup-card">
      <view class="pickup-stack">
        <view class="cabinet-identity" :aria-label="appCopy.cabinetPickup.entry.identityAriaLabel">
          <text class="cabinet-identity__name">{{ deviceName }}</text>
          <text class="cabinet-identity__code">
            {{ appCopy.cabinetPickup.entry.compactCode(deviceCode) }}
          </text>
        </view>

        <view
          v-if="!scanMode && nearestReservation"
          class="reservation-receipt"
          :aria-label="appCopy.cabinetPickup.receipt.ariaLabel"
        >
          <view class="reservation-receipt__head">
            <view class="reservation-receipt__heading">
              <text class="reservation-receipt__eyebrow">{{ appCopy.cabinetPickup.receipt.eyebrow }}</text>
              <text class="reservation-receipt__title">{{ appCopy.cabinetPickup.receipt.title }}</text>
            </view>
            <text class="reservation-receipt__status">{{ appCopy.cabinetPickup.receipt.pending }}</text>
          </view>

          <view class="receipt-row">
            <text class="receipt-row__label">{{ appCopy.cabinetPickup.receipt.machine }}</text>
            <text class="receipt-row__value">{{ deviceName }}（{{ deviceCode }}）</text>
          </view>
          <view class="receipt-row">
            <text class="receipt-row__label">{{ appCopy.cabinetPickup.receipt.goods }}</text>
            <view class="receipt-row__items">
              <text
                v-for="item in nearestReservation.items"
                :key="item.goodsId"
                class="receipt-row__value"
              >
                {{ item.goodsName }} x{{ item.quantity }}
              </text>
            </view>
          </view>
          <view class="receipt-row">
            <text class="receipt-row__label">{{ appCopy.cabinetPickup.receipt.availableWindow }}</text>
            <text class="receipt-row__value">
              {{
                formatBeijingAvailabilityWindow(
                  nearestReservation.reservedAt,
                  nearestReservation.expiresAt
                )
              }}
            </text>
          </view>
          <view class="receipt-row">
            <text class="receipt-row__label">{{ appCopy.cabinetPickup.receipt.expiry }}</text>
            <text class="receipt-row__value">
              {{ appCopy.cabinetPickup.receipt.expiresBefore(formatBeijingShortDateTime(nearestReservation.expiresAt)) }}
            </text>
          </view>
          <view class="receipt-row">
            <text class="receipt-row__label">{{ appCopy.cabinetPickup.receipt.state }}</text>
            <text class="receipt-row__value">{{ appCopy.cabinetPickup.receipt.stateText }}</text>
          </view>

          <button
            class="vm-button vm-button--ghost receipt-cancel"
            :disabled="actionBusy"
            :loading="submitting"
            @tap="cancelReservation(nearestReservation)"
          >
            {{ appCopy.cabinetPickup.receipt.cancel }}
          </button>
          <text
            v-if="actionError"
            class="receipt-error"
            role="alert"
            aria-live="assertive"
          >
            {{ actionError }}
          </text>
        </view>

        <template v-else>
          <view v-if="scanMode && nearestReservation" class="locked-reservation">
            <view class="locked-reservation__head">
              <text class="locked-reservation__title">{{ appCopy.cabinetPickup.existingReservation.title }}</text>
              <text class="locked-reservation__status">{{ appCopy.cabinetPickup.existingReservation.status }}</text>
            </view>
            <text
              v-for="item in nearestReservation.items"
              :key="item.goodsId"
              class="locked-reservation__item"
            >
              {{ item.goodsName }} x{{ item.quantity }}
            </text>
            <text class="locked-reservation__hint">
              {{ appCopy.cabinetPickup.existingReservation.expiresAt(formatBeijingShortDateTime(nearestReservation.expiresAt)) }}
            </text>
          </view>

          <view v-if="showGoodsSelector" class="goods-section">
            <view class="goods-section__heading">
              <text class="goods-section__title">{{ appCopy.cabinetPickup.goods.title }}</text>
              <text class="goods-section__hint">{{ appCopy.cabinetPickup.goods.hint }}</text>
            </view>

            <view v-if="goodsList.length" class="goods-list">
              <view
                v-for="goods in goodsList"
                :key="goods.goodsId"
                class="goods-item"
                :class="{ 'goods-item--selected': (selectedMap[goods.goodsId] ?? 0) > 0 }"
              >
                <view class="goods-item__image-shell">
                  <image
                    v-if="goods.imageUrl && !failedImageMap[goods.goodsId]"
                    class="goods-item__image"
                    :src="goods.imageUrl"
                    mode="aspectFit"
                    :alt="appCopy.cabinetPickup.goods.imageAlt(goods.name)"
                    lazy-load
                    @error="handleGoodsImageError(goods.goodsId)"
                  />
                  <view
                    v-else
                    class="goods-item__image-fallback"
                    :aria-label="appCopy.cabinetPickup.goods.imageUnavailable"
                  >
                    <MenuIcon
                      :name="goods.category === 'food' ? 'food' : goods.category === 'daily' ? 'daily' : 'drink'"
                      size="lg"
                      tone="accent"
                    />
                    <text>{{ appCopy.cabinetPickup.goods.imageUnavailable }}</text>
                  </view>
                </view>
                <view class="goods-item__body">
                  <text class="goods-item__name">{{ goods.name }}</text>
                  <view
                    class="goods-item__stats"
                    :aria-label="appCopy.cabinetPickup.goods.availabilityAriaLabel(goods.stock ?? 0, getSelectableMaximum(goods))"
                  >
                    <view class="goods-stat">
                      <text class="goods-stat__label">{{ appCopy.cabinetPickup.goods.stockLabel }}</text>
                      <text class="goods-stat__value">{{ goods.stock ?? 0 }}</text>
                    </view>
                    <view class="goods-stat goods-stat--available">
                      <text class="goods-stat__label">{{ appCopy.cabinetPickup.goods.availableLabel }}</text>
                      <text class="goods-stat__value">{{ getSelectableMaximum(goods) }}</text>
                    </view>
                  </view>
                  <view class="stepper">
                    <button
                      class="stepper__button"
                      :disabled="actionBusy || (selectedMap[goods.goodsId] ?? 0) <= 0"
                      :aria-label="appCopy.cabinetPickup.goods.decreaseAriaLabel(goods.name)"
                      @tap="updateSelected(goods, -1)"
                    >
                      −
                    </button>
                    <text class="stepper__value" aria-live="polite" aria-atomic="true">
                      {{ selectedMap[goods.goodsId] ?? 0 }}
                    </text>
                    <button
                      class="stepper__button"
                      :disabled="actionBusy || (selectedMap[goods.goodsId] ?? 0) >= getSelectableMaximum(goods)"
                      :aria-label="appCopy.cabinetPickup.goods.increaseAriaLabel(goods.name)"
                      @tap="updateSelected(goods, 1)"
                    >
                      +
                    </button>
                  </view>
                </view>
              </view>
            </view>

            <EmptyState
              v-else
              :title="loading ? appCopy.cabinetPickup.goods.loadingTitle : appCopy.cabinetPickup.goods.emptyTitle"
              :description="loading ? appCopy.cabinetPickup.goods.loadingDescription : appCopy.cabinetPickup.goods.emptyDescription"
            />
          </view>

        </template>
      </view>
    </GlassCard>

    <view v-if="showPrimaryAction" class="primary-action">
      <view class="primary-action__summary">
        <text
          class="primary-action__hint"
          :class="{ 'primary-action__hint--error': Boolean(actionError) }"
          :role="actionError ? 'alert' : 'status'"
          aria-live="polite"
        >
          {{ actionHint }}
        </text>
        <text v-if="actionItemTotal > 0" class="primary-action__count">
          {{ appCopy.cabinetPickup.action.selectedCount(actionItemTotal) }}
        </text>
      </view>
      <button
        class="vm-button"
        :class="scanMode ? 'vm-button--warning' : 'vm-button--primary'"
        :disabled="primaryActionDisabled"
        :loading="loading || submitting"
        @tap="handlePrimaryAction"
      >
        {{ primaryActionLabel }}
      </button>
    </view>
  </MobileShell>
</template>

<style scoped>
.pickup-page {
  padding-bottom: calc(260rpx + env(safe-area-inset-bottom));
}

.pickup-card {
  overflow: hidden;
}

.pickup-stack,
.goods-section,
.primary-action,
.reservation-receipt,
.locked-reservation,
.reservation-receipt__heading,
.receipt-row__items {
  display: flex;
  flex-direction: column;
}

.pickup-stack {
  gap: 28rpx;
}

.cabinet-identity {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 20rpx;
  padding-bottom: 24rpx;
  border-bottom: 1px solid rgba(46, 125, 70, 0.16);
}

.cabinet-identity__name {
  color: var(--vm-ink);
  font-size: 32rpx;
  font-weight: 800;
}

.cabinet-identity__code {
  flex-shrink: 0;
  color: var(--vm-accent-strong);
  font-size: 24rpx;
  font-weight: 700;
}

.goods-section {
  gap: 20rpx;
}

.goods-list {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 20rpx;
}

.goods-section__heading {
  display: flex;
  flex-direction: column;
  gap: 6rpx;
}

.goods-section__title,
.reservation-receipt__title,
.locked-reservation__title {
  color: var(--vm-ink);
  font-size: 34rpx;
  font-weight: 800;
}

.goods-section__hint,
.locked-reservation__hint,
.primary-action__hint {
  color: var(--vm-muted);
  font-size: 23rpx;
  line-height: 1.6;
}

.goods-item {
  display: flex;
  min-width: 0;
  flex-direction: column;
  overflow: hidden;
  border: 2rpx solid rgba(46, 125, 70, 0.28);
  border-radius: 30rpx;
  background: rgba(255, 255, 255, 0.96);
  box-shadow: 0 12rpx 30rpx rgba(39, 70, 46, 0.06);
}

.goods-item--selected {
  border-color: rgba(46, 125, 70, 0.68);
  box-shadow: 0 14rpx 34rpx rgba(46, 125, 70, 0.12);
}

.goods-item__image-shell {
  display: flex;
  width: 100%;
  height: 260rpx;
  align-items: center;
  justify-content: center;
  overflow: hidden;
  border-bottom: 1rpx solid rgba(46, 125, 70, 0.1);
  background: linear-gradient(145deg, #f4f8ef, #fff7eb);
}

.goods-item__image {
  display: block;
  width: 100%;
  height: 100%;
  padding: 14rpx;
}

.goods-item__image-fallback {
  display: flex;
  align-items: center;
  flex-direction: column;
  justify-content: center;
  gap: 12rpx;
  color: var(--vm-muted);
  font-size: 23rpx;
  font-weight: 700;
}

.goods-item__body {
  display: flex;
  min-width: 0;
  flex-direction: column;
  flex: 1;
  gap: 18rpx;
  padding: 22rpx 20rpx 20rpx;
}

.goods-item__name {
  display: block;
  min-height: 94rpx;
  color: var(--vm-ink);
  font-size: 34rpx;
  font-weight: 800;
  line-height: 1.38;
  word-break: break-word;
}

.goods-item__stats {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 10rpx;
}

.goods-stat {
  display: flex;
  min-width: 0;
  min-height: 68rpx;
  align-items: baseline;
  justify-content: center;
  gap: 7rpx;
  padding: 10rpx 6rpx;
  border-radius: 18rpx;
  color: var(--vm-muted);
  background: rgba(46, 125, 70, 0.08);
  white-space: nowrap;
}

.goods-stat--available {
  color: #7d4a18;
  background: rgba(255, 138, 43, 0.12);
}

.goods-stat__label {
  font-size: 24rpx;
  font-weight: 750;
}

.goods-stat__value {
  color: var(--vm-accent-strong);
  font-family: var(--vm-font-number);
  font-size: 40rpx;
  font-weight: 900;
  line-height: 1;
}

.goods-stat--available .goods-stat__value {
  color: var(--vm-warning);
}

.stepper {
  display: grid;
  grid-template-columns: 1fr 64rpx 1fr;
  align-items: center;
  width: 100%;
  overflow: hidden;
  border: 1px solid rgba(46, 125, 70, 0.2);
  border-radius: 18rpx;
  background: var(--vm-surface);
}

.stepper__button {
  width: 100%;
  min-height: 82rpx;
  margin: 0;
  padding: 0;
  border: 0;
  border-radius: 0;
  color: var(--vm-accent-strong);
  background: rgba(46, 125, 70, 0.08);
  font-size: 34rpx;
  line-height: 82rpx;
}

.stepper__button::after {
  display: none;
}

.stepper__button[disabled] {
  color: rgba(108, 98, 87, 0.44);
  background: rgba(108, 98, 87, 0.06);
}

.stepper__value {
  color: var(--vm-ink);
  text-align: center;
  font-size: 30rpx;
  font-weight: 800;
}

.primary-action {
  position: fixed;
  z-index: 40;
  left: 50%;
  bottom: 0;
  width: 100%;
  max-width: 960rpx;
  gap: 14rpx;
  padding: 16rpx 24rpx calc(20rpx + env(safe-area-inset-bottom));
  transform: translateX(-50%);
  border-top: 1rpx solid rgba(46, 125, 70, 0.14);
  background: rgba(255, 255, 255, 0.98);
  box-shadow: 0 -18rpx 44rpx rgba(26, 51, 33, 0.13);
}

.primary-action__summary {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 18rpx;
}

.primary-action__hint {
  min-width: 0;
  flex: 1;
  line-height: 1.4;
}

.primary-action__count {
  flex-shrink: 0;
  color: var(--vm-accent-strong);
  font-size: 26rpx;
  font-weight: 800;
  white-space: nowrap;
}

.primary-action .vm-button {
  min-height: 96rpx;
  border-radius: 26rpx;
  font-size: 32rpx;
  font-weight: 800;
}

.primary-action__hint--error,
.receipt-error {
  color: var(--vm-danger);
  font-weight: 700;
}

.receipt-error {
  font-size: 24rpx;
  line-height: 1.6;
}

.reservation-receipt,
.locked-reservation {
  gap: 18rpx;
  padding: 24rpx;
  border-radius: 24rpx;
}

.reservation-receipt {
  border: 2rpx dashed rgba(46, 125, 70, 0.38);
  background: rgba(236, 248, 238, 0.78);
}

.locked-reservation {
  border: 1px solid rgba(46, 125, 70, 0.2);
  background: rgba(236, 248, 238, 0.72);
}

.reservation-receipt__head,
.locked-reservation__head,
.receipt-row {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 18rpx;
}

.reservation-receipt__heading {
  gap: 4rpx;
}

.reservation-receipt__eyebrow {
  color: var(--vm-accent-strong);
  font-size: 22rpx;
  font-weight: 800;
  letter-spacing: 2rpx;
}

.reservation-receipt__status,
.locked-reservation__status {
  flex-shrink: 0;
  padding: 8rpx 16rpx;
  border-radius: 999rpx;
  color: var(--vm-accent-strong);
  background: rgba(46, 125, 70, 0.12);
  font-size: 22rpx;
  font-weight: 800;
}

.receipt-row {
  padding-top: 16rpx;
  border-top: 1px solid rgba(46, 125, 70, 0.12);
}

.receipt-row__label {
  width: 92rpx;
  flex-shrink: 0;
  color: var(--vm-muted);
  font-size: 24rpx;
}

.receipt-row__value,
.locked-reservation__item {
  color: var(--vm-ink);
  font-size: 25rpx;
  font-weight: 650;
  line-height: 1.55;
}

.receipt-row__value {
  text-align: right;
}

.receipt-row__items {
  align-items: flex-end;
  gap: 4rpx;
}

.receipt-cancel {
  margin-top: 4rpx;
}

@media (max-width: 420px) {
  .reservation-receipt__head,
  .locked-reservation__head,
  .receipt-row {
    align-items: flex-start;
    flex-direction: column;
  }

  .receipt-row__value,
  .receipt-row__items {
    align-items: flex-start;
    text-align: left;
  }

}

.vm-page--accessible.pickup-page {
  padding-bottom: calc(340rpx + env(safe-area-inset-bottom));
}

.vm-page--accessible .goods-list {
  grid-template-columns: 1fr;
}

.vm-page--accessible .goods-item__image-shell {
  height: 380rpx;
}

.vm-page--accessible .goods-item__name {
  min-height: 0;
  font-size: 42rpx;
}

.vm-page--accessible .goods-stat__label {
  font-size: 30rpx;
}

.vm-page--accessible .goods-stat__value {
  font-size: 50rpx;
}

.vm-page--accessible .stepper__button {
  min-height: 108rpx;
  font-size: 42rpx;
  line-height: 108rpx;
}

.vm-page--accessible .stepper__value,
.vm-page--accessible .primary-action__count {
  font-size: 36rpx;
}

.vm-page--accessible .primary-action__hint {
  color: var(--vm-text);
  font-size: 30rpx;
}

.vm-page--accessible .primary-action__hint--error {
  color: var(--vm-danger);
}
</style>
