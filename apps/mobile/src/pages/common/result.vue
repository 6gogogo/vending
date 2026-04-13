<script setup lang="ts">
import { ref } from "vue";
import { onLoad } from "@dcloudio/uni-app";

import GlassCard from "../../components/ui/GlassCard.vue";
import MobileShell from "../../layouts/MobileShell.vue";
import { useSessionStore } from "../../stores/session";
import { resolveHomePath } from "../../utils/role-routing";

const sessionStore = useSessionStore();
const status = ref<"success" | "warning" | "danger">("success");
const title = ref("操作结果");
const detail = ref("系统已处理本次请求。");
const actionText = ref("返回首页");
const backUrl = ref("");

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
        <text class="result-icon">{{ status === "success" ? "已完成" : status === "warning" ? "请关注" : "处理失败" }}</text>
        <button class="vm-button" @tap="goHome">{{ actionText }}</button>
      </view>
    </GlassCard>
  </MobileShell>
</template>

<style scoped>
.result-icon {
  font-size: 36rpx;
  font-weight: 800;
  color: var(--vm-text);
}
</style>
