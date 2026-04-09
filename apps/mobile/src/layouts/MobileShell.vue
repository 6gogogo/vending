<script setup lang="ts">
withDefaults(
  defineProps<{
    eyebrow: string;
    title: string;
    subtitle: string;
  }>(),
  {}
);
</script>

<template>
  <view class="vm-page shell">
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
  padding: 34rpx 32rpx;
  border: 1rpx solid rgba(159, 127, 94, 0.18);
  border-radius: 40rpx;
  background:
    linear-gradient(140deg, rgba(255, 255, 255, 0.95), rgba(247, 238, 222, 0.92)),
    rgba(255, 255, 255, 0.88);
  box-shadow: 0 26rpx 72rpx rgba(133, 100, 54, 0.12);
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
  letter-spacing: 0.3em;
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
  background: radial-gradient(circle, rgba(255, 202, 96, 0.48), rgba(255, 202, 96, 0));
}

.shell__shape--leaf {
  bottom: 160rpx;
  left: -120rpx;
  width: 280rpx;
  height: 280rpx;
  background: radial-gradient(circle, rgba(61, 168, 116, 0.18), rgba(61, 168, 116, 0));
}

@media screen and (min-width: 720px) {
  .shell__hero {
    grid-template-columns: minmax(0, 1.4fr) minmax(220rpx, 0.8fr);
    align-items: start;
  }
}
</style>
