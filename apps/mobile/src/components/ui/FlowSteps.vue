<script setup lang="ts">
import { computed } from "vue";

export type FlowStepState = "done" | "current" | "todo" | "warning";

const props = defineProps<{
  steps: Array<{
    label: string;
    description?: string;
    state: FlowStepState;
  }>;
}>();

const stepCountStyle = computed(() => ({
  "--flow-step-count": String(Math.min(Math.max(props.steps.length, 1), 4))
}));
</script>

<template>
  <view class="flow-steps" :style="stepCountStyle" :class="{ 'flow-steps--many': steps.length >= 4 }">
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
  grid-template-columns: repeat(var(--flow-step-count), minmax(0, 1fr));
  gap: 12rpx;
  width: 100%;
  min-width: 0;
  box-sizing: border-box;
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
  display: block;
  max-width: 100%;
  font-size: 23rpx;
  line-height: 1.24;
  font-weight: 800;
  color: var(--vm-text);
  overflow-wrap: anywhere;
}

.flow-step__description {
  display: block;
  max-width: 138rpx;
  font-size: 19rpx;
  line-height: 1.42;
  color: var(--vm-text-soft);
  overflow-wrap: anywhere;
}

.flow-steps--many {
  gap: 6rpx;
  padding-inline: 0;
}

.flow-steps--many::before {
  left: 42rpx;
  right: 42rpx;
}

.flow-steps--many .flow-step {
  padding: 0;
}

.flow-steps--many .flow-step__mark {
  width: 50rpx;
  height: 50rpx;
  font-size: 22rpx;
}

.flow-steps--many .flow-step__label {
  font-size: 22rpx;
}

.flow-steps--many .flow-step__description {
  max-width: 118rpx;
  font-size: 18rpx;
  line-height: 1.35;
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

</style>
