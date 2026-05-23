<script setup lang="ts">
import { computed, ref } from "vue";
import { onLoad } from "@dcloudio/uni-app";

import GlassCard from "../../components/ui/GlassCard.vue";
import MenuIcon from "../../components/ui/MenuIcon.vue";
import MobileShell from "../../layouts/MobileShell.vue";
import { useSessionStore } from "../../stores/session";
import { resolveHomePath } from "../../utils/role-routing";

const sessionStore = useSessionStore();
const status = ref<"success" | "warning" | "danger">("success");
const title = ref("操作结果");
const detail = ref("系统已处理本次请求。");
const actionText = ref("返回首页");
const backUrl = ref("");
const resultMeta = computed(() => {
  if (status.value === "success") {
    return {
      label: "领取成功",
      symbol: "✓",
      suggestion: "感谢你的信任与爱心。可继续查看领取记录。"
    };
  }

  if (status.value === "warning") {
    return {
      label: "暂时无法领取",
      symbol: "!",
      suggestion: "请先查看原因，如次数已用完或不在开放时段，可稍后再试。"
    };
  }

  return {
    label: "无法完成",
    symbol: "!",
    suggestion: "请按提示重新尝试；如果柜机不可用，请联系工作人员。"
  };
});

const goHome = async () => {
  if (backUrl.value) {
    uni.reLaunch({
      url: backUrl.value
    });
    return;
  }

  await sessionStore.bootstrap();
  uni.reLaunch({
    url: sessionStore.user ? resolveHomePath(sessionStore.user.role) : "/pages/common/login"
  });
};

onLoad((query) => {
  status.value =
    query.status === "warning" || query.status === "danger" ? query.status : "success";
  title.value = typeof query.title === "string" ? decodeURIComponent(query.title) : title.value;
  detail.value = typeof query.detail === "string" ? decodeURIComponent(query.detail) : detail.value;
  actionText.value =
    typeof query.actionText === "string" ? decodeURIComponent(query.actionText) : actionText.value;
  backUrl.value = typeof query.backUrl === "string" ? decodeURIComponent(query.backUrl) : "";
});
</script>

<template>
  <MobileShell eyebrow="处理结果" :title="title" :subtitle="detail">
    <GlassCard :tone="status === 'success' ? 'accent' : status === 'warning' ? 'warning' : 'quiet'">
      <view class="vm-stack">
        <view class="result-hero" :class="`result-hero--${status}`">
          <MenuIcon :name="status === 'success' ? 'success' : 'warning'" size="lg" :tone="status === 'success' ? 'accent' : 'warning'" />
          <view class="result-hero__copy">
            <text class="result-icon">{{ resultMeta.label }}</text>
            <text class="result-hint">{{ resultMeta.suggestion }}</text>
          </view>
        </view>
        <view class="result-detail">
          <text class="result-detail__label">原因 / 说明</text>
          <text class="result-detail__body">{{ detail }}</text>
        </view>
        <button class="vm-button" @tap="goHome">{{ actionText }}</button>
      </view>
    </GlassCard>
  </MobileShell>
</template>

<style scoped>
.result-icon {
  font-size: 38rpx;
  font-weight: 800;
  color: var(--vm-text);
}

.result-hero,
.result-detail {
  display: grid;
  gap: 12rpx;
  padding: 24rpx;
  border-radius: 24rpx;
  border: 1rpx solid var(--vm-line);
  background: var(--vm-surface-soft);
}

.result-hero {
  grid-template-columns: auto minmax(0, 1fr);
  align-items: center;
  min-height: 156rpx;
}

.result-hero--success {
  border-color: var(--vm-success-line);
  background: linear-gradient(135deg, rgba(255, 255, 255, 0.94), rgba(237, 248, 233, 0.96));
}

.result-hero--warning {
  border-color: var(--vm-warning-line);
  background: linear-gradient(135deg, rgba(255, 255, 255, 0.94), rgba(255, 243, 226, 0.96));
}

.result-hero--danger {
  border-color: var(--vm-danger-line);
  background: linear-gradient(135deg, rgba(255, 255, 255, 0.94), rgba(255, 240, 238, 0.96));
}

.result-hero__copy {
  display: grid;
  gap: 8rpx;
}

.result-hint,
.result-detail__label,
.result-detail__body {
  font-size: 24rpx;
  line-height: 1.6;
  color: var(--vm-text-soft);
}

.result-detail__label {
  font-weight: 700;
  color: var(--vm-accent-strong);
}

.result-detail__body {
  color: var(--vm-text);
}
</style>
