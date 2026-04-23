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
  <view class="vm-page shell" :class="[`shell--${resolvedMode}`, { 'vm-page--accessible': accessibilityEnabled }]">
    <view class="shell__shape shell__shape--sun" />
    <view class="shell__shape shell__shape--leaf" />
    <view class="shell__body">
      <view v-if="showUtilityBar" class="shell__utility vm-fade-up">
        <view class="shell__utility-left">
          <slot name="header-left" />
          <view v-if="accessibilityEnabled" class="shell__elder-mark">
            <view class="shell__elder-dot" />
            <text class="shell__elder-text">敬老版</text>
          </view>
        </view>
        <view v-if="props.headerStyle === 'panel' && $slots['header-right']" class="shell__utility-right">
          <slot name="header-right" />
        </view>
      </view>

      <template v-if="props.headerStyle === 'panel'">
        <view class="shell__hero vm-fade-up">
          <view class="shell__hero-main">
            <view v-if="accessibilityEnabled" class="shell__care-banner">
              <view class="shell__care-badge">
                <text class="shell__care-badge-mark">关怀版</text>
                <text class="shell__care-badge-title">无障碍模式已开启</text>
              </view>
              <text class="shell__care-text">大字显示 · 高对比界面 · 更大按钮和输入框</text>
            </view>
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
      <view v-else class="shell__compact vm-fade-up">
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

      <view class="shell__content vm-stack">
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
  --vm-accent: #1d6fdc;
  --vm-accent-strong: #1958b4;
  --vm-warning: #c8821d;
  --vm-danger: #c45442;
  --vm-shadow: 0 26rpx 76rpx rgba(28, 59, 95, 0.1);
  --vm-button-shadow: 0 18rpx 48rpx rgba(29, 111, 220, 0.16);
  --vm-page-gradient:
    radial-gradient(circle at 100% 0%, rgba(29, 111, 220, 0.15), transparent 24%),
    radial-gradient(circle at 0% 12%, rgba(86, 167, 255, 0.1), transparent 28%),
    linear-gradient(180deg, #f8fbff 0%, #f2f6fb 52%, #edf2f8 100%);
  --vm-card-bg: linear-gradient(180deg, rgba(255, 255, 255, 0.98), rgba(246, 249, 253, 0.94));
  --vm-card-accent-bg: linear-gradient(180deg, #eff6ff, #e7f0fc);
  --vm-card-warning-bg: linear-gradient(180deg, #fff8ee, #fff0dc);
  --vm-card-quiet-bg: linear-gradient(180deg, rgba(248, 251, 255, 0.96), rgba(242, 247, 252, 0.92));
  --vm-card-highlight: linear-gradient(90deg, rgba(29, 111, 220, 0.22), rgba(86, 167, 255, 0.12));
  --vm-hero-bg: linear-gradient(140deg, rgba(255, 255, 255, 0.99), rgba(239, 246, 255, 0.94));
  --vm-hero-border: rgba(30, 65, 102, 0.12);
  --vm-hero-shadow: 0 30rpx 90rpx rgba(28, 59, 95, 0.12);
  --vm-pill-bg: rgba(29, 111, 220, 0.1);
  --vm-pill-text: #1958b4;
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
  background:
    radial-gradient(circle at 35% 35%, #fef3c7 0 26%, transparent 27%),
    radial-gradient(circle at 65% 35%, #fde68a 0 26%, transparent 27%),
    linear-gradient(135deg, #5aa0ff, #2f78e7);
  box-shadow: inset 0 0 0 2rpx rgba(255, 255, 255, 0.42);
}

.shell__elder-text {
  font-size: 30rpx;
  font-weight: 800;
  color: #2f78e7;
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
  content: "";
  position: absolute;
  pointer-events: none;
}

.shell__hero::before {
  inset: 0;
  background:
    linear-gradient(120deg, rgba(255, 255, 255, 0.08), transparent 42%),
    radial-gradient(circle at 100% 0%, rgba(13, 148, 136, 0.08), transparent 28%);
}

.shell__hero::after {
  top: 14rpx;
  right: 18rpx;
  width: 180rpx;
  height: 120rpx;
  border-radius: 999rpx;
  opacity: 0.28;
  background:
    repeating-linear-gradient(
      135deg,
      rgba(13, 148, 136, 0.18) 0,
      rgba(13, 148, 136, 0.18) 4rpx,
      transparent 4rpx,
      transparent 14rpx
    );
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
  border: 2rpx solid rgba(47, 120, 231, 0.22);
  background: linear-gradient(180deg, rgba(235, 244, 255, 0.96), rgba(245, 249, 255, 0.96));
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
  background: #2f78e7;
  color: #ffffff;
  font-size: 22rpx;
  font-weight: 800;
  line-height: 1;
}

.shell__care-badge-title {
  font-size: 24rpx;
  font-weight: 700;
  color: #144aa0;
}

.shell__care-text {
  font-size: 24rpx;
  line-height: 1.6;
  color: #24476d;
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
  background: radial-gradient(circle, rgba(255, 202, 96, 0.38), rgba(255, 202, 96, 0));
}

.shell__shape--leaf {
  bottom: 160rpx;
  left: -120rpx;
  width: 280rpx;
  height: 280rpx;
  background: radial-gradient(circle, rgba(61, 168, 116, 0.16), rgba(61, 168, 116, 0));
}

.shell--ops .shell__shape--sun {
  background: radial-gradient(circle, rgba(86, 167, 255, 0.3), rgba(86, 167, 255, 0));
}

.shell--ops .shell__shape--leaf {
  background: radial-gradient(circle, rgba(29, 111, 220, 0.14), rgba(29, 111, 220, 0));
}

.shell--ops .shell__hero::before {
  background:
    linear-gradient(120deg, rgba(255, 255, 255, 0.08), transparent 42%),
    radial-gradient(circle at 100% 0%, rgba(29, 111, 220, 0.08), transparent 30%);
}

.shell--ops .shell__hero::after {
  background:
    repeating-linear-gradient(
      135deg,
      rgba(29, 111, 220, 0.16) 0,
      rgba(29, 111, 220, 0.16) 4rpx,
      transparent 4rpx,
      transparent 14rpx
    );
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
  gap: 16rpx;
  padding: 24rpx 24rpx;
  border-width: 4rpx;
  border-color: rgba(47, 120, 231, 0.34);
}

.vm-page--accessible .shell__care-badge-mark {
  padding: 10rpx 18rpx;
  font-size: 26rpx;
}

.vm-page--accessible .shell__care-badge-title {
  font-size: 30rpx;
}

.vm-page--accessible .shell__care-text {
  font-size: 28rpx;
  line-height: 1.7;
  color: #1e3a5f;
}

.vm-page--accessible .shell__shape {
  opacity: 0;
}

@media screen and (min-width: 720px) {
  .shell__hero {
    grid-template-columns: minmax(0, 1.4fr) minmax(220rpx, 0.8fr);
    align-items: start;
  }
}
</style>
