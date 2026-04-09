<script setup lang="ts">
import GlassCard from "../../components/ui/GlassCard.vue";
import MobileShell from "../../layouts/MobileShell.vue";
import { appCopy } from "../../constants/copy";
import { useAuthFlow } from "../../composables/useAuthFlow";

const { phone, code, busy, previewCode, sendCode, submit } = useAuthFlow();

const roleTags = ["特殊群体领取", "商户投放管理", "后台流程留痕"];
</script>

<template>
  <MobileShell eyebrow="统一登录" :title="appCopy.title" :subtitle="appCopy.loginHeadline">
    <template #hero-extra>
      <GlassCard tone="quiet" compact>
        <view class="login-roles">
          <text class="login-roles__title">服务覆盖</text>
          <view class="login-roles__list">
            <text v-for="tag in roleTags" :key="tag" class="vm-status vm-status--success">{{ tag }}</text>
          </view>
        </view>
      </GlassCard>
    </template>

    <GlassCard tone="accent">
      <view class="vm-stack">
        <view class="section-heading">
          <text class="section-heading__title">手机号快捷登录</text>
          <text class="vm-subtitle">{{ appCopy.loginBody }}</text>
        </view>

        <view class="vm-field">
          <text class="vm-field__label">手机号</text>
          <input
            v-model="phone"
            class="vm-field__input"
            type="number"
            maxlength="11"
            placeholder="请输入已登记手机号"
            placeholder-class="vm-field__placeholder"
          />
        </view>

        <view class="vm-field">
          <view class="vm-field__meta">
            <text class="vm-field__label">验证码</text>
            <text class="vm-field__helper">开发联调阶段可直接查看调试验证码</text>
          </view>
          <input
            v-model="code"
            class="vm-field__input"
            type="number"
            maxlength="6"
            placeholder="请输入短信验证码"
            placeholder-class="vm-field__placeholder"
          />
        </view>

        <view class="login-actions">
          <button class="vm-button vm-button--ghost" :loading="busy" @tap="sendCode">获取验证码</button>
          <button class="vm-button" :loading="busy" @tap="submit">进入系统</button>
        </view>

        <view v-if="previewCode" class="debug-code">
          <text class="debug-code__label">调试验证码</text>
          <text class="vm-number debug-code__value">{{ previewCode }}</text>
        </view>
      </view>
    </GlassCard>

    <GlassCard tone="quiet">
      <view class="vm-stack">
        <view class="section-heading">
          <text class="section-heading__title">进入前请确认</text>
          <text class="vm-subtitle">{{ appCopy.loginSupport }}</text>
        </view>
        <view class="support-list">
          <view v-for="item in appCopy.serviceHighlights" :key="item" class="support-item">
            <text class="support-item__dot" />
            <text class="support-item__text">{{ item }}</text>
          </view>
        </view>
      </view>
    </GlassCard>
  </MobileShell>
</template>

<style scoped>
.login-roles {
  display: flex;
  flex-direction: column;
  gap: 16rpx;
}

.login-roles__title,
.section-heading__title {
  font-size: 30rpx;
  font-weight: 700;
  color: var(--vm-text);
}

.login-roles__list {
  display: flex;
  flex-wrap: wrap;
  gap: 12rpx;
}

.section-heading {
  display: flex;
  flex-direction: column;
  gap: 12rpx;
}

.vm-field__meta {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16rpx;
}

.vm-field__helper {
  font-size: 22rpx;
  color: var(--vm-text-soft);
}

.login-actions {
  display: grid;
  gap: 18rpx;
}

.debug-code {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 20rpx;
  padding: 22rpx 24rpx;
  border-radius: 26rpx;
  background: rgba(255, 255, 255, 0.56);
  border: 1rpx dashed rgba(159, 127, 94, 0.28);
}

.debug-code__label {
  font-size: 24rpx;
  color: var(--vm-text-soft);
}

.debug-code__value {
  font-size: 42rpx;
}

.support-list {
  display: grid;
  gap: 16rpx;
}

.support-item {
  display: flex;
  align-items: center;
  gap: 16rpx;
}

.support-item__dot {
  width: 12rpx;
  height: 12rpx;
  border-radius: 999rpx;
  background: var(--vm-accent);
  flex-shrink: 0;
}

.support-item__text {
  font-size: 26rpx;
  color: var(--vm-text);
}
 </style>
