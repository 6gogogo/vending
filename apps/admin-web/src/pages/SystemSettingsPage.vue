<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, reactive, ref, watch } from "vue";
import { onBeforeRouteLeave } from "vue-router";
import type {
  PaymentDiagnosticsResult,
  PaymentEffectiveMode,
  PaymentRuntimeMode,
  SystemSettingEntry,
  SystemSettingsSnapshot,
  SystemSettingsUpdateResult
} from "@vm/shared-types";

import { adminApi } from "../api/admin";
import { useAdminSessionStore } from "../stores/session";
import { formatDateTime } from "../utils/datetime";
import { getAdminErrorMessage as readErrorMessage } from "../utils/error-message";
import {
  adjustmentQuotaModeSettingKey,
  isPaymentOnlySetting,
  isReservationOnlyPickupEnabled,
  orderSystemSettingsGroups,
  reservationOnlyPickupSettingKey,
  settingsVisibleForInstanceAdministration,
  settingsVisibleForCurrentPickupMode
} from "../utils/system-settings-display";
import {
  getEffectiveSystemSettingValues,
  getSystemSettingOperatorDescription,
  isDeploymentManagedRuntimeSetting,
  isProductionManagedRuntimeSetting,
  isProductionRuntimeSettings
} from "../utils/system-settings-operator-copy";

type LeaveDecision = "save" | "discard" | "stay";

const settingsSnapshot = ref<SystemSettingsSnapshot>();
const formValues = reactive<Record<string, string>>({});
const originalValues = ref<Record<string, string>>({});
const activeGroup = ref("");
const searchText = ref("");
const loading = ref(false);
const saving = ref(false);
const loadError = ref("");
const saveMessage = ref<{ type: "success" | "error"; text: string } | null>(null);
const lastSaveResult = ref<SystemSettingsUpdateResult>();
const paymentDiagnostics = ref<PaymentDiagnosticsResult>();
const paymentDiagnosticsLoading = ref(false);
const paymentDiagnosticsError = ref("");
const revealedKeys = ref<Set<string>>(new Set());
const leaveDialogOpen = ref(false);
const sessionStore = useAdminSessionStore();
let resolveLeaveDecision: ((decision: LeaveDecision) => void) | undefined;

const settings = computed(() => settingsSnapshot.value?.settings ?? []);
const canUpdateSettings = computed(() => sessionStore.can("system-settings:update"));
const canViewSensitiveSettings = computed(() => sessionStore.can("system-settings:secret:view"));
const effectiveRuntimeValues = computed(() => getEffectiveSystemSettingValues(settings.value));
const isProductionRuntime = computed(() => isProductionRuntimeSettings(effectiveRuntimeValues.value));
const settingsByKey = computed(() => new Map(settings.value.map((entry) => [entry.key, entry])));
const optionLabel = (key: string) => {
  const entry = settingsByKey.value.get(key);
  const currentValue = formValues[key] ?? entry?.value ?? "";
  return entry?.options?.find((option) => option.value === currentValue)?.label ?? "未设置";
};
const reservationOnlyPickup = computed(() =>
  isReservationOnlyPickupEnabled(formValues[reservationOnlyPickupSettingKey])
);
const reservationOnlyPickupSetting = computed(() =>
  settingsByKey.value.get(reservationOnlyPickupSettingKey)
);
const adjustmentQuotaModeSetting = computed(() =>
  settingsByKey.value.get(adjustmentQuotaModeSettingKey)
);
const settingsForCurrentPickupMode = computed(() =>
  settingsVisibleForCurrentPickupMode(
    settingsVisibleForInstanceAdministration(settings.value),
    reservationOnlyPickup.value
  )
);
const manualVerificationSettingVisible = computed(() =>
  settingsForCurrentPickupMode.value.some(
    (entry) => entry.key === "VM_FULL_SIMULATION_VERIFICATION_MODE"
  )
);
const groups = computed(() =>
  orderSystemSettingsGroups([
    ...new Set(settingsForCurrentPickupMode.value.map((entry) => entry.group))
  ])
);
const dirtyKeys = computed(() =>
  Object.keys(formValues).filter((key) => formValues[key] !== originalValues.value[key])
);
const hasDirtyChanges = computed(() => dirtyKeys.value.length > 0);
const restartDirtyKeys = computed(() =>
  dirtyKeys.value.filter((key) => settingsByKey.value.get(key)?.restartRequired)
);
const runtimeDirtyKeys = computed(() =>
  dirtyKeys.value.filter((key) => !settingsByKey.value.get(key)?.restartRequired)
);
const activeGroupSettings = computed(() =>
  settingsForCurrentPickupMode.value.filter((entry) => !activeGroup.value || entry.group === activeGroup.value)
);
const visibleSettings = computed(() => {
  const query = searchText.value.trim().toLowerCase();

  if (!query) {
    return activeGroupSettings.value;
  }

  return activeGroupSettings.value.filter((entry) =>
    [entry.label, entry.description, entry.group]
      .join(" ")
      .toLowerCase()
      .includes(query)
  );
});
const groupCounts = computed(() =>
  groups.value.map((group) => ({
    group,
    count: settingsForCurrentPickupMode.value.filter((entry) => entry.group === group).length,
    dirtyCount: dirtyKeys.value.filter((key) => settingsByKey.value.get(key)?.group === group).length
  }))
);
const adjustmentQuotaModeLabel = computed(() => optionLabel("SMARTVM_ADJUSTMENT_QUOTA_TIME_MODE"));
const exampleSettingsIntro = computed(() =>
  manualVerificationSettingVisible.value
    ? "先确认领取方式、差异额度归属和 App 登录验证，再保存设置。"
    : "先确认领取方式和差异额度归属，再保存设置。"
);
const instanceSettingsIntro = computed(() =>
  manualVerificationSettingVisible.value
    ? "人员额度、预约时段和审核规则请在“人员管理”中维护。"
    : "人员额度、预约时段和审核规则请在“人员管理”中维护；App 登录方式由服务管理员维护。"
);
const paymentSummaryClass = computed(() => {
  const summary = paymentDiagnostics.value?.summary;

  if (!summary) {
    return "payment-diagnostics__summary--neutral";
  }

  if (summary.strictRealEnabled && summary.allProvidersReadyForReal) {
    return "payment-diagnostics__summary--success";
  }

  if (summary.effectiveMode === "mock" || summary.effectiveMode === "mixed") {
    return "payment-diagnostics__summary--warning";
  }

  return "payment-diagnostics__summary--danger";
});

const applySnapshot = (snapshot: SystemSettingsSnapshot) => {
  settingsSnapshot.value = snapshot;
  const nextValues = Object.fromEntries(snapshot.settings.map((entry) => [entry.key, entry.value]));

  for (const key of Object.keys(formValues)) {
    delete formValues[key];
  }

  for (const [key, value] of Object.entries(nextValues)) {
    formValues[key] = value;
  }

  originalValues.value = nextValues;

  if (!activeGroup.value || !groups.value.some((group) => group === activeGroup.value)) {
    activeGroup.value = groups.value[0] ?? "";
  }
};

const clearPaymentDiagnostics = () => {
  paymentDiagnostics.value = undefined;
  paymentDiagnosticsError.value = "";
};

const refreshPaymentDiagnosticsFor = (snapshot: Pick<SystemSettingsSnapshot, "settings">) => {
  const reservationOnly = isReservationOnlyPickupEnabled(
    snapshot.settings.find((entry) => entry.key === reservationOnlyPickupSettingKey)?.value
  );

  if (reservationOnly) {
    clearPaymentDiagnostics();
    return;
  }

  void loadPaymentDiagnostics();
};

const loadPaymentDiagnostics = async () => {
  paymentDiagnosticsLoading.value = true;
  paymentDiagnosticsError.value = "";

  try {
    paymentDiagnostics.value = await adminApi.paymentDiagnostics();
  } catch (error) {
    paymentDiagnosticsError.value = readErrorMessage(error, "加载支付自检失败。");
  } finally {
    paymentDiagnosticsLoading.value = false;
  }
};

const loadSettings = async () => {
  loading.value = true;
  loadError.value = "";
  saveMessage.value = null;

  try {
    const snapshot = await adminApi.systemSettings();
    applySnapshot(snapshot);
    refreshPaymentDiagnosticsFor(snapshot);
    lastSaveResult.value = undefined;
  } catch (error) {
    loadError.value = readErrorMessage(error, "加载系统设置失败。");
  } finally {
    loading.value = false;
  }
};

const saveSettings = async () => {
  if (!canUpdateSettings.value) {
    saveMessage.value = {
      type: "error",
      text: "当前账号只有查看权限，不能保存系统设置。"
    };
    return false;
  }

  saving.value = true;
  saveMessage.value = null;

  try {
    const response = await adminApi.saveSystemSettings({
      values: Object.fromEntries(dirtyKeys.value.map((key) => [key, formValues[key] ?? ""]))
    });
    lastSaveResult.value = response;
    applySnapshot(response);
    refreshPaymentDiagnosticsFor(response);
    saveMessage.value = {
      type: "success",
      text: response.changedKeys.length
        ? `已保存 ${response.changedKeys.length} 项配置。`
        : "设置已保存，当前没有配置变更。"
    };
    return true;
  } catch (error) {
    saveMessage.value = {
      type: "error",
      text: readErrorMessage(error, "保存系统设置失败。")
    };
    return false;
  } finally {
    saving.value = false;
  }
};

const resetChanges = () => {
  for (const [key, value] of Object.entries(originalValues.value)) {
    formValues[key] = value;
  }

  saveMessage.value = null;
};

const setActiveGroup = (group: string) => {
  activeGroup.value = group;
};

const isBooleanEnabled = (key: string) => ["1", "true", "yes", "on"].includes((formValues[key] ?? "").toLowerCase());

const setBooleanValue = (key: string, checked: boolean) => {
  formValues[key] = checked ? "true" : "false";
};

const setReservationOnlyPickup = (enabled: boolean) => {
  if (!reservationOnlyPickupSetting.value || !canEditEntry(reservationOnlyPickupSetting.value)) {
    return;
  }

  setBooleanValue(reservationOnlyPickupSettingKey, enabled);

  if (!enabled) {
    return;
  }

  for (const entry of settings.value) {
    if (isPaymentOnlySetting(entry.key)) {
      formValues[entry.key] = originalValues.value[entry.key] ?? entry.value;
    }
  }

  if (settingsByKey.value.has("PAYMENT_MODE")) {
    formValues.PAYMENT_MODE = "disabled";
  }

  clearPaymentDiagnostics();
};

const isKeyRevealed = (key: string) => revealedKeys.value.has(key);

const toggleReveal = (key: string) => {
  const next = new Set(revealedKeys.value);

  if (next.has(key)) {
    next.delete(key);
  } else {
    next.add(key);
  }

  revealedKeys.value = next;
};

const inputTypeFor = (entry: SystemSettingEntry) => {
  if (entry.inputType === "number") {
    return "number";
  }

  if (entry.inputType === "password" && !isKeyRevealed(entry.key)) {
    return "password";
  }

  return "text";
};

const paymentRuntimeModeLabel = (mode: PaymentRuntimeMode) => {
  if (mode === "disabled") {
    return "已关闭";
  }

  if (mode === "real") {
    return "严格真实";
  }

  if (mode === "mock") {
    return "模拟服务";
  }

  return "自动选择";
};

const paymentEffectiveModeLabel = (mode: PaymentEffectiveMode | "mixed") => {
  if (mode === "disabled") {
    return "不启用支付";
  }

  if (mode === "real") {
    return "真实支付";
  }

  if (mode === "mock") {
    return "模拟支付";
  }

  return "混合模式";
};

const providerStateClass = (provider: PaymentDiagnosticsResult["providers"][number]) => {
  if (provider.effectiveMode === "mock") {
    return "payment-diagnostics__provider--warning";
  }

  if (provider.readyForRealPayment) {
    return "payment-diagnostics__provider--success";
  }

  return "payment-diagnostics__provider--danger";
};

const fieldPillClass = (entry: SystemSettingEntry) => {
  if (dirtyKeys.value.includes(entry.key)) {
    return "admin-pill--warning";
  }

  if (entry.restartRequired) {
    return "admin-pill--neutral";
  }

  return "admin-pill--success";
};

const fieldPillText = (entry: SystemSettingEntry) => {
  if (dirtyKeys.value.includes(entry.key)) {
    return "未保存";
  }

  if (entry.restartRequired) {
    return "重启后生效";
  }

  return "保存即生效";
};

const shouldHideSensitiveTextarea = (entry: SystemSettingEntry) =>
  entry.inputType === "textarea" &&
  entry.sensitive &&
  Boolean(formValues[entry.key]) &&
  !isKeyRevealed(entry.key);

const isDeploymentManagedEntry = (entry: SystemSettingEntry) =>
  isDeploymentManagedRuntimeSetting(entry.key) ||
  (isProductionRuntime.value && isProductionManagedRuntimeSetting(entry.key));

const canEditEntry = (entry: SystemSettingEntry) =>
  canUpdateSettings.value &&
  (!entry.sensitive || canViewSensitiveSettings.value) &&
  !isDeploymentManagedEntry(entry);

const canEditSetting = (key: string) => {
  const entry = settingsByKey.value.get(key);

  return Boolean(entry && canEditEntry(entry));
};

const requestLeaveDecision = () =>
  new Promise<LeaveDecision>((resolve) => {
    resolveLeaveDecision = resolve;
    leaveDialogOpen.value = true;
  });

const resolveLeave = (decision: LeaveDecision) => {
  leaveDialogOpen.value = false;
  resolveLeaveDecision?.(decision);
  resolveLeaveDecision = undefined;
};

const handleBeforeUnload = (event: BeforeUnloadEvent) => {
  if (!hasDirtyChanges.value) {
    return;
  }

  event.preventDefault();
  event.returnValue = "";
};

onBeforeRouteLeave(async () => {
  if (!hasDirtyChanges.value) {
    return true;
  }

  const decision = await requestLeaveDecision();

  if (decision === "stay") {
    return false;
  }

  if (decision === "discard") {
    resetChanges();
    return true;
  }

  return saveSettings();
});

watch(groups, (nextGroups) => {
  if (!nextGroups.some((group) => group === activeGroup.value)) {
    activeGroup.value = nextGroups[0] ?? "";
  }
}, { immediate: true });

onMounted(() => {
  void loadSettings();
  window.addEventListener("beforeunload", handleBeforeUnload);
});

onBeforeUnmount(() => {
  window.removeEventListener("beforeunload", handleBeforeUnload);
});
</script>

<template>
  <section class="admin-page settings-page">
    <section class="admin-page__section">
      <div class="admin-page__section-head settings-page__topbar">
        <div class="settings-page__heading-copy">
          <p class="admin-copy">
            {{ exampleSettingsIntro }}
          </p>
          <p class="admin-copy">
            保存后按页面提示确认生效时间；需要重启的项会明确标出。
          </p>
        </div>

        <div class="admin-toolbar settings-page__actions">
          <RouterLink class="admin-button admin-button--ghost settings-page__guide-link" to="/guide">查看操作说明</RouterLink>
          <button class="admin-button admin-button--ghost" type="button" :disabled="loading || saving" @click="loadSettings">
            {{ loading ? "刷新中" : "刷新" }}
          </button>
          <button
            class="admin-button admin-button--ghost"
            type="button"
            :disabled="saving || !hasDirtyChanges"
            @click="resetChanges"
          >
            放弃更改
          </button>
          <button class="admin-button" type="button" :disabled="saving || !hasDirtyChanges || !canUpdateSettings" @click="saveSettings">
            {{ saving ? "保存中" : "保存设置" }}
          </button>
        </div>
      </div>

      <div v-if="!canUpdateSettings" class="admin-note settings-page__note">
        当前账号只有查看权限，不能修改或保存系统设置。
      </div>
      <div class="admin-note settings-page__note">
        {{ instanceSettingsIntro }}运行环境、运行数据、外部服务和密钥由服务管理员维护，本页无需填写这些内容。
      </div>
      <div v-if="loadError" class="admin-note settings-page__note settings-page__note--danger">
        {{ loadError }}
      </div>
      <div
        v-if="saveMessage"
        class="admin-note settings-page__note"
        :class="{ 'settings-page__note--danger': saveMessage.type === 'error', 'settings-page__note--success': saveMessage.type === 'success' }"
      >
        {{ saveMessage.text }}
        <span v-if="lastSaveResult?.restartRequiredKeys.length">
          其中 {{ lastSaveResult.restartRequiredKeys.length }} 项需要重启后完全生效。
        </span>
      </div>
      <div v-if="hasDirtyChanges" class="admin-note settings-page__note settings-page__note--warning">
        当前有 {{ dirtyKeys.length }} 项未保存；{{ runtimeDirtyKeys.length }} 项保存后立即生效，{{ restartDirtyKeys.length }} 项需要重新启用服务后完全生效。
      </div>

      <section class="admin-panel admin-panel-block settings-page__example-overview">
        <div class="admin-panel__head">
          <div>
            <span class="admin-kicker">领取规则</span>
            <h3 class="admin-panel__title">先确认领取方式和差异额度</h3>
          </div>
        </div>
        <div class="settings-page__example-grid settings-page__example-grid--two">
          <section class="settings-page__example-card">
            <span class="settings-page__example-label">领取方式</span>
            <div class="settings-page__choice-group" role="group" aria-label="领取方式">
              <button
                class="settings-page__choice"
                :class="{ 'settings-page__choice--active': reservationOnlyPickup }"
                type="button"
                :disabled="!canEditSetting(reservationOnlyPickupSettingKey)"
                :aria-pressed="reservationOnlyPickup"
                @click="setReservationOnlyPickup(true)"
              >
                预约后取货
              </button>
              <button
                class="settings-page__choice"
                :class="{ 'settings-page__choice--active': !reservationOnlyPickup }"
                type="button"
                :disabled="!canEditSetting(reservationOnlyPickupSettingKey)"
                :aria-pressed="!reservationOnlyPickup"
                @click="setReservationOnlyPickup(false)"
              >
                即时领取
              </button>
            </div>
            <p class="admin-copy">
              {{ reservationOnlyPickup ? "当前流程不需要新建支付单或填写支付参数。" : "即时领取会显示支付相关设置。" }}
            </p>
          </section>
          <section class="settings-page__example-card">
            <span class="settings-page__example-label">领取差异额度</span>
            <select
              v-if="adjustmentQuotaModeSetting"
              v-model="formValues[adjustmentQuotaModeSettingKey]"
              class="admin-select"
              :disabled="!canEditSetting(adjustmentQuotaModeSettingKey)"
            >
              <option v-for="option in adjustmentQuotaModeSetting.options" :key="option.value" :value="option.value">
                {{ option.label }}
              </option>
            </select>
            <strong v-else>{{ adjustmentQuotaModeLabel }}</strong>
            <p class="admin-copy">柜机实际数量与预约不一致时，系统按所选日期计算可领取额度。</p>
          </section>
        </div>
        <p class="admin-copy settings-page__example-help">
          修改后请点击“保存设置”。切换为预约取货时，尚未保存的支付项会恢复为原值，不会一并提交。
        </p>
      </section>

      <section v-if="!reservationOnlyPickup" class="admin-panel admin-panel-block payment-diagnostics">
        <div class="admin-panel__head payment-diagnostics__head">
          <div>
            <span class="admin-kicker">支付自检</span>
            <h3 class="admin-panel__title">当前支付运行状态</h3>
          </div>
          <button
            class="admin-button admin-button--ghost"
            type="button"
            :disabled="paymentDiagnosticsLoading"
            @click="loadPaymentDiagnostics"
          >
            {{ paymentDiagnosticsLoading ? "刷新中" : "刷新自检" }}
          </button>
        </div>

        <div v-if="paymentDiagnosticsError" class="admin-note settings-page__note settings-page__note--danger">
          {{ paymentDiagnosticsError }}
        </div>

        <div v-if="paymentDiagnostics" class="payment-diagnostics__body">
          <div class="payment-diagnostics__summary" :class="paymentSummaryClass">
            <span>支付服务：{{ paymentEffectiveModeLabel(paymentDiagnostics.summary.effectiveMode) }}</span>
            <span>服务方式：{{ paymentRuntimeModeLabel(paymentDiagnostics.requestedMode) }}</span>
            <span>当前状态：{{ paymentDiagnostics.summary.strictRealEnabled ? "已按真实服务要求运行" : "按当前设置运行" }}</span>
          </div>

          <div class="payment-diagnostics__reconciliation">
            <div>
              <span class="admin-kicker">资金恢复</span>
              <strong>自动对账：{{ paymentDiagnostics.reconciliation.automaticEnabled ? "已启用" : "未启用" }}</strong>
            </div>
            <span>处理服务：{{ paymentDiagnostics.reconciliation.singleWriterHeld ? "正常" : "待处理" }}</span>
            <span>待确认支付：{{ paymentDiagnostics.reconciliation.pendingPayments }}</span>
            <span>待完成柜机通知：{{ paymentDiagnostics.reconciliation.pendingSmartVmForwards }}</span>
            <span>待确认退款：{{ paymentDiagnostics.reconciliation.pendingRefunds }}</span>
            <span>当前到期：{{ paymentDiagnostics.reconciliation.dueNow }}</span>
            <span>人工核对：{{ paymentDiagnostics.reconciliation.manualReview }}</span>
            <span>已告警：{{ paymentDiagnostics.reconciliation.alerted }}</span>
          </div>

          <div class="payment-diagnostics__providers">
            <section
              v-for="provider in paymentDiagnostics.providers"
              :key="provider.provider"
              class="payment-diagnostics__provider"
              :class="providerStateClass(provider)"
            >
              <div class="payment-diagnostics__provider-head">
                <span class="payment-diagnostics__provider-title">{{ provider.label }}</span>
                <span class="admin-pill" :class="provider.effectiveMode === 'real' ? 'admin-pill--success' : 'admin-pill--warning'">
                  {{ paymentEffectiveModeLabel(provider.effectiveMode) }}
                </span>
              </div>
              <p class="admin-copy">
                {{ provider.readyForRealPayment ? "支付服务已准备就绪。" : "支付服务资料尚未齐备，请联系服务管理员完成设置。" }}
              </p>
            </section>
          </div>

        <div v-if="paymentDiagnostics.warnings.length" class="payment-diagnostics__warnings">
          <p class="admin-copy payment-diagnostics__warning-text">
            支付服务存在待处理事项，请联系服务管理员查看并处理。
          </p>
          </div>
        </div>

        <div v-else-if="paymentDiagnosticsLoading" class="admin-empty">
          <div class="admin-empty__title">正在加载支付自检</div>
          <div class="admin-empty__body">请稍候。</div>
        </div>
      </section>
      <div v-else class="admin-note settings-page__note settings-page__note--success">
        当前为预约取货：新的领取流程不需要支付配置，支付自检与支付专用设置已收起；历史订单仍可在订单和日志中查询。
      </div>
    </section>

    <section class="settings-page__workspace">
      <aside class="admin-panel admin-panel-block settings-page__sidebar">
        <label class="admin-field">
          <span class="admin-field__label">搜索设置</span>
          <input v-model.trim="searchText" class="admin-input" placeholder="设置名称、说明或分类" />
        </label>

        <div class="settings-page__group-list">
          <button
            v-for="item in groupCounts"
            :key="item.group"
            class="settings-page__group-button"
            :class="{ 'settings-page__group-button--active': activeGroup === item.group }"
            type="button"
            @click="setActiveGroup(item.group)"
          >
            <span>{{ item.group }}</span>
            <span class="settings-page__group-count">
              {{ item.count }}<template v-if="item.dirtyCount"> / {{ item.dirtyCount }}</template>
            </span>
          </button>
        </div>

        <div class="admin-note settings-page__note">
          建议先完成“实例设置”。其他服务事项请联系服务管理员协助处理。
        </div>
      </aside>

      <article class="admin-panel admin-panel-block settings-page__form-panel">
        <div class="admin-panel__head settings-page__panel-head">
          <div>
            <span class="admin-kicker">服务设置</span>
            <h3 class="admin-panel__title">{{ activeGroup || "系统设置" }}</h3>
          </div>
          <div class="settings-page__state-pills">
            <span class="admin-pill" :class="hasDirtyChanges ? 'admin-pill--warning' : 'admin-pill--success'">
              {{ hasDirtyChanges ? `${dirtyKeys.length} 项未保存` : "已同步" }}
            </span>
            <span class="admin-pill admin-pill--neutral">
              {{ settingsSnapshot ? formatDateTime(settingsSnapshot.loadedAt) : "未加载" }}
            </span>
          </div>
        </div>

        <div v-if="loading && !settings.length" class="admin-empty">
          <div class="admin-empty__title">正在加载系统设置</div>
          <div class="admin-empty__body">请稍候。</div>
        </div>

        <div v-else-if="!visibleSettings.length" class="admin-empty">
          <div class="admin-empty__title">没有匹配的设置</div>
          <div class="admin-empty__body">请调整搜索关键词或切换左侧分组。</div>
        </div>

        <div v-else class="settings-page__field-list">
          <section
            v-for="entry in visibleSettings"
            :key="entry.key"
            class="settings-page__field-row"
            :class="{ 'settings-page__field-row--dirty': dirtyKeys.includes(entry.key) }"
          >
            <div class="settings-page__field-meta">
              <div class="settings-page__field-title-line">
                <span class="settings-page__field-title">{{ entry.label }}</span>
              </div>
              <p class="admin-copy settings-page__field-description">
                {{ getSystemSettingOperatorDescription(entry) }}
              </p>
              <div class="settings-page__field-pills">
                <span class="admin-pill" :class="fieldPillClass(entry)">{{ fieldPillText(entry) }}</span>
                <span v-if="entry.sensitive" class="admin-pill admin-pill--neutral">敏感项</span>
                <span v-if="entry.masked" class="admin-pill admin-pill--neutral">已隐藏</span>
              </div>
            </div>

            <div class="settings-page__field-control">
              <label v-if="entry.inputType === 'boolean'" class="settings-page__switch">
                <input
                  type="checkbox"
                  :checked="isBooleanEnabled(entry.key)"
                  :disabled="!canEditEntry(entry)"
                  @change="setBooleanValue(entry.key, ($event.target as HTMLInputElement).checked)"
                />
                <span>{{ isBooleanEnabled(entry.key) ? "启用" : "停用" }}</span>
              </label>

              <select v-else-if="entry.inputType === 'select'" v-model="formValues[entry.key]" class="admin-select" :disabled="!canEditEntry(entry)">
                <option v-for="option in entry.options" :key="option.value" :value="option.value">
                  {{ option.label }}
                </option>
              </select>

              <template v-else-if="entry.inputType === 'textarea'">
                <div v-if="shouldHideSensitiveTextarea(entry)" class="settings-page__secret-box">
                  <span class="admin-copy">内容已隐藏。</span>
                  <button class="admin-button admin-button--ghost" type="button" :disabled="!canEditEntry(entry)" @click="toggleReveal(entry.key)">
                    显示并编辑
                  </button>
                </div>
                <textarea
                  v-else
                  v-model="formValues[entry.key]"
                  class="admin-input settings-page__textarea"
                  :placeholder="entry.exampleValue || `请输入${entry.label}`"
                  :disabled="!canEditEntry(entry)"
                />
              </template>

              <div v-else class="settings-page__input-wrap">
                <input
                  v-model="formValues[entry.key]"
                  class="admin-input"
                  :type="inputTypeFor(entry)"
                  :placeholder="entry.exampleValue || `请输入${entry.label}`"
                  :min="entry.numberConstraints?.min"
                  :max="entry.numberConstraints?.max"
                  :step="entry.numberConstraints?.integerOnly ? 1 : undefined"
                  :disabled="!canEditEntry(entry)"
                />
                <button
                  v-if="entry.inputType === 'password' && canViewSensitiveSettings"
                  class="admin-button admin-button--ghost settings-page__reveal-button"
                  type="button"
                  @click="toggleReveal(entry.key)"
                >
                  {{ isKeyRevealed(entry.key) ? "隐藏" : "显示" }}
                </button>
              </div>

              <p v-if="entry.sensitive && !canViewSensitiveSettings" class="admin-copy settings-page__example">
                当前账号没有查看或修改敏感配置的权限。
              </p>

              <p
                v-if="isDeploymentManagedEntry(entry)"
                class="admin-copy settings-page__deployment-note"
              >
                {{ isProductionManagedRuntimeSetting(entry.key)
                  ? "当前实际运行环境为生产，此项由发布流程管理，后台仅供查看。"
                  : "此项由发布流程管理，后台仅供查看。" }}
              </p>

            </div>
          </section>
        </div>
      </article>
    </section>

    <div v-if="leaveDialogOpen" class="settings-page__modal-backdrop">
      <section class="admin-panel settings-page__modal">
        <div class="admin-panel__head">
          <div>
            <span class="admin-kicker">未保存更改</span>
            <h3 class="admin-panel__title">离开前是否保存设置</h3>
          </div>
        </div>
        <p class="admin-copy">
           当前有 {{ dirtyKeys.length }} 项设置尚未保存。保存后将应用本次更改，选择不保存会丢弃本次更改。
        </p>
        <div class="admin-toolbar settings-page__modal-actions">
          <button class="admin-button admin-button--ghost" type="button" @click="resolveLeave('stay')">继续编辑</button>
          <button class="admin-button admin-button--ghost" type="button" @click="resolveLeave('discard')">不保存</button>
          <button class="admin-button" type="button" @click="resolveLeave('save')">保存并离开</button>
        </div>
      </section>
    </div>
  </section>
</template>

<style scoped>
.settings-page__topbar,
.settings-page__panel-head {
  align-items: flex-start;
}

.settings-page__heading-copy {
  display: grid;
  gap: 6px;
  min-width: 0;
}

.settings-page__actions {
  justify-content: flex-end;
}

.settings-page__note {
  white-space: normal;
}

.settings-page__note--warning {
  border-left-color: #efcf8d;
  background: #fff8ea;
  color: #7a520b;
}

.settings-page__note--danger {
  border-left-color: #d9a6a1;
  background: #fff3f1;
  color: #8d342e;
}

.settings-page__note--success {
  border-left-color: #a9d2b5;
  background: #effaf2;
  color: #1d6b3d;
}

.settings-page__example-overview {
  display: grid;
  gap: 12px;
  margin-top: 12px;
}

.settings-page__example-grid {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 10px;
}

.settings-page__example-grid--two {
  grid-template-columns: repeat(2, minmax(0, 1fr));
}

.settings-page__example-card {
  display: grid;
  gap: 6px;
  min-width: 0;
  padding: 14px;
  border: 1px solid #cfdbe9;
  border-radius: 10px;
  background: #f7faff;
}

.settings-page__example-card strong {
  color: #1d4f91;
  font-size: 0.98rem;
  line-height: 1.45;
}

.settings-page__example-label {
  color: var(--admin-muted);
  font-size: 0.78rem;
  font-weight: 800;
  letter-spacing: 0.04em;
}

.settings-page__choice-group {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 8px;
}

.settings-page__choice {
  min-height: 42px;
  padding: 8px 10px;
  border: 1px solid #b9c9dc;
  border-radius: 8px;
  background: #fff;
  color: #31465a;
  font-weight: 800;
  line-height: 1.3;
  cursor: pointer;
  transition: border-color 160ms ease, background-color 160ms ease, color 160ms ease;
}

.settings-page__choice:hover:not(:disabled) {
  border-color: #6d94c6;
  background: #eef5ff;
}

.settings-page__choice:focus-visible {
  outline: 3px solid #9bbce6;
  outline-offset: 2px;
}

.settings-page__choice--active {
  border-color: #2f6eaf;
  background: #e8f2ff;
  color: #174c80;
}

.settings-page__choice:disabled {
  cursor: not-allowed;
  opacity: 0.62;
}

.settings-page__guide-link {
  text-decoration: none;
}

.settings-page__example-help {
  margin: 0;
}

.payment-diagnostics {
  display: grid;
  gap: 12px;
  margin-top: 12px;
}

.payment-diagnostics__head,
.payment-diagnostics__provider-head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 12px;
}

.payment-diagnostics__body {
  display: grid;
  gap: 12px;
}

.payment-diagnostics__summary {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  padding: 10px;
  border: 1px solid var(--admin-line);
  border-radius: 8px;
  font-weight: 700;
}

.payment-diagnostics__summary span {
  min-height: 26px;
  padding: 3px 8px;
  border-radius: 6px;
  background: rgba(255, 255, 255, 0.62);
}

.payment-diagnostics__reconciliation {
  display: grid;
  grid-template-columns: minmax(220px, 1.5fr) repeat(7, minmax(110px, 1fr));
  gap: 10px;
  align-items: center;
  padding: 14px 16px;
  border: 1px solid #d6e0ea;
  border-radius: 12px;
  background: #f6f8fb;
  color: #31465a;
}

.payment-diagnostics__reconciliation > div {
  display: grid;
  gap: 4px;
}

.payment-diagnostics__reconciliation > span {
  white-space: nowrap;
}

.payment-diagnostics__summary--success {
  border-color: #a9d2b5;
  background: #effaf2;
  color: #1d6b3d;
}

.payment-diagnostics__summary--warning,
.payment-diagnostics__summary--neutral {
  border-color: #efcf8d;
  background: #fff8ea;
  color: #7a520b;
}

.payment-diagnostics__summary--danger {
  border-color: #d9a6a1;
  background: #fff3f1;
  color: #8d342e;
}

.payment-diagnostics__providers {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 10px;
}

.payment-diagnostics__provider {
  display: grid;
  gap: 8px;
  padding: 12px;
  border: 1px solid var(--admin-line);
  border-radius: 8px;
  background: var(--admin-panel);
}

.payment-diagnostics__provider--success {
  border-color: #b8d8c0;
}

.payment-diagnostics__provider--warning {
  border-color: #efcf8d;
  background: #fffdf8;
}

.payment-diagnostics__provider--danger {
  border-color: #d9a6a1;
  background: #fff8f7;
}

.payment-diagnostics__provider-title {
  font-weight: 800;
}

.payment-diagnostics__warnings {
  display: grid;
  gap: 6px;
}

.payment-diagnostics__warning-text {
  color: #7a520b;
}

.payment-diagnostics__danger-text {
  color: #8d342e;
}

.settings-page__workspace {
  display: grid;
  grid-template-columns: 280px minmax(0, 1fr);
  gap: 12px;
  align-items: start;
}

.settings-page__sidebar {
  position: sticky;
  top: 12px;
  display: grid;
  gap: 12px;
}

.settings-page__group-list {
  display: grid;
  gap: 6px;
}

.settings-page__group-button {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  min-height: 36px;
  padding: 0 10px;
  border: 1px solid var(--admin-line);
  border-radius: 6px;
  background: var(--admin-panel);
  color: var(--admin-text);
  font-weight: 700;
  text-align: left;
  cursor: pointer;
}

.settings-page__group-button:hover,
.settings-page__group-button--active {
  border-color: #aebfe1;
  background: var(--admin-accent-soft);
  color: var(--admin-accent-strong);
}

.settings-page__group-count {
  flex: 0 0 auto;
  color: var(--admin-muted);
  font-size: 0.78rem;
}

.settings-page__form-panel {
  min-width: 0;
}

.settings-page__state-pills,
.settings-page__field-pills {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}

.settings-page__field-list {
  display: grid;
  gap: 10px;
}

.settings-page__field-row {
  display: grid;
  grid-template-columns: minmax(260px, 0.82fr) minmax(360px, 1fr);
  gap: 16px;
  padding: 14px;
  border: 1px solid var(--admin-line);
  border-radius: 8px;
  background: var(--admin-panel);
}

.settings-page__field-row--dirty {
  border-color: #efcf8d;
  background: #fffdf8;
}

.settings-page__field-meta,
.settings-page__field-control {
  display: grid;
  gap: 8px;
  min-width: 0;
  align-content: start;
}

.settings-page__field-title-line {
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  gap: 8px;
}

.settings-page__field-title {
  font-weight: 700;
  line-height: 1.35;
}

.settings-page__field-key {
  color: var(--admin-muted);
  font-size: 0.78rem;
  word-break: break-all;
}

.settings-page__field-description {
  line-height: 1.55;
}

.settings-page__deployment-note {
  color: #7a520b;
}

.settings-page__input-wrap {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  gap: 8px;
}

.settings-page__reveal-button {
  min-width: 62px;
}

.settings-page__textarea {
  min-height: 116px;
  padding: 10px;
  resize: vertical;
  line-height: 1.55;
}

.settings-page__switch {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  min-height: 36px;
  color: var(--admin-text);
  font-weight: 700;
}

.settings-page__secret-box {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  min-height: 46px;
  padding: 8px 10px;
  border: 1px solid var(--admin-line);
  border-radius: 6px;
  background: var(--admin-panel-muted);
}

.settings-page__example {
  word-break: break-all;
}

.settings-page__modal-backdrop {
  position: fixed;
  inset: 0;
  z-index: 40;
  display: grid;
  place-items: center;
  padding: 24px;
  background: rgba(15, 23, 42, 0.32);
}

.settings-page__modal {
  display: grid;
  gap: 12px;
  width: min(520px, 100%);
  padding: 16px;
}

.settings-page__modal-actions {
  justify-content: flex-end;
}

@media (max-width: 1280px) {
  .settings-page__workspace,
  .settings-page__field-row,
  .payment-diagnostics__providers,
  .settings-page__example-grid,
  .settings-page__example-grid--two {
    grid-template-columns: 1fr;
  }

  .payment-diagnostics__reconciliation {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }

  .settings-page__sidebar {
    position: static;
  }
}

@media (max-width: 680px) {
  .payment-diagnostics__reconciliation {
    grid-template-columns: 1fr;
  }

  .settings-page__input-wrap,
  .settings-page__secret-box {
    grid-template-columns: 1fr;
    display: grid;
  }

  .settings-page__choice-group {
    grid-template-columns: 1fr;
  }
}
</style>
