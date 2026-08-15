<script setup lang="ts">
import { computed, ref } from "vue";
import { onShow } from "@dcloudio/uni-app";

import { appCopy } from "../../constants/copy";
import { useSessionStore } from "../../stores/session";
import { createAppLoginContinuation } from "../../utils/app-login-continuation";
import { getErrorMessage } from "../../utils/error-message";
import { resolveHomePath, syncRoleTabBar } from "../../utils/role-routing";

const sessionStore = useSessionStore();
const reviewCopy = appCopy.unifiedAuth.review;
const loading = ref(false);

const application = computed(() => sessionStore.application);
const isRejected = computed(() => application.value?.status === "rejected");
const reviewReason = computed(() =>
  application.value?.reviewReason || reviewCopy.rejectedFallback
);

const { continueApprovedLogin } = createAppLoginContinuation({
  getPickupTarget: () => sessionStore.pickupTarget,
  consumePickupTarget: () => sessionStore.consumePickupTarget(),
  bootstrapSession: () => sessionStore.bootstrap().then(() => undefined),
  getSessionRole: () => sessionStore.user?.role,
  setSession: (session) => sessionStore.setSession(session),
  redirectTo: (url) => uni.redirectTo({ url }),
  routeRoleHome: (role) => {
    syncRoleTabBar(role);
    uni.switchTab({ url: resolveHomePath(role) });
  }
});

const refresh = async () => {
  if (loading.value) return;
  loading.value = true;
  try {
    sessionStore.resetBootstrap();
    await sessionStore.bootstrap();
    if (sessionStore.user) {
      continueApprovedLogin({
        state: "approved",
        token: sessionStore.token!,
        user: sessionStore.user,
        quota: sessionStore.quota
      });
      return;
    }
    if (!sessionStore.draft || !sessionStore.application) {
      uni.reLaunch({ url: "/pages/common/app-login" });
      return;
    }
  } catch (error) {
    uni.showToast({ title: getErrorMessage(error), icon: "none" });
  } finally {
    loading.value = false;
  }
};

const edit = () => {
  uni.reLaunch({ url: "/pages/common/profile" });
};

const feedback = () => {
  uni.navigateTo({ url: "/pages/common/feedback" });
};

onShow(() => {
  void refresh();
});
</script>

<template>
  <view class="review-page">
    <view class="page-header"><text>{{ reviewCopy.pageTitle }}</text></view>

    <view class="status-hero">
      <image class="status-hero__image" src="/static/auth/vm-auth-hero.png" mode="aspectFill" />
    </view>

    <view class="status-card">
      <view class="status-mark" :class="{ 'status-mark--warning': isRejected }">
        <text>{{ isRejected ? reviewCopy.rejectedMark : reviewCopy.pendingMark }}</text>
      </view>
      <text class="status-title">
        {{ isRejected ? reviewCopy.rejectedTitle : reviewCopy.pendingTitle }}
      </text>
      <text class="status-detail">
        {{ isRejected ? reviewReason : reviewCopy.pendingDetail }}
      </text>
      <button class="primary-button" :loading="loading" @tap="isRejected ? edit() : refresh()">
        {{ isRejected ? reviewCopy.edit : reviewCopy.refresh }}
      </button>
      <button class="support-button" @tap="feedback">{{ reviewCopy.support }}</button>
    </view>
  </view>
</template>

<style scoped>
.review-page {
  box-sizing: border-box;
  min-height: 100vh;
  padding: calc(env(safe-area-inset-top) + 28rpx) 24rpx calc(env(safe-area-inset-bottom) + 52rpx);
  background: #fffaf3;
  color: #191914;
}
.page-header { display: flex; align-items: center; justify-content: center; height: 92rpx; font-size: 46rpx; font-weight: 900; }
.status-hero { height: 470rpx; overflow: hidden; border-radius: 44rpx 44rpx 0 0; }
.status-hero__image { width: 100%; height: 100%; }
.status-card { display: flex; flex-direction: column; align-items: center; gap: 28rpx; margin-top: -2rpx; padding: 52rpx 42rpx 48rpx; border: 2rpx solid #d6e2d2; border-radius: 0 0 44rpx 44rpx; background: rgba(255,255,255,.97); box-shadow: 0 24rpx 54rpx rgba(82,65,42,.11); text-align: center; }
.status-mark { display: flex; align-items: center; justify-content: center; width: 132rpx; height: 132rpx; border-radius: 50%; background: #e6f3e5; color: #24854a; font-size: 26rpx; font-weight: 900; }
.status-mark--warning { background: #fff1df; color: #b66117; font-size: 24rpx; }
.status-title { font-size: 48rpx; line-height: 1.2; font-weight: 900; }
.status-detail { color: #756d64; font-size: 31rpx; line-height: 1.65; font-weight: 600; }
.primary-button { width: 100%; min-height: 106rpx; margin: 12rpx 0 0; border: 0; border-radius: 28rpx; background: #24854a; color: #fff; font-size: 36rpx; line-height: 106rpx; font-weight: 900; box-shadow: 0 18rpx 36rpx rgba(28,113,59,.18); }
.support-button { margin: 0; padding: 0; border: 0; background: transparent; color: #77736d; font-size: 30rpx; line-height: 1.6; text-decoration: underline; }
</style>
