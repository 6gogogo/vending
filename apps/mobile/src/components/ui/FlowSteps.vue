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
  position: relative;
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(132rpx, 1fr));
  gap: 12rpx;
  padding: 18rpx 6rpx 8rpx;
}

.flow-steps::before {
  content: "";
  position: absolute;
  left: 64rpx;
  right: 64rpx;
  top: 43rpx;
  height: 4rpx;
  border-radius: 999rpx;
  background: var(--vm-line-strong);
}

.flow-step {
  position: relative;
  z-index: 1;
  display: grid;
  justify-items: center;
  gap: 11rpx;
  min-width: 0;
  padding: 0 4rpx;
  text-align: center;
}

.flow-step__mark {
  display: grid;
  place-items: center;
  width: 54rpx;
  height: 54rpx;
  border-radius: 50%;
  background: #ffffff;
  border: 2rpx solid var(--vm-line-strong);
  color: var(--vm-text-soft);
  font-size: 24rpx;
  font-weight: 800;
  box-shadow: 0 8rpx 18rpx rgba(88, 61, 30, 0.08);
}

.flow-step__copy {
  display: grid;
  gap: 6rpx;
  min-width: 0;
  justify-items: center;
}

.flow-step__label {
  font-size: 23rpx;
  line-height: 1.24;
  font-weight: 800;
  color: var(--vm-text);
}

.flow-step__description {
  max-width: 138rpx;
  font-size: 19rpx;
  line-height: 1.42;
  color: var(--vm-text-soft);
}

.flow-step--done {
  color: var(--vm-success);
}

.flow-step--done .flow-step__mark {
  background: var(--vm-success);
  border-color: var(--vm-success);
  color: #ffffff;
}

.flow-step--current {
  color: var(--vm-accent);
}

.flow-step--current .flow-step__mark {
  background: var(--vm-accent);
  border-color: var(--vm-accent);
  color: #ffffff;
}

.flow-step--warning {
  color: var(--vm-warning);
}

.flow-step--warning .flow-step__mark {
  background: var(--vm-warning);
  border-color: var(--vm-warning);
  color: #ffffff;
}

:global(.vm-page--accessible) .flow-step {
  padding: 8rpx;
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
