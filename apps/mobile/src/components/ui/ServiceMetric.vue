<script setup lang="ts">
withDefaults(
  defineProps<{
    label: string;
    value: string | number;
    hint?: string;
    tone?: "neutral" | "accent" | "warning";
  }>(),
  {
    hint: "",
    tone: "neutral"
  }
);
</script>

<template>
  <view class="service-metric" :class="`service-metric--${tone}`">
    <text class="service-metric__label">{{ label }}</text>
    <text class="vm-number service-metric__value">{{ value }}</text>
    <text v-if="hint" class="service-metric__hint">{{ hint }}</text>
  </view>
</template>

<style scoped>
.service-metric {
  display: flex;
  flex-direction: column;
  gap: 12rpx;
  min-height: 176rpx;
  padding: 24rpx;
  border-radius: 28rpx;
  border: 1rpx solid var(--vm-line-strong);
  box-shadow: inset 0 1rpx 0 rgba(255, 255, 255, 0.45);
}

.service-metric--neutral {
  background: rgba(255, 255, 255, 0.76);
}

.service-metric--accent {
  background: linear-gradient(180deg, rgba(243, 255, 248, 0.96), rgba(229, 246, 239, 0.92));
}

.service-metric--warning {
  background: linear-gradient(180deg, rgba(255, 250, 238, 0.98), rgba(255, 241, 215, 0.94));
}

.service-metric__label {
  font-size: 22rpx;
  color: var(--vm-muted);
}

.service-metric__value {
  font-size: 54rpx;
  line-height: 1;
  color: var(--vm-text);
}

.service-metric__hint {
  font-size: 22rpx;
  color: var(--vm-text-soft);
  line-height: 1.5;
}
</style>
