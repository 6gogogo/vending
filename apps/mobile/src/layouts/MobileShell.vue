<script setup lang="ts">
import { computed } from "vue";

type ShellMode = "care" | "ops";

const props = withDefaults(
  defineProps<{
    eyebrow: string;
    title: string;
    subtitle: string;
    mode?: ShellMode;
  }>(),
  {
    mode: undefined
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
</script>

<template>
  <view class="vm-page shell" :class="`shell--${resolvedMode}`">
    <view class="shell__shape shell__shape--sun" />
    <view class="shell__shape shell__shape--leaf" />
    <view class="shell__body">
      <view class="shell__hero vm-fade-up">
        <view class="shell__hero-main">
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
  gap: 28rpx;
}

.shell__hero {
  display: grid;
  gap: 20rpx;
  padding: 36rpx 32rpx;
  border: 1rpx solid var(--vm-hero-border);
  border-radius: 40rpx;
  background: var(--vm-hero-bg);
  box-shadow: var(--vm-hero-shadow);
}

.shell__hero-main {
  display: flex;
  flex-direction: column;
  gap: 18rpx;
}

.shell__title-group {
  display: flex;
  flex-direction: column;
  gap: 12rpx;
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

@media screen and (min-width: 720px) {
  .shell__hero {
    grid-template-columns: minmax(0, 1.4fr) minmax(220rpx, 0.8fr);
    align-items: start;
  }
}
</style>
