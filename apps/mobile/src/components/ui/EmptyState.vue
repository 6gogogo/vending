<script setup lang="ts">
defineProps<{
  title: string;
  description: string;
}>();
</script>

<template>
  <view class="vm-empty">
    <text class="vm-empty__title">{{ title }}</text>
    <text class="vm-empty__body">{{ description }}</text>
  </view>
</template>
