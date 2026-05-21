<script setup lang="ts">
export type FlowStepState = "done" | "current" | "todo" | "warning";

defineProps<{
  steps: Array<{
    label: string;
    description?: string;
    state: FlowStepState;
  }>;
}>();
</script>

<template>
  <view class="flow-steps">
    <view
      v-for="(step, index) in steps"
      :key="`${index}-${step.label}`"
      class="flow-step"
      :class="`flow-step--${step.state}`"
    >
      <view class="flow-step__mark">
        <text v-if="step.state === 'done'" class="flow-step__symbol">✓</text>
        <text v-else class="flow-step__symbol">{{ index + 1 }}</text>
      </view>
      <view class="flow-step__copy">
        <text class="flow-step__label">{{ step.label }}</text>
        <text v-if="step.description" class="flow-step__description">{{ step.description }}</text>
      </view>
    </view>
  </view>
</template>

<style scoped>
.flow-steps {
  display: grid;
  gap: 14rpx;
}

.flow-step {
  display: grid;
  grid-template-columns: auto minmax(0, 1fr);
  gap: 14rpx;
  align-items: start;
  padding: 18rpx 20rpx;
  border-radius: 22rpx;
  border: 1rpx solid var(--vm-line);
  background: var(--vm-surface-soft);
}

.flow-step__mark {
  display: grid;
  place-items: center;
  width: 48rpx;
  height: 48rpx;
  border-radius: 50%;
  background: #ffffff;
  border: 2rpx solid var(--vm-line-strong);
  color: var(--vm-text-soft);
  font-size: 24rpx;
  font-weight: 800;
}

.flow-step__copy {
  display: grid;
  gap: 6rpx;
  min-width: 0;
}

.flow-step__label {
  font-size: 26rpx;
  font-weight: 800;
  color: var(--vm-text);
}

.flow-step__description {
  font-size: 22rpx;
  line-height: 1.5;
  color: var(--vm-text-soft);
}

.flow-step--done {
  background: var(--vm-success-bg);
  border-color: var(--vm-success-line);
}

.flow-step--done .flow-step__mark {
  background: var(--vm-success);
  border-color: var(--vm-success);
  color: #ffffff;
}

.flow-step--current {
  background: var(--vm-accent-bg);
  border-color: var(--vm-accent-line);
}

.flow-step--current .flow-step__mark {
  background: var(--vm-accent);
  border-color: var(--vm-accent);
  color: #ffffff;
}

.flow-step--warning {
  background: var(--vm-warning-bg);
  border-color: var(--vm-warning-line);
}

.flow-step--warning .flow-step__mark {
  background: var(--vm-warning);
  border-color: var(--vm-warning);
  color: #ffffff;
}

:global(.vm-page--accessible) .flow-step {
  border-width: 3rpx;
  padding: 22rpx;
}

:global(.vm-page--accessible) .flow-step__mark {
  width: 64rpx;
  height: 64rpx;
  font-size: 30rpx;
}

:global(.vm-page--accessible) .flow-step__label {
  font-size: 32rpx;
}

:global(.vm-page--accessible) .flow-step__description {
  font-size: 26rpx;
  color: var(--vm-text);
}
</style>
