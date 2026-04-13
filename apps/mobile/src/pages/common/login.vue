<script setup lang="ts">
import { onShow } from "@dcloudio/uni-app";

import GlassCard from "../../components/ui/GlassCard.vue";
import MobileShell from "../../layouts/MobileShell.vue";
import { useSessionStore } from "../../stores/session";
import { resolveHomePath, syncRoleTabBar } from "../../utils/role-routing";

const sessionStore = useSessionStore();

const bootstrap = async () => {
  await sessionStore.bootstrap();

  if (!sessionStore.user) {
    return;
  }

  syncRoleTabBar(sessionStore.user.role);
  uni.switchTab({
    url: resolveHomePath(sessionStore.user.role)
  });
};

const navigate = (url: string) => {
  uni.navigateTo({ url });
};

onShow(() => {
  bootstrap();
});
</script>

<template>
  <MobileShell
    eyebrow="公益智助柜"
    title="欢迎使用公益智助柜"
    subtitle="先登录或注册，再根据账号身份进入对应功能；如遇到问题，可直接走反馈通道。"
  >
    <GlassCard tone="accent">
      <view class="vm-stack">
        <view class="section-heading">
          <text class="section-heading__title">开始使用</text>
          <text class="vm-subtitle">首次使用请先注册，已审核通过的手机号可直接登录。</text>
        </view>

        <view class="entry-actions">
          <button class="vm-button" @tap="navigate('/pages/common/app-login')">登录</button>
          <button class="vm-button vm-button--ghost" @tap="navigate('/pages/common/register')">注册</button>
          <button class="vm-button vm-button--soft" @tap="navigate('/pages/common/feedback')">反馈通道</button>
        </view>
      </view>
    </GlassCard>

    <GlassCard tone="quiet">
      <view class="vm-stack">
        <view class="section-heading">
          <text class="section-heading__title">使用说明</text>
          <text class="vm-subtitle">注册提交后，审核中与已驳回账号都不会直接登录系统。</text>
        </view>
        <view class="tips-list">
          <text class="tips-list__item">1. 登录只对已登记且已通过审核的手机号开放。</text>
          <text class="tips-list__item">2. 注册时先选账号类型，再填写手机号、验证码和身份信息。</text>
          <text class="tips-list__item">3. 待审核资料可按手机号覆盖更新；如有疑问可走反馈通道。</text>
        </view>
      </view>
    </GlassCard>
  </MobileShell>
</template>

<style scoped>
.section-heading {
  display: flex;
  flex-direction: column;
  gap: 12rpx;
}

.section-heading__title {
  font-size: 30rpx;
  font-weight: 700;
  color: var(--vm-text);
}

.entry-actions,
.tips-list {
  display: grid;
  gap: 16rpx;
}

.tips-list__item {
  font-size: 26rpx;
  color: var(--vm-text);
  line-height: 1.6;
}
</style>
