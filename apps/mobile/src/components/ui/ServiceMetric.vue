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
  background: var(--vm-surface-soft);
}

.service-metric--accent {
  background: var(--vm-accent-bg);
}

.service-metric--warning {
  background: var(--vm-warning-bg);
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

.vm-page--accessible .service-metric {
  min-height: 220rpx;
  gap: 16rpx;
  padding: 28rpx;
  border-width: 4rpx;
  border-radius: 30rpx;
  box-shadow: none;
}

.vm-page--accessible .service-metric--neutral {
  background: var(--vm-card-quiet-bg);
}

.vm-page--accessible .service-metric--accent {
  background: var(--vm-info-bg);
  border-color: var(--vm-info-line);
}

.vm-page--accessible .service-metric--warning {
  background: var(--vm-warning-bg);
  border-color: var(--vm-warning-line);
}

.vm-page--accessible .service-metric__label {
  font-size: 26rpx;
  font-weight: 700;
  color: var(--vm-text);
}

.vm-page--accessible .service-metric__value {
  font-size: 64rpx;
}

.vm-page--accessible .service-metric__hint {
  font-size: 24rpx;
  line-height: 1.6;
  color: var(--vm-text);
}
</style>
