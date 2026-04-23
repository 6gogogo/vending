<script setup lang="ts">
import { computed } from "vue";
import { onShow } from "@dcloudio/uni-app";

import AccessibilityModePanel from "../../components/ui/AccessibilityModePanel.vue";
import GlassCard from "../../components/ui/GlassCard.vue";
import MenuIcon from "../../components/ui/MenuIcon.vue";
import MobileShell from "../../layouts/MobileShell.vue";
import { roleLabelMap } from "../../constants/labels";
import { useSessionStore } from "../../stores/session";
import { useUiPreferencesStore } from "../../stores/ui-preferences";
import { syncRoleTabBar } from "../../utils/role-routing";

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
    eyebrow="设置"
    title="账号与设置"
    :subtitle="subtitle"
  >
    <GlassCard tone="accent">
      <view class="vm-stack">
        <view class="info-list">
          <view class="info-item">
            <text class="info-item__label">账号身份</text>
            <text class="info-item__value">{{ roleLabelMap[sessionStore.user?.role ?? 'special'] }}</text>
          </view>
          <view class="info-item">
            <text class="info-item__label">姓名</text>
            <text class="info-item__value">{{ sessionStore.user?.name ?? "-" }}</text>
          </view>
          <view class="info-item">
            <text class="info-item__label">手机号</text>
            <text class="info-item__value">{{ sessionStore.user?.phone ?? "-" }}</text>
          </view>
        </view>
      </view>
    </GlassCard>

    <GlassCard v-if="sessionStore.user?.role === 'special'" tone="quiet">
      <AccessibilityModePanel
        :checked="uiPreferencesStore.specialAccessibilityMode"
        description="仅普通用户可切换。开启后将使用关怀版界面，采用大字、高对比和更大的操作按钮。"
        @update:checked="uiPreferencesStore.setSpecialAccessibilityMode"
      />
    </GlassCard>

    <GlassCard tone="quiet">
      <view class="vm-stack">
        <view class="action-grid">
          <button class="vm-button action-button" @tap="navigate('/pages/common/feedback')">
            <view class="action-button__content">
              <MenuIcon name="feedback" size="sm" tone="contrast" />
              <text>反馈问题</text>
            </view>
          </button>
          <button v-if="sessionStore.user?.role === 'admin'" class="vm-button vm-button--ghost action-button" disabled>
            <view class="action-button__content">
              <MenuIcon name="desktop" size="sm" tone="neutral" />
              <text>需要批量处理时，请在电脑上继续操作</text>
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
  </MobileShell>
</template>

<style scoped>
.info-list,
.action-grid {
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

.info-item {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 16rpx;
  padding: 22rpx 24rpx;
  border-radius: 24rpx;
  background: rgba(255, 255, 255, 0.62);
  border: 1rpx solid rgba(159, 127, 94, 0.12);
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
</style>
