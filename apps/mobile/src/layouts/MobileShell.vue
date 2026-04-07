<script setup lang="ts">
defineProps<{
  eyebrow: string;
  title: string;
  subtitle: string;
}>();
</script>

<template>
  <view class="vm-page shell">
    <view class="shell__glow shell__glow--one" />
    <view class="shell__glow shell__glow--two" />
    <view class="shell__body vm-stack">
      <view class="vm-fade-up">
        <text class="vm-pill">{{ eyebrow }}</text>
        <view style="height: 20rpx;" />
        <text class="vm-title">{{ title }}</text>
        <view style="height: 16rpx;" />
        <text class="vm-subtitle">{{ subtitle }}</text>
      </view>
      <slot />
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
}

.shell__glow {
  position: absolute;
  width: 320rpx;
  height: 320rpx;
  border-radius: 50%;
  filter: blur(70rpx);
  opacity: 0.4;
}

.shell__glow--one {
  top: -80rpx;
  right: -60rpx;
  background: rgba(61, 208, 165, 0.35);
}

.shell__glow--two {
  bottom: 80rpx;
  left: -120rpx;
  background: rgba(104, 164, 255, 0.24);
}
</style>
