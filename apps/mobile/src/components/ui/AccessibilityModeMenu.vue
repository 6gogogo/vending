<script setup lang="ts">
import { computed } from "vue";

const props = defineProps<{
  checked: boolean;
}>();

const emit = defineEmits<{
  (event: "update:checked", value: boolean): void;
}>();

const actionLabel = computed(() => (props.checked ? "切换标准版" : "切换关怀版"));
const confirmTitle = computed(() => (props.checked ? "切换标准版" : "切换关怀版"));
const confirmContent = computed(() =>
  props.checked
    ? "确认切换回标准版？页面会恢复常规字号和布局。"
    : "确认切换到关怀版？页面会启用更大的文字、更高对比和更清楚的操作布局。"
);

const openMenu = () => {
  uni.showActionSheet({
    itemList: [actionLabel.value],
    success: () => {
      uni.showModal({
        title: confirmTitle.value,
        content: confirmContent.value,
        confirmText: "确认切换",
        cancelText: "取消",
        success: ({ confirm }) => {
          if (!confirm) {
            return;
          }

          emit("update:checked", !props.checked);
          uni.showToast({
            title: props.checked ? "已切换到标准版" : "已切换到关怀版",
            icon: "none"
          });
        }
      });
    }
  });
};
</script>

<template>
  <button class="accessibility-menu" @tap="openMenu">
    <text class="accessibility-menu__text">{{ actionLabel }}</text>
    <view class="accessibility-menu__icon" aria-hidden="true">
      <view class="accessibility-menu__line accessibility-menu__line--top" />
      <view class="accessibility-menu__line accessibility-menu__line--middle" />
      <view class="accessibility-menu__line accessibility-menu__line--bottom" />
    </view>
  </button>
</template>

<style scoped>
.accessibility-menu {
  display: inline-flex;
  align-items: center;
  justify-content: flex-end;
  gap: 16rpx;
  min-height: 64rpx;
  padding: 0;
  border: 0;
  background: transparent;
  color: var(--vm-text);
}

.accessibility-menu__text {
  font-size: 28rpx;
  font-weight: 600;
  color: inherit;
}

.accessibility-menu__icon {
  position: relative;
  width: 50rpx;
  height: 50rpx;
  border-radius: 50%;
  border: 1rpx solid var(--vm-line-strong);
  background: var(--vm-surface-strong);
}

.accessibility-menu__line {
  position: absolute;
  left: 50%;
  width: 16rpx;
  height: 4rpx;
  border-radius: 999rpx;
  background: currentColor;
  transform: translateX(-50%);
}

.accessibility-menu__line--top {
  top: 15rpx;
}

.accessibility-menu__line--middle {
  top: 23rpx;
  width: 20rpx;
}

.accessibility-menu__line--bottom {
  top: 31rpx;
  width: 12rpx;
}
</style>
