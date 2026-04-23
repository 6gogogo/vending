<script setup lang="ts">
import { computed, useSlots } from "vue";

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

uiPreferencesStore.hydrate();

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
</script>

<template>
  <view
    class="vm-page shell"
    :class="[`shell--${resolvedMode}`, { 'vm-page--accessible': accessibilityEnabled, 'shell--accessible': accessibilityEnabled }]"
  >
    <view class="shell__shape shell__shape--sun" />
    <view class="shell__shape shell__shape--leaf" />
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
  overflow: hidden;
  background: var(--vm-page-gradient);
}

.shell--care {
  --vm-bg: #f7f9fc;
  --vm-bg-soft: #eef2f7;
  --vm-surface: rgba(255, 255, 255, 0.96);
  --vm-surface-strong: #ffffff;
  --vm-surface-soft: rgba(248, 250, 253, 0.94);
  --vm-line: rgba(20, 58, 102, 0.1);
  --vm-line-strong: rgba(20, 58, 102, 0.18);
  --vm-text: #1b2d43;
  --vm-muted: #6a7688;
  --vm-text-soft: #7f8998;
  --vm-accent: #2f7d5b;
  --vm-accent-strong: #245f45;
  --vm-shadow: 0 26rpx 76rpx rgba(45, 95, 147, 0.1);
  --vm-button-shadow: 0 18rpx 42rpx rgba(47, 125, 91, 0.14);
  --vm-page-gradient: #f7f9fc;
  --vm-card-bg: #ffffff;
  --vm-card-accent-bg: var(--vm-accent-bg);
  --vm-card-warning-bg: var(--vm-warning-bg);
  --vm-card-quiet-bg: #f4f7fb;
  --vm-card-highlight: var(--vm-accent);
  --vm-hero-bg: #ffffff;
  --vm-hero-border: rgba(20, 58, 102, 0.12);
  --vm-hero-shadow: 0 30rpx 90rpx rgba(45, 95, 147, 0.11);
  --vm-pill-bg: var(--vm-accent-soft);
  --vm-pill-text: var(--vm-accent-strong);
}

.shell--ops {
  --vm-bg: #f3f7fc;
  --vm-bg-soft: #eef4fb;
  --vm-surface: rgba(255, 255, 255, 0.96);
  --vm-surface-strong: #ffffff;
  --vm-surface-soft: rgba(246, 249, 253, 0.94);
  --vm-line: rgba(30, 65, 102, 0.1);
  --vm-line-strong: rgba(30, 65, 102, 0.18);
  --vm-text: #15293b;
  --vm-muted: #5b7187;
  --vm-text-soft: #6d8196;
  --vm-accent: #2f7d5b;
  --vm-accent-strong: #245f45;
  --vm-warning: #c8821d;
  --vm-danger: #c45442;
  --vm-shadow: 0 26rpx 76rpx rgba(28, 59, 95, 0.1);
  --vm-button-shadow: 0 18rpx 42rpx rgba(47, 125, 91, 0.14);
  --vm-page-gradient: #f5f8fb;
  --vm-card-bg: #ffffff;
  --vm-card-accent-bg: var(--vm-accent-bg);
  --vm-card-warning-bg: var(--vm-warning-bg);
  --vm-card-quiet-bg: #f2f6fb;
  --vm-card-highlight: var(--vm-accent);
  --vm-hero-bg: #ffffff;
  --vm-hero-border: rgba(30, 65, 102, 0.12);
  --vm-hero-shadow: 0 30rpx 90rpx rgba(28, 59, 95, 0.12);
  --vm-pill-bg: var(--vm-accent-soft);
  --vm-pill-text: var(--vm-accent-strong);
}

.shell__body {
  position: relative;
  z-index: 2;
  display: flex;
  flex-direction: column;
  gap: 24rpx;
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
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 18rpx;
}

.shell__compact-main {
  min-width: 0;
  flex: 1;
  display: flex;
  flex-direction: column;
  gap: 10rpx;
}

.shell__compact-access {
  display: none;
}

.shell__compact-side {
  display: flex;
  align-items: flex-start;
  justify-content: flex-end;
  flex-shrink: 0;
  padding-top: 34rpx;
}

.shell__compact-eyebrow {
  font-size: 22rpx;
  letter-spacing: 0.12em;
  color: var(--vm-accent-strong);
}

.shell__compact-title {
  font-size: 44rpx;
  line-height: 1.18;
  font-weight: 800;
  color: var(--vm-text);
}

.shell__compact-subtitle {
  font-size: 24rpx;
  line-height: 1.65;
  color: var(--vm-muted);
}

.shell__hero {
  position: relative;
  display: grid;
  gap: 20rpx;
  padding: 28rpx 28rpx 26rpx;
  border: 1rpx solid var(--vm-hero-border);
  border-radius: 34rpx;
  background: var(--vm-hero-bg);
  box-shadow: var(--vm-hero-shadow);
  overflow: hidden;
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

.shell__content {
  position: relative;
  z-index: 2;
}

.shell__shape {
  position: absolute;
  border-radius: 999rpx;
  opacity: 0.7;
  pointer-events: none;
}

.shell__shape--sun {
  top: -120rpx;
  right: -120rpx;
  width: 360rpx;
  height: 360rpx;
  background: rgba(47, 125, 91, 0.1);
}

.shell__shape--leaf {
  bottom: 160rpx;
  left: -120rpx;
  width: 280rpx;
  height: 280rpx;
  background: rgba(58, 120, 216, 0.08);
}

.shell--ops .shell__shape--sun {
  background: rgba(58, 120, 216, 0.1);
}

.shell--ops .shell__shape--leaf {
  background: rgba(20, 58, 102, 0.08);
}

.shell--accessible .shell__body {
  gap: 30rpx;
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

.vm-page--accessible .shell__shape {
  opacity: 0;
}

@media screen and (min-width: 720px) {
  .shell__hero {
    grid-template-columns: minmax(0, 1.4fr) minmax(220rpx, 0.8fr);
    align-items: start;
  }

  .shell--accessible .shell__accessible-lanes {
    grid-template-columns: repeat(3, minmax(0, 1fr));
  }
}
</style>
