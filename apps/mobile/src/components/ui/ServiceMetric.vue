<script setup lang="ts">
import { computed } from "vue";

const props = withDefaults(
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

const isLongValue = computed(() => String(props.value).length >= 7);
</script>

<template>
  <view class="service-metric" :class="[`service-metric--${tone}`, { 'service-metric--long': isLongValue }]">
    <text class="service-metric__label">{{ label }}</text>
    <text class="vm-number service-metric__value">{{ value }}</text>
    <text v-if="hint" class="service-metric__hint">{{ hint }}</text>
  </view>
</template>

<style scoped>
.service-metric {
  display: flex;
  flex-direction: column;
  justify-content: flex-start;
  gap: 9rpx;
  min-height: 138rpx;
  padding: 20rpx 18rpx;
  border-radius: 20rpx;
  border: 1rpx solid var(--vm-line-strong);
  box-shadow: inset 0 1rpx 0 rgba(255, 255, 255, 0.55);
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
  min-height: 28rpx;
  font-size: 22rpx;
  line-height: 1.28;
  color: var(--vm-muted);
}

.service-metric__value {
  font-size: 44rpx;
  line-height: 1;
  color: var(--vm-accent-strong);
  font-weight: 800;
  white-space: nowrap;
}

.service-metric__hint {
  font-size: 20rpx;
  color: var(--vm-text-soft);
  line-height: 1.45;
}

.service-metric--long .service-metric__value {
  font-size: 28rpx;
  line-height: 1.08;
}

:global(.vm-page--accessible) .service-metric {
  min-height: 220rpx;
  gap: 16rpx;
  padding: 28rpx;
  border-width: 4rpx;
  border-radius: 30rpx;
  box-shadow: none;
}

:global(.vm-page--accessible) .service-metric--neutral {
  background: var(--vm-card-quiet-bg);
}

:global(.vm-page--accessible) .service-metric--accent {
  background: var(--vm-info-bg);
  border-color: var(--vm-info-line);
}

:global(.vm-page--accessible) .service-metric--warning {
  background: var(--vm-warning-bg);
  border-color: var(--vm-warning-line);
}

:global(.vm-page--accessible) .service-metric__label {
  font-size: 26rpx;
  font-weight: 700;
  color: var(--vm-text);
}

:global(.vm-page--accessible) .service-metric__value {
  font-size: 64rpx;
}

:global(.vm-page--accessible) .service-metric__hint {
  font-size: 24rpx;
  line-height: 1.6;
  color: var(--vm-text);
}
</style>
