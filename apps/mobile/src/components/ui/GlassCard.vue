<script setup lang="ts">
withDefaults(
  defineProps<{
    tone?: "neutral" | "accent" | "warning" | "quiet";
    compact?: boolean;
  }>(),
  {
    tone: "neutral",
    compact: false
  }
);
</script>

<template>
  <view class="vm-card" :class="[`vm-card--${tone}`, compact ? 'vm-card--compact' : 'vm-card--regular']">
    <slot />
  </view>
</template>
