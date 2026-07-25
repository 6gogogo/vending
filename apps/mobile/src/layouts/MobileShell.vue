<script setup lang="ts">
import { computed, onMounted, ref, useSlots } from "vue";

import { loadMobileRuntimeConfig } from "../api/runtime-config";
import { appCopy } from "../constants/copy";
import { useSessionStore } from "../stores/session";
import { useUiPreferencesStore } from "../stores/ui-preferences";

type ShellMode = "care" | "ops";

const props = withDefaults(
  defineProps<{
    eyebrow: string;
    title: string;
    subtitle: string;
    mode?: ShellMode;
    headerStyle?: "compact" | "panel";
  }>(),
  {
    mode: undefined,
    headerStyle: "compact"
  }
);

const resolvedMode = computed<ShellMode>(() => {
  if (props.mode) {
    return props.mode;
  }

  const currentPage = getCurrentPages().at(-1);
  const route = typeof currentPage?.route === "string" ? currentPage.route : "";

  if (route.startsWith("pages/admin/") || route.startsWith("pages/merchant/")) {
    return "ops";
  }

  return "care";
});

const sessionStore = useSessionStore();
const uiPreferencesStore = useUiPreferencesStore();
const slots = useSlots();
const runtimeDataPlane = ref<"simulation" | "live" | "unknown">("unknown");

uiPreferencesStore.hydrate();

onMounted(async () => {
  try {
    const publicConfig = await loadMobileRuntimeConfig();
    runtimeDataPlane.value =
      publicConfig.runtimeDataPlane === "simulation" || publicConfig.runtimeDataPlane === "live"
        ? publicConfig.runtimeDataPlane
        : "unknown";
  } catch {
    runtimeDataPlane.value = "unknown";
  }
});

const isGuestPage = computed(() => {
  const currentPage = getCurrentPages().at(-1);
  const route = typeof currentPage?.route === "string" ? currentPage.route : "";
  return route.startsWith("pages/common/");
});

const accessibilityEnabled = computed(() => {
  if (sessionStore.user?.role) {
    return uiPreferencesStore.isAccessibilityEnabled(sessionStore.user.role);
  }

  return uiPreferencesStore.specialAccessibilityMode && isGuestPage.value;
});

const showUtilityBar = computed(
  () =>
    accessibilityEnabled.value ||
    Boolean(slots["header-left"]) ||
    (props.headerStyle === "panel" && Boolean(slots["header-right"]))
);

const runtimeBadgeLabel = computed(() => {
  if (runtimeDataPlane.value === "simulation") {
    return appCopy.runtime.simulationBadge;
  }

  return runtimeDataPlane.value === "unknown" ? appCopy.runtime.unknownBadge : "";
});
</script>

<template>
  <view
    class="vm-page shell"
    :class="[`shell--${resolvedMode}`, { 'vm-page--accessible': accessibilityEnabled, 'shell--accessible': accessibilityEnabled }]"
  >
    <view
      v-if="runtimeBadgeLabel"
      class="shell__runtime-badge"
      role="status"
      aria-live="polite"
      aria-atomic="true"
    >
      <text>{{ runtimeBadgeLabel }}</text>
    </view>
    <view class="shell__garden shell__garden--left" aria-hidden="true" />
    <view class="shell__garden shell__garden--right" aria-hidden="true" />
    <view class="shell__body">
      <view v-if="showUtilityBar" class="shell__utility vm-fade-up" :class="{ 'shell__utility--accessible': accessibilityEnabled }">
        <view class="shell__utility-left">
          <slot name="header-left" />
          <view v-if="accessibilityEnabled" class="shell__elder-mark">
            <view class="shell__elder-dot" />
            <text class="shell__elder-text">关怀版</text>
          </view>
        </view>
        <view v-if="props.headerStyle === 'panel' && $slots['header-right']" class="shell__utility-right">
          <slot name="header-right" />
        </view>
      </view>

      <template v-if="props.headerStyle === 'panel'">
        <view class="shell__hero vm-fade-up" :class="{ 'shell__hero--accessible': accessibilityEnabled }">
          <view class="shell__hero-main" :class="{ 'shell__hero-main--accessible': accessibilityEnabled }">
            <slot name="hero-badge">
              <text class="vm-pill">{{ eyebrow }}</text>
            </slot>
            <view class="shell__title-group">
              <text class="shell__eyebrow">{{ eyebrow }}</text>
              <text class="vm-title">{{ title }}</text>
              <text class="vm-subtitle shell__subtitle">{{ subtitle }}</text>
            </view>
            <slot name="hero-extra" />
          </view>
          <view v-if="$slots['hero-side']" class="shell__hero-side">
            <slot name="hero-side" />
          </view>
        </view>
      </template>
      <view v-else class="shell__compact vm-fade-up" :class="{ 'shell__compact--accessible': accessibilityEnabled }">
        <view class="shell__compact-main">
          <text class="shell__compact-eyebrow">{{ eyebrow }}</text>
          <text class="shell__compact-title">{{ title }}</text>
          <text class="shell__compact-subtitle">{{ subtitle }}</text>
          <slot name="hero-extra" />
        </view>
        <view class="shell__compact-mark" aria-hidden="true">
          <view class="shell__compact-cabinet">
            <view class="shell__compact-cabinet-screen" />
          </view>
          <view class="shell__compact-person" />
          <view class="shell__compact-leaf shell__compact-leaf--one" />
          <view class="shell__compact-leaf shell__compact-leaf--two" />
        </view>
        <view v-if="$slots['header-right']" class="shell__compact-side">
          <slot name="header-right" />
        </view>
      </view>

      <view v-if="$slots['hero-actions']" class="shell__actions vm-slide-in">
        <slot name="hero-actions" />
      </view>

      <view class="shell__content vm-stack" :class="{ 'shell__content--accessible': accessibilityEnabled }">
        <slot />
      </view>
    </view>
  </view>
</template>

<style scoped>
.shell {
  position: relative;
  width: auto;
  max-width: 960rpx;
  box-sizing: border-box;
  overflow: hidden;
  background:
    linear-gradient(180deg, rgba(255, 250, 242, 0.96) 0, rgba(255, 250, 242, 0) 330rpx),
    linear-gradient(135deg, rgba(46, 125, 70, 0.08), rgba(255, 138, 43, 0.06) 42%, rgba(255, 255, 255, 0) 72%),
    var(--vm-page-gradient);
}

.shell__runtime-badge {
  position: fixed;
  z-index: 30;
  top: calc(env(safe-area-inset-top) + 104rpx);
  right: 16rpx;
  max-width: 260rpx;
  padding: 10rpx 18rpx;
  border: 1rpx solid rgba(154, 79, 0, 0.24);
  border-radius: 999rpx;
  background: rgba(255, 246, 225, 0.96);
  box-shadow: 0 8rpx 22rpx rgba(88, 61, 30, 0.12);
  color: #7f4000;
  font-size: 22rpx;
  font-weight: 800;
  line-height: 1.35;
  text-align: center;
  pointer-events: none;
}

.shell--care {
  --vm-bg: #fff7ec;
  --vm-bg-soft: #fff1df;
  --vm-surface: rgba(255, 255, 255, 0.96);
  --vm-surface-strong: #ffffff;
  --vm-surface-soft: rgba(255, 250, 242, 0.94);
  --vm-line: rgba(88, 61, 30, 0.1);
  --vm-line-strong: rgba(88, 61, 30, 0.18);
  --vm-text: #1f1f1f;
  --vm-muted: #6c6257;
  --vm-text-soft: #857b71;
  --vm-accent: #2e7d46;
  --vm-accent-strong: #1f6a3a;
  --vm-shadow: 0 18rpx 44rpx rgba(88, 61, 30, 0.08);
  --vm-button-shadow: 0 18rpx 38rpx rgba(46, 125, 70, 0.16);
  --vm-page-gradient: linear-gradient(180deg, #fffaf3 0%, #f7fbf2 54%, #fff7ec 100%);
  --vm-card-bg: #ffffff;
  --vm-card-accent-bg: var(--vm-accent-bg);
  --vm-card-warning-bg: var(--vm-warning-bg);
  --vm-card-quiet-bg: #fffaf2;
  --vm-card-highlight: var(--vm-accent);
  --vm-hero-bg: #ffffff;
  --vm-hero-border: rgba(46, 125, 70, 0.14);
  --vm-hero-shadow: 0 18rpx 48rpx rgba(46, 125, 70, 0.16);
  --vm-pill-bg: var(--vm-accent-soft);
  --vm-pill-text: var(--vm-accent-strong);
}

.shell--ops {
  --vm-bg: #fff7ec;
  --vm-bg-soft: #fff1df;
  --vm-surface: rgba(255, 255, 255, 0.96);
  --vm-surface-strong: #ffffff;
  --vm-surface-soft: rgba(255, 250, 242, 0.94);
  --vm-line: rgba(88, 61, 30, 0.1);
  --vm-line-strong: rgba(88, 61, 30, 0.18);
  --vm-text: #1f1f1f;
  --vm-muted: #6c6257;
  --vm-text-soft: #857b71;
  --vm-accent: #2e7d46;
  --vm-accent-strong: #1f6a3a;
  --vm-warning: #9a4f00;
  --vm-danger: #d94f41;
  --vm-shadow: 0 18rpx 44rpx rgba(88, 61, 30, 0.08);
  --vm-button-shadow: 0 18rpx 38rpx rgba(46, 125, 70, 0.16);
  --vm-page-gradient: linear-gradient(180deg, #fffaf3 0%, #fff8ee 54%, #f7fbf2 100%);
  --vm-card-bg: #ffffff;
  --vm-card-accent-bg: var(--vm-accent-bg);
  --vm-card-warning-bg: var(--vm-warning-bg);
  --vm-card-quiet-bg: #fffaf2;
  --vm-card-highlight: var(--vm-accent);
  --vm-hero-bg: #ffffff;
  --vm-hero-border: rgba(255, 138, 43, 0.18);
  --vm-hero-shadow: 0 18rpx 48rpx rgba(88, 61, 30, 0.1);
  --vm-pill-bg: var(--vm-accent-soft);
  --vm-pill-text: var(--vm-accent-strong);
}

.shell__body {
  position: relative;
  z-index: 2;
  display: flex;
  flex-direction: column;
  gap: 24rpx;
  width: 100%;
  min-width: 0;
}

.shell__garden {
  position: absolute;
  z-index: 1;
  pointer-events: none;
}

.shell__garden::before,
.shell__garden::after {
  content: "";
  position: absolute;
  border-radius: 100% 0 100% 0;
  background: rgba(46, 125, 70, 0.12);
  transform-origin: 50% 100%;
}

.shell__garden--left {
  left: -34rpx;
  top: 128rpx;
  width: 130rpx;
  height: 150rpx;
}

.shell__garden--right {
  right: -44rpx;
  bottom: 74rpx;
  width: 170rpx;
  height: 200rpx;
}

.shell__garden--left::before {
  width: 72rpx;
  height: 42rpx;
  left: 8rpx;
  top: 24rpx;
  transform: rotate(34deg);
}

.shell__garden--left::after {
  width: 58rpx;
  height: 36rpx;
  left: 54rpx;
  top: 76rpx;
  background: rgba(255, 138, 43, 0.1);
  transform: rotate(-38deg);
}

.shell__garden--right::before {
  width: 92rpx;
  height: 54rpx;
  right: 20rpx;
  bottom: 24rpx;
  transform: rotate(-26deg);
}

.shell__garden--right::after {
  width: 70rpx;
  height: 44rpx;
  right: 78rpx;
  bottom: 86rpx;
  background: rgba(255, 138, 43, 0.11);
  transform: rotate(30deg);
}

.shell__utility {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16rpx;
  min-height: 72rpx;
}

.shell__utility-left,
.shell__utility-right {
  display: flex;
  align-items: center;
  gap: 12rpx;
}

.shell__utility-left {
  min-width: 0;
  flex: 1;
}

.shell__utility-right {
  justify-content: flex-end;
}

.shell__elder-mark {
  display: inline-flex;
  align-items: center;
  gap: 12rpx;
  min-width: 0;
}

.shell__elder-dot {
  width: 44rpx;
  height: 44rpx;
  border-radius: 50%;
  background: var(--vm-accent);
  box-shadow: inset 0 0 0 8rpx rgba(255, 255, 255, 0.18);
}

.shell__elder-text {
  font-size: 30rpx;
  font-weight: 800;
  color: var(--vm-accent-strong);
}

.shell__compact {
  position: relative;
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 18rpx;
  min-height: 176rpx;
  padding: 28rpx 30rpx 26rpx;
  border: 1rpx solid var(--vm-hero-border);
  border-radius: 30rpx;
  background:
    radial-gradient(circle at 88% 78%, rgba(46, 125, 70, 0.11), transparent 28%),
    linear-gradient(135deg, rgba(255, 255, 255, 0.99), rgba(255, 250, 242, 0.94)),
    var(--vm-hero-bg);
  box-shadow: var(--vm-hero-shadow);
  overflow: hidden;
}

.shell__compact::before,
.shell__compact::after {
  content: "";
  position: absolute;
  pointer-events: none;
}

.shell__compact::before {
  inset: 0 0 auto 0;
  height: 7rpx;
  background: linear-gradient(90deg, var(--vm-accent), rgba(255, 138, 43, 0.9));
}

.shell__compact::after {
  right: 26rpx;
  bottom: -34rpx;
  width: 170rpx;
  height: 120rpx;
  border-radius: 50%;
  background: rgba(46, 125, 70, 0.07);
}

.shell__compact-main {
  position: relative;
  z-index: 2;
  min-width: 0;
  flex: 1;
  display: flex;
  flex-direction: column;
  gap: 9rpx;
  padding-right: 130rpx;
}

.shell__compact-access {
  display: none;
}

.shell__compact-side {
  position: relative;
  z-index: 3;
  display: flex;
  align-items: flex-start;
  justify-content: flex-end;
  flex-shrink: 0;
  padding-top: 8rpx;
}

.shell__compact-eyebrow {
  font-size: 22rpx;
  line-height: 1.25;
  letter-spacing: 0.08em;
  color: var(--vm-accent-strong);
}

.shell__compact-title {
  font-size: 46rpx;
  line-height: 1.16;
  font-weight: 800;
  color: var(--vm-text);
}

.shell__compact-subtitle {
  font-size: 24rpx;
  line-height: 1.58;
  color: var(--vm-muted);
}

.shell__compact-mark {
  position: absolute;
  right: 24rpx;
  bottom: 18rpx;
  z-index: 1;
  width: 154rpx;
  height: 122rpx;
  pointer-events: none;
}

.shell__compact-cabinet {
  position: absolute;
  right: 38rpx;
  bottom: 8rpx;
  width: 68rpx;
  height: 96rpx;
  border-radius: 16rpx;
  background: #2e7d46;
  box-shadow: 0 12rpx 28rpx rgba(46, 125, 70, 0.18);
}

.shell__compact-cabinet::before {
  content: "";
  position: absolute;
  inset: 8rpx;
  border-radius: 12rpx;
  border: 3rpx solid rgba(255, 255, 255, 0.34);
}

.shell__compact-cabinet-screen {
  position: absolute;
  left: 12rpx;
  top: 14rpx;
  width: 38rpx;
  height: 72rpx;
  border-radius: 8rpx;
  background:
    linear-gradient(#ff9a33 0 0) 8rpx 12rpx / 8rpx 8rpx no-repeat,
    linear-gradient(#8fcf7f 0 0) 23rpx 12rpx / 8rpx 8rpx no-repeat,
    linear-gradient(#fff0c9 0 0) 8rpx 34rpx / 8rpx 8rpx no-repeat,
    linear-gradient(#ff9a33 0 0) 23rpx 34rpx / 8rpx 8rpx no-repeat,
    #eef8e8;
}

.shell__compact-person {
  position: absolute;
  right: 16rpx;
  bottom: 10rpx;
  width: 18rpx;
  height: 42rpx;
  border-radius: 12rpx 12rpx 8rpx 8rpx;
  background: #ff8a2b;
}

.shell__compact-person::before {
  content: "";
  position: absolute;
  left: 2rpx;
  top: -18rpx;
  width: 16rpx;
  height: 16rpx;
  border-radius: 50%;
  background: #ffbf8a;
}

.shell__compact-leaf {
  position: absolute;
  border-radius: 100% 0 100% 0;
  background: rgba(46, 125, 70, 0.18);
}

.shell__compact-leaf--one {
  width: 58rpx;
  height: 34rpx;
  left: 12rpx;
  bottom: 34rpx;
  transform: rotate(-32deg);
}

.shell__compact-leaf--two {
  width: 42rpx;
  height: 28rpx;
  left: 44rpx;
  bottom: 72rpx;
  background: rgba(255, 138, 43, 0.16);
  transform: rotate(28deg);
}

.shell__hero {
  position: relative;
  display: grid;
  gap: 20rpx;
  padding: 28rpx 28rpx 26rpx;
  border: 1rpx solid var(--vm-hero-border);
  border-radius: 28rpx;
  background:
    linear-gradient(135deg, rgba(46, 125, 70, 0.98), rgba(113, 178, 90, 0.92)),
    var(--vm-hero-bg);
  box-shadow: var(--vm-hero-shadow);
  overflow: hidden;
}

.shell--ops .shell__hero {
  background:
    linear-gradient(135deg, rgba(255, 138, 43, 0.98), rgba(255, 183, 100, 0.92)),
    var(--vm-hero-bg);
}

.shell__hero::before,
.shell__hero::after {
  display: none;
}

.shell__hero-main {
  position: relative;
  z-index: 1;
  display: flex;
  flex-direction: column;
  gap: 14rpx;
}

.shell__care-banner {
  display: grid;
  gap: 12rpx;
  padding: 18rpx 20rpx;
  border-radius: 26rpx;
  border: 2rpx solid rgba(20, 58, 102, 0.22);
  background: #f4f7fb;
}

.shell__care-badge {
  display: inline-flex;
  align-items: center;
  gap: 14rpx;
  width: fit-content;
  max-width: 100%;
}

.shell__care-badge-mark {
  padding: 8rpx 16rpx;
  border-radius: 999rpx;
  background: var(--vm-accent);
  color: #ffffff;
  font-size: 22rpx;
  font-weight: 800;
  line-height: 1;
}

.shell__care-badge-title {
  font-size: 24rpx;
  font-weight: 700;
  color: var(--vm-accent-strong);
}

.shell__care-text {
  font-size: 24rpx;
  line-height: 1.6;
  color: var(--vm-muted);
}

.shell__accessible-lanes {
  display: none;
}

.shell__compact-access-mark {
  font-size: 24rpx;
  font-weight: 800;
  letter-spacing: 0.08em;
  color: var(--vm-accent-strong);
}

.shell__compact-access-body {
  font-size: 26rpx;
  line-height: 1.55;
  color: var(--vm-text);
}

.shell__accessible-lane {
  display: grid;
  gap: 8rpx;
  padding: 18rpx 18rpx 16rpx;
  border-radius: 24rpx;
  border: 4rpx solid transparent;
}

.shell__accessible-lane--contrast {
  background: #edf4fc;
  border-color: rgba(45, 95, 147, 0.22);
}

.shell__accessible-lane--action {
  background: #eef7f1;
  border-color: rgba(47, 125, 91, 0.22);
}

.shell__accessible-lane--group {
  background: #f4f7fb;
  border-color: rgba(31, 122, 74, 0.22);
}

.shell__accessible-lane-title {
  font-size: 28rpx;
  font-weight: 800;
  color: var(--vm-text);
}

.shell__accessible-lane-body {
  font-size: 24rpx;
  line-height: 1.6;
  color: var(--vm-muted);
}

.shell__title-group {
  display: flex;
  flex-direction: column;
  gap: 10rpx;
}

.shell__eyebrow {
  font-size: 22rpx;
  letter-spacing: 0.14em;
  text-transform: uppercase;
  color: var(--vm-accent-strong);
}

.shell__subtitle {
  max-width: 560rpx;
}

.shell__hero-side,
.shell__actions {
  position: relative;
  z-index: 1;
  display: grid;
  gap: 16rpx;
}

.shell__hero .vm-pill {
  background: rgba(255, 255, 255, 0.18);
  color: #ffffff;
  border-color: rgba(255, 255, 255, 0.26);
}

.shell__hero .shell__eyebrow,
.shell__hero .vm-title,
.shell__hero .vm-subtitle {
  color: #ffffff;
}

.shell__content {
  position: relative;
  z-index: 2;
}

.shell--accessible .shell__body {
  gap: 30rpx;
}

.shell--accessible .shell__garden,
.shell--accessible .shell__compact-mark {
  display: none;
}

.shell--accessible .shell__utility {
  display: grid;
  gap: 18rpx;
}

.shell--accessible .shell__utility-left {
  width: 100%;
  flex-direction: column;
  align-items: stretch;
  gap: 14rpx;
  padding: 18rpx 20rpx;
  border: 4rpx solid rgba(20, 58, 102, 0.16);
  border-radius: 28rpx;
  background: #ffffff;
}

.shell--accessible .shell__utility-right {
  width: 100%;
}

.shell--accessible .shell__utility-right :deep(.accessibility-menu) {
  width: 100%;
  justify-content: space-between;
}

.shell--accessible .shell__compact {
  display: grid;
  gap: 20rpx;
  padding: 28rpx 26rpx;
  border: 4rpx solid var(--vm-hero-border);
  border-radius: 32rpx;
  background: var(--vm-hero-bg);
}

.shell--accessible .shell__compact-side {
  padding-top: 0;
}

.shell--accessible .shell__compact-main {
  padding-right: 0;
}

.shell--accessible .shell__compact-access {
  display: grid;
  gap: 8rpx;
  padding: 18rpx 20rpx;
  border-radius: 24rpx;
  border: 4rpx solid rgba(20, 58, 102, 0.18);
  background: #f4f7fb;
}

.shell--accessible .shell__hero {
  grid-template-columns: 1fr;
  gap: 24rpx;
  padding: 32rpx 28rpx 30rpx;
}

.shell--accessible .shell__hero-main {
  gap: 18rpx;
}

.shell--accessible .shell__accessible-lanes {
  display: grid;
  gap: 14rpx;
}

.shell--accessible .shell__content {
  gap: 28rpx;
}

.shell--accessible .shell__subtitle {
  max-width: none;
}

.vm-page--accessible .shell__hero {
  padding: 34rpx 30rpx;
  border-width: 4rpx;
  border-radius: 30rpx;
  box-shadow: none;
}

.vm-page--accessible .shell__utility {
  min-height: 84rpx;
}

.vm-page--accessible .shell__elder-dot {
  width: 50rpx;
  height: 50rpx;
}

.vm-page--accessible .shell__elder-text {
  font-size: 34rpx;
}

.vm-page--accessible .shell__compact-title {
  font-size: 54rpx;
  line-height: 1.2;
}

.vm-page--accessible .shell__compact-subtitle {
  font-size: 30rpx;
  line-height: 1.75;
  color: var(--vm-text);
}

.vm-page--accessible .shell__hero::before,
.vm-page--accessible .shell__hero::after {
  display: none;
}

.vm-page--accessible .shell__eyebrow {
  font-size: 26rpx;
  font-weight: 700;
  letter-spacing: 0.08em;
}

.vm-page--accessible .shell__subtitle {
  max-width: none;
}

.vm-page--accessible .shell__care-banner {
  gap: 18rpx;
  padding: 26rpx 24rpx;
  border-width: 4rpx;
  border-color: rgba(20, 58, 102, 0.32);
}

.vm-page--accessible .shell__care-badge-mark {
  padding: 12rpx 20rpx;
  font-size: 28rpx;
}

.vm-page--accessible .shell__care-badge-title {
  font-size: 32rpx;
}

.vm-page--accessible .shell__care-text {
  font-size: 30rpx;
  line-height: 1.72;
  color: #1f3855;
}

.vm-page--accessible .shell__accessible-lane-title {
  font-size: 30rpx;
}

.vm-page--accessible .shell__accessible-lane-body {
  font-size: 26rpx;
  line-height: 1.68;
  color: var(--vm-text);
}

.vm-page--accessible .shell__compact-access-mark {
  font-size: 28rpx;
}

.vm-page--accessible .shell__compact-access-body {
  font-size: 28rpx;
}

@media screen and (min-width: 720px) {
  .shell {
    max-width: 960rpx;
  }

  .shell__hero {
    grid-template-columns: minmax(0, 1.4fr) minmax(220rpx, 0.8fr);
    align-items: start;
  }

  .shell--accessible .shell__accessible-lanes {
    grid-template-columns: repeat(3, minmax(0, 1fr));
  }
}
</style>
