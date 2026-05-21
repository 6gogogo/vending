<script setup lang="ts">
import { computed } from "vue";
import { onShow } from "@dcloudio/uni-app";

import AccessibilityModeMenu from "../../components/ui/AccessibilityModeMenu.vue";
import GlassCard from "../../components/ui/GlassCard.vue";
import MenuIcon from "../../components/ui/MenuIcon.vue";
import MobileShell from "../../layouts/MobileShell.vue";
import { roleLabelMap } from "../../constants/labels";
import { useSessionStore } from "../../stores/session";
import { useUiPreferencesStore } from "../../stores/ui-preferences";
import { syncRoleTabBar } from "../../utils/role-routing";
import { getSupportGuideTopics } from "../../utils/support-guides";

const sessionStore = useSessionStore();
const uiPreferencesStore = useUiPreferencesStore();

uiPreferencesStore.hydrate();

const subtitle = computed(() => {
  if (sessionStore.user?.role === "admin") {
    return "可查看账号信息、提交反馈，并在需要时退出登录。";
  }

  if (sessionStore.user?.role === "merchant") {
    return "可查看账号信息、提交反馈，并在需要时退出登录。";
  }

  return "可查看账号信息、提交反馈、切换无障碍模式或退出登录。";
});

const helpPreview = computed(() => getSupportGuideTopics(sessionStore.user?.role ?? "special").slice(0, 3));

const bootstrap = async () => {
  await sessionStore.bootstrap();

  if (!sessionStore.user) {
    uni.reLaunch({ url: "/pages/common/login" });
    return;
  }

  syncRoleTabBar(sessionStore.user.role);
};

const navigate = (url: string) => {
  uni.navigateTo({ url });
};

const logout = () => {
  sessionStore.clear();
  uni.reLaunch({
    url: "/pages/common/login"
  });
};

onShow(() => {
  bootstrap();
});
</script>

<template>
  <MobileShell
    :mode="sessionStore.user?.role === 'special' ? 'care' : sessionStore.user?.role ? 'ops' : 'care'"
    eyebrow="我的"
    title="我的账户"
    :subtitle="subtitle"
  >
    <template v-if="sessionStore.user?.role === 'special'" #header-right>
      <AccessibilityModeMenu
        :checked="uiPreferencesStore.specialAccessibilityMode"
        @update:checked="uiPreferencesStore.setSpecialAccessibilityMode"
      />
    </template>

    <GlassCard tone="accent">
      <view class="vm-stack">
        <view class="profile-card">
          <view class="profile-card__avatar">
            <MenuIcon name="users" size="lg" tone="contrast" />
          </view>
          <view class="profile-card__main">
            <text class="profile-card__name">{{ sessionStore.user?.name ?? "-" }}</text>
            <text class="profile-card__phone">{{ sessionStore.user?.phone ?? "-" }}</text>
          </view>
          <text class="vm-status vm-status--certified">{{ roleLabelMap[sessionStore.user?.role ?? 'special'] }}</text>
        </view>

        <view class="info-list">
          <view class="info-item">
            <text class="info-item__label">服务入口</text>
            <text class="info-item__value">{{ sessionStore.user?.role === "merchant" ? "商户补货" : sessionStore.user?.role === "admin" ? "运营管理" : "公益领取" }}</text>
          </view>
          <view class="info-item">
            <text class="info-item__label">账号状态</text>
            <text class="info-item__value">已认证</text>
          </view>
        </view>
      </view>
    </GlassCard>

    <GlassCard tone="quiet">
      <view class="vm-stack">
        <view class="action-grid">
          <button class="vm-button action-button" @tap="navigate('/pages/common/help-center')">
            <view class="action-button__content">
              <MenuIcon name="guide" size="sm" tone="contrast" />
              <text>打开帮助中心</text>
            </view>
          </button>
          <button class="vm-button action-button" @tap="navigate('/pages/common/feedback')">
            <view class="action-button__content">
              <MenuIcon name="feedback" size="sm" tone="contrast" />
              <text>反馈问题</text>
            </view>
          </button>
          <button v-if="sessionStore.user?.role === 'admin'" class="vm-button vm-button--ghost action-button" disabled>
            <view class="action-button__content">
              <MenuIcon name="desktop" size="sm" tone="neutral" />
              <text>批量处理请在电脑端继续</text>
            </view>
          </button>
          <button class="vm-button vm-button--soft action-button" @tap="logout">
            <view class="action-button__content">
              <MenuIcon name="logout" size="sm" tone="accent" />
              <text>退出登录</text>
            </view>
          </button>
        </view>
      </view>
    </GlassCard>

    <GlassCard tone="quiet">
      <view class="vm-stack">
        <view class="section-heading">
          <text class="section-heading__title">遇到问题</text>
          <text class="vm-subtitle">这里整理了常见流程、排查提示，也可以继续让 AI 帮你分析。</text>
        </view>
        <view class="help-preview">
          <view v-for="item in helpPreview" :key="item.id" class="help-preview__card">
            <text class="help-preview__title">{{ item.title }}</text>
            <text class="help-preview__summary">{{ item.summary }}</text>
          </view>
        </view>
        <button class="vm-button vm-button--ghost" @tap="navigate('/pages/common/help-center')">查看完整指引并使用 AI 助手</button>
      </view>
    </GlassCard>
  </MobileShell>
</template>

<style scoped>
.info-list,
.action-grid,
.help-preview {
  display: grid;
  gap: 16rpx;
}

.profile-card {
  display: grid;
  grid-template-columns: auto minmax(0, 1fr) auto;
  align-items: center;
  gap: 18rpx;
  padding: 24rpx;
  border-radius: 26rpx;
  border: 1rpx solid var(--vm-success-line);
  background: linear-gradient(135deg, var(--vm-accent), #69b85f);
  box-shadow: 0 16rpx 34rpx rgba(46, 125, 70, 0.16);
}

.profile-card__avatar {
  display: grid;
  place-items: center;
  width: 92rpx;
  height: 92rpx;
  border-radius: 28rpx;
  background: rgba(255, 255, 255, 0.14);
  border: 1rpx solid rgba(255, 255, 255, 0.22);
}

.profile-card__main {
  display: grid;
  gap: 8rpx;
  min-width: 0;
}

.profile-card__name {
  font-size: 34rpx;
  font-weight: 900;
  color: #ffffff;
}

.profile-card__phone {
  font-size: 24rpx;
  color: rgba(255, 255, 255, 0.82);
}

.profile-card .vm-status {
  background: rgba(255, 255, 255, 0.18);
  border-color: rgba(255, 255, 255, 0.3);
  color: #ffffff;
}

.section-heading {
  display: grid;
  gap: 10rpx;
}

.action-button__content {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 14rpx;
  width: 100%;
}

.info-item {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 16rpx;
  padding: 22rpx 24rpx;
  border-radius: 24rpx;
  background: var(--vm-surface-soft);
  border: 1rpx solid var(--vm-line);
}

.info-item__label {
  font-size: 24rpx;
  color: var(--vm-text-soft);
}

.info-item__value {
  font-size: 28rpx;
  color: var(--vm-text);
  font-weight: 700;
}

.section-heading__title,
.help-preview__title {
  font-size: 28rpx;
  font-weight: 700;
  color: var(--vm-text);
}

.help-preview__card {
  display: grid;
  gap: 8rpx;
  padding: 22rpx 24rpx;
  border-radius: 24rpx;
  background: var(--vm-surface-soft);
  border: 1rpx solid var(--vm-line);
}

.help-preview__summary {
  font-size: 22rpx;
  line-height: 1.6;
  color: var(--vm-text-soft);
}
</style>

