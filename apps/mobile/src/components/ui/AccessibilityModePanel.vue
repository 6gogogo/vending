<script setup lang="ts">
const props = withDefaults(
  defineProps<{
    checked: boolean;
    description?: string;
    title?: string;
  }>(),
  {
    title: "关怀版（普通用户）",
    description: "开启后使用大字、高对比、整屏按钮和更清楚的页面布局，更方便老年人和低视力用户操作。"
  }
);

const emit = defineEmits<{
  (event: "update:checked", value: boolean): void;
}>();

const handleChange = (event: { detail?: { value?: boolean } }) => {
  emit("update:checked", Boolean(event.detail?.value));
};
</script>

<template>
  <view class="accessibility-panel">
    <view class="accessibility-panel__main">
      <text class="accessibility-panel__title">{{ props.title }}</text>
      <text class="accessibility-panel__body">{{ props.description }}</text>
    </view>
    <switch :checked="checked" color="#2f78e7" @change="handleChange" />
  </view>
</template>

<style scoped>
.accessibility-panel {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 24rpx;
}

.accessibility-panel__main {
  display: flex;
  flex: 1;
  min-width: 0;
  flex-direction: column;
  gap: 8rpx;
}

.accessibility-panel__title {
  font-size: 28rpx;
  font-weight: 700;
  color: var(--vm-text);
}

.accessibility-panel__body {
  font-size: 22rpx;
  line-height: 1.6;
  color: var(--vm-text-soft);
}
</style>
