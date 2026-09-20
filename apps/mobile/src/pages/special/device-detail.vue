<script setup lang="ts">
import { computed, reactive, ref } from "vue";
import { onLoad } from "@dcloudio/uni-app";
import type { CabinetOpenRequest, DeviceRecord } from "@vm/shared-types";
import { mobileApi } from "../../api/mobile";
import GlassCard from "../../components/ui/GlassCard.vue";
import MenuIcon from "../../components/ui/MenuIcon.vue";
import { appCopy } from "../../constants/copy";
import MobileShell from "../../layouts/MobileShell.vue";
import { useSessionStore } from "../../stores/session";
import { buildPickupDeviceUrl, buildPickupLoginUrl, resolveCabinetEntry,
  shouldPreparePickupHomeStack } from "../../utils/cabinet-entry";
import { buildActualPickupRequest, getDailyPickupState, matchesActualPickupEvent } from "../../utils/actual-pickup";
import { getDeviceStatusPresentation } from "../../utils/device-readiness";
import { formatBeijingShortDateTime } from "../../utils/datetime";
import { getErrorMessage } from "../../utils/error-message";
import { isOpenOutcomeUncertain } from "../../utils/open-outcome";
import { resolveHomePath } from "../../utils/role-routing";
import { scanDeviceCode } from "../../utils/scan-device";

type OpenAttemptResult = { state: "navigated" } | { state: "rejected"; message: string };
const sessionStore = useSessionStore();
const pickupCopy = appCopy.cabinetPickup;
const loading = ref(false);
const loadFailed = ref(false);
const submitting = ref(false);
const openFlowLocked = ref(false);
const deviceCode = ref("");
const scanMode = ref(false);
const deviceName = ref(pickupCopy.defaultDeviceName);
const currentDevice = ref<DeviceRecord>();
const goodsList = ref<Awaited<ReturnType<typeof mobileApi.queryGoods>>>([]);
const failedImageMap = reactive<Record<string, boolean>>({});
const actionError = ref("");
const goodsError = ref("");
const pickupHomeStackAttempted = ref(false);
const deviceStatusPresentation = computed(() => currentDevice.value
  ? getDeviceStatusPresentation(currentDevice.value)
  : { canOpen: false, actionHint: pickupCopy.loadingState });
const deviceCanOpen = computed(() => deviceStatusPresentation.value.canOpen);
const actionBusy = computed(() => loading.value || submitting.value || openFlowLocked.value);
const showPrimaryAction = true;
const pickupState = computed(() => getDailyPickupState(sessionStore.quota));
const primaryActionLabel = computed(() => loadFailed.value ? pickupCopy.action.reload
  : pickupState.value.used > 0 ? pickupCopy.rightsUsedUp
  : !pickupState.value.canPickup ? pickupCopy.action.noEntitlement
  : scanMode.value ? (deviceCanOpen.value ? pickupCopy.action.open : pickupCopy.action.unavailable) : pickupCopy.action.scan);
const primaryActionDisabled = computed(() => actionBusy.value ||
  (!loadFailed.value && (!pickupState.value.canPickup || (scanMode.value && !deviceCanOpen.value))));
const actionHint = computed(() => actionError.value || (loading.value ? pickupCopy.syncingState
  : pickupState.value.used > 0 ? pickupCopy.rightsUsedUp
  : !pickupState.value.canPickup ? pickupCopy.noEntitlementHint
  : scanMode.value && !deviceCanOpen.value ? deviceStatusPresentation.value.actionHint
  : scanMode.value ? pickupCopy.pickupHint : pickupCopy.queryHint));

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
  if (!deviceCode.value) return;
  await sessionStore.bootstrap();
  if (!sessionStore.user) {
    uni.redirectTo({ url: scanMode.value ? buildPickupLoginUrl(deviceCode.value) : "/pages/common/app-login" });
    return;
  }
  if (sessionStore.user.role !== "special") { redirectUnsupportedRole(); return; }
  if (preparePickupHomeStack()) return;
  loading.value = true;
  loadFailed.value = false;
  actionError.value = "";
  goodsError.value = "";
  try {
    const [deviceResult, goodsResult, quotaResult] = await Promise.allSettled([
      mobileApi.getDevice(deviceCode.value), mobileApi.queryGoods(deviceCode.value),
      mobileApi.getQuotaSummary(sessionStore.user.phone)
    ]);
    if (deviceResult.status === "rejected") throw deviceResult.reason;
    if (quotaResult.status === "rejected") throw quotaResult.reason;
    const device = deviceResult.value;
    deviceName.value = device.name;
    currentDevice.value = device;
    sessionStore.setQuota(quotaResult.value);
    goodsList.value = goodsResult.status === "fulfilled" ? goodsResult.value : [];
    if (goodsResult.status === "rejected") goodsError.value = pickupCopy.goodsUnavailable;
    for (const key of Object.keys(failedImageMap)) delete failedImageMap[key];
  } catch (error) {
    loadFailed.value = true;
    actionError.value = getErrorMessage(error);
  } finally { loading.value = false; }
};

const listMatchingOpenEvents = async (payload: CabinetOpenRequest) => {
  if (!sessionStore.user) return [];
  const userId = sessionStore.user.id;
  const events = await mobileApi.listCabinetEvents(userId);
  return events.filter((entry) => matchesActualPickupEvent(entry, userId, payload));
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

const handlePickup = async () => {
  if (actionBusy.value || !sessionStore.user) return;
  actionError.value = "";
  if (!pickupState.value.canPickup) { actionError.value = pickupState.value.used > 0 ? pickupCopy.rightsUsedUp : pickupCopy.noEntitlementHint; return; }
  if (!deviceCanOpen.value) { actionError.value = deviceStatusPresentation.value.actionHint; return; }
  submitting.value = true;
  try {
    const payload = buildActualPickupRequest(sessionStore.user.phone, deviceCode.value);
    // 报价令牌用于避免重复下发开门；实际商品留给关门后的识别回调。
    const preview = await mobileApi.previewOpenSettlement(payload);
    payload.quoteId = preview.quoteId;
    const knownIds = await readKnownEventIdsWithoutDelayingOpen(captureMatchingOpenEventIds(payload));
    const result = await performOpen(payload, knownIds);
    if (result.state === "rejected") actionError.value = result.message;
  } catch (error) { actionError.value = getErrorMessage(error); }
  finally { submitting.value = false; }
};

const handlePrimaryAction = async () => {
  if (actionBusy.value) return;
  if (loadFailed.value) { await load(); return; }
  if (!pickupState.value.canPickup) return;
  if (scanMode.value) { await handlePickup(); return; }
  submitting.value = true;
  actionError.value = "";
  try {
    const code = await scanDeviceCode();
    if (code) uni.navigateTo({ url: buildPickupDeviceUrl(code) });
  } catch (error) { actionError.value = getErrorMessage(error); }
  finally { submitting.value = false; }
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
  <MobileShell class="pickup-shell" :eyebrow="scanMode ? pickupCopy.entry.pickup : pickupCopy.entry.query"
    :title="deviceName" :subtitle="pickupCopy.entry.code(deviceCode)">
    <GlassCard tone="accent" class="pickup-card">
      <view class="pickup-stack">
        <view class="cabinet-identity">
          <text class="cabinet-identity__name">{{ scanMode ? pickupCopy.pickupTitle : pickupCopy.queryTitle }}</text>
          <text class="cabinet-identity__code">{{ pickupCopy.entry.compactCode(deviceCode) }}</text>
        </view>
        <text class="flow-hint">{{ scanMode ? pickupCopy.pickupDescription : pickupCopy.queryDescription }}</text>
        <view v-if="!loading && !loadFailed" class="quota-summary">
          <text>{{ pickupCopy.quotaLabel }}</text><text class="quota-summary__value">{{ pickupCopy.quotaCount(pickupState.remaining) }}</text>
        </view>
        <text v-if="loading" class="flow-hint" role="status">{{ pickupCopy.loadingGoods }}</text>
        <view v-else-if="goodsList.length" class="goods-list">
          <view v-for="goods in goodsList" :key="goods.goodsId" class="goods-item">
            <view class="goods-item__image-shell">
              <image v-if="goods.imageUrl && !failedImageMap[goods.goodsId]" class="goods-item__image"
                :src="goods.imageUrl" mode="aspectFit" :alt="goods.name" lazy-load
                @error="failedImageMap[goods.goodsId] = true" />
              <view v-else class="goods-item__fallback">
                <MenuIcon :name="goods.category === 'food' ? 'food' : goods.category === 'daily' ? 'daily' : 'drink'" size="lg" tone="accent" />
                <text>{{ pickupCopy.imageUnavailable }}</text>
              </view>
            </view>
            <view class="goods-item__body">
              <text class="goods-item__name">{{ goods.name }}</text>
              <text class="goods-item__stock" :class="{ 'goods-item__stock--empty': (goods.stock ?? 0) <= 0 }">
                {{ goods.status === "inactive" ? pickupCopy.inactiveGoods : (goods.stock ?? 0) > 0 ? pickupCopy.stockCount(goods.stock ?? 0) : pickupCopy.emptyStock }}
              </text>
              <text v-if="goods.expiresAt" class="goods-item__expiry">{{ pickupCopy.expiryLabel }} {{ formatBeijingShortDateTime(goods.expiresAt) }}</text>
            </view>
          </view>
        </view>
        <text v-else-if="!loadFailed" class="flow-hint">{{ goodsError || pickupCopy.emptyGoods }}</text>
        <button v-if="goodsError && !loading" class="vm-button vm-button--ghost" @tap="load">{{ pickupCopy.action.refresh }}</button>
      </view>
    </GlassCard>
    <view v-if="showPrimaryAction" class="primary-action-spacer" aria-hidden="true" />
    <view v-if="showPrimaryAction" class="primary-action">
      <text class="primary-action__hint" :class="{ 'primary-action__hint--error': Boolean(actionError) }"
        :role="actionError ? 'alert' : 'status'" aria-live="polite">{{ actionHint }}</text>
      <button class="vm-button" :class="scanMode ? 'vm-button--warning' : 'vm-button--primary'"
        :disabled="primaryActionDisabled" :loading="loading || submitting" @tap="handlePrimaryAction">
        {{ primaryActionLabel }}
      </button>
    </view>
  </MobileShell>
</template>

<style scoped>
.pickup-shell, .pickup-card { overflow: visible !important; }
.pickup-stack { display: flex; flex-direction: column; gap: 24rpx; }
.cabinet-identity { display: flex; align-items: center; justify-content: space-between; gap: 16rpx; padding-bottom: 24rpx; border-bottom: 1px solid rgba(46, 125, 70, 0.16); }
.cabinet-identity__name { color: var(--vm-ink); font-size: 32rpx; font-weight: 800; }
.cabinet-identity__code { color: var(--vm-accent-strong); font-size: 24rpx; }
.flow-hint { color: var(--vm-muted); font-size: 27rpx; line-height: 1.6; }
.quota-summary { display: flex; flex-wrap: wrap; gap: 12rpx; justify-content: space-between; padding: 20rpx; border-radius: 20rpx; background: rgba(255,255,255,.85); }
.quota-summary__value { color: var(--vm-accent-strong); font-weight: 800; }
.goods-list { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 20rpx; }
.goods-item { display: flex; flex-direction: column; overflow: hidden; border: 1rpx solid rgba(46,125,70,.18); border-radius: 26rpx; background: white; }
.goods-item__image-shell { height: 220rpx; background: var(--vm-bg-soft); }
.goods-item__image { width: 100%; height: 100%; }
.goods-item__fallback { height: 100%; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 12rpx; color: var(--vm-muted); font-size: 24rpx; }
.goods-item__body { display: flex; flex: 1; flex-direction: column; gap: 18rpx; padding: 20rpx; }
.goods-item__name { flex: 1; color: var(--vm-ink); font-size: 29rpx; font-weight: 800; overflow-wrap: anywhere; }
.goods-item__stock { color: var(--vm-accent-strong); font-size: 26rpx; font-weight: 700; }
.goods-item__stock--empty { color: var(--vm-muted); }
.goods-item__expiry { color: var(--vm-muted); font-size: 23rpx; line-height: 1.4; }
.primary-action-spacer { height: 260rpx; flex-shrink: 0; pointer-events: none; }
.primary-action { position: fixed; z-index: 40; left: 50%; bottom: 0; width: 100%; max-width: 960rpx; display: flex; flex-direction: column; gap: 14rpx; padding: 16rpx 24rpx calc(20rpx + env(safe-area-inset-bottom)); transform: translateX(-50%); border-top: 1rpx solid rgba(46,125,70,.14); background: rgba(255,255,255,.98); box-shadow: 0 -18rpx 44rpx rgba(26,51,33,.13); }
.primary-action__hint { color: var(--vm-muted); font-size: 26rpx; line-height: 1.5; }
.primary-action__hint--error { color: var(--vm-danger); font-weight: 700; }
.primary-action .vm-button { min-height: 96rpx; border-radius: 26rpx; font-size: 32rpx; font-weight: 800; }
.vm-page--accessible .primary-action-spacer { height: 340rpx; }
.vm-page--accessible .goods-list { grid-template-columns: minmax(0, 1fr); }
.vm-page--accessible .flow-hint, .vm-page--accessible .primary-action__hint { font-size: 34rpx; }
</style>
