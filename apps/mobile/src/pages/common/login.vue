<script setup lang="ts">
import { onShow } from "@dcloudio/uni-app";

import AccessibilityModeMenu from "../../components/ui/AccessibilityModeMenu.vue";
import CabinetHeroArt from "../../components/ui/CabinetHeroArt.vue";
import GlassCard from "../../components/ui/GlassCard.vue";
import MenuIcon from "../../components/ui/MenuIcon.vue";
import MobileShell from "../../layouts/MobileShell.vue";
import { useSessionStore } from "../../stores/session";
import { useUiPreferencesStore } from "../../stores/ui-preferences";
import { resolveHomePath, syncRoleTabBar } from "../../utils/role-routing";

const sessionStore = useSessionStore();
const uiPreferencesStore = useUiPreferencesStore();

uiPreferencesStore.hydrate();

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
    title="小柜大爱"
    subtitle="让公益更近一点。请先完成手机号身份识别。"
  >
    <template #header-right>
      <AccessibilityModeMenu
        :checked="uiPreferencesStore.specialAccessibilityMode"
        @update:checked="uiPreferencesStore.setSpecialAccessibilityMode"
      />
    </template>

    <GlassCard tone="neutral" class="entry-card">
      <view class="vm-stack">
        <view class="entry-card__visual">
          <CabinetHeroArt />
          <view class="entry-card__brand">
            <text class="entry-card__title">小柜大爱</text>
            <text class="entry-card__subtitle">让公益更近一点</text>
          </view>
        </view>

        <view class="section-heading">
          <text class="section-heading__title">选择下一步</text>
          <text class="vm-subtitle">已认证可直接登录，首次使用请提交注册申请。</text>
        </view>

        <view class="entry-actions">
          <button class="vm-button action-button" @tap="navigate('/pages/common/app-login')">
            <view class="action-button__content">
              <MenuIcon name="scan" size="sm" tone="contrast" />
              <text>登录 / 身份识别</text>
            </view>
          </button>
          <button class="vm-button vm-button--ghost action-button" @tap="navigate('/pages/common/register')">
            <view class="action-button__content">
              <MenuIcon name="users" size="sm" tone="neutral" />
              <text>提交注册申请</text>
            </view>
          </button>
          <button class="vm-button vm-button--soft action-button" @tap="navigate('/pages/common/feedback')">
            <view class="action-button__content">
              <MenuIcon name="feedback" size="sm" tone="accent" />
              <text>联系工作人员</text>
            </view>
          </button>
        </view>
      </view>
    </GlassCard>

    <GlassCard tone="quiet">
      <view class="vm-stack">
        <view class="section-heading">
          <text class="section-heading__title">温馨提示</text>
          <text class="vm-subtitle">审核通过后，首页会显示今日是否可领取和开放时段。</text>
        </view>
        <view class="tips-list">
          <text class="tips-list__item">1. 已认证手机号可直接进入。</text>
          <text class="tips-list__item">2. 审核中可随时查看状态。</text>
          <text class="tips-list__item">3. 遇到柜机或资格问题，可联系工作人员。</text>
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

.entry-card {
  padding-top: 18rpx;
}

.entry-card__visual {
  position: relative;
  min-height: 280rpx;
  overflow: hidden;
  border-radius: 26rpx;
}

.entry-card__visual :deep(.cabinet-art) {
  min-height: 280rpx;
  border-radius: 26rpx;
}

.entry-card__brand {
  position: absolute;
  left: 30rpx;
  top: 34rpx;
  display: grid;
  gap: 10rpx;
}

.entry-card__title {
  font-size: 48rpx;
  line-height: 1.1;
  font-weight: 900;
  color: #1f1f1f;
}

.entry-card__subtitle {
  font-size: 26rpx;
  color: #4e453d;
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

.action-button__content {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 14rpx;
  width: 100%;
}

.tips-list__item {
  font-size: 26rpx;
  color: var(--vm-text);
  line-height: 1.6;
}
</style>
