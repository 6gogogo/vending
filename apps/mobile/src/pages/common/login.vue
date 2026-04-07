<script setup lang="ts">
import GlassCard from "../../components/ui/GlassCard.vue";
import MobileShell from "../../layouts/MobileShell.vue";
import { appCopy } from "../../constants/copy";
import { useAuthFlow } from "../../composables/useAuthFlow";

const { phone, code, busy, previewCode, sendCode, submit } = useAuthFlow();
</script>

<template>
  <MobileShell eyebrow="统一登录" :title="appCopy.title" :subtitle="appCopy.loginHeadline">
    <GlassCard>
      <view class="vm-stack">
        <text class="vm-subtitle">{{ appCopy.loginBody }}</text>

        <view class="field">
          <text class="field__label">手机号</text>
          <input v-model="phone" class="field__input" type="number" maxlength="11" />
        </view>

        <view class="field">
          <text class="field__label">验证码</text>
          <input v-model="code" class="field__input" type="number" maxlength="6" />
        </view>

        <text v-if="previewCode" class="vm-pill">调试验证码：{{ previewCode }}</text>

        <button class="vm-button" :loading="busy" @tap="sendCode">获取验证码</button>
        <button class="vm-button vm-button--ghost" :loading="busy" @tap="submit">进入系统</button>
      </view>
    </GlassCard>
  </MobileShell>
</template>

<style scoped>
.field {
  display: flex;
  flex-direction: column;
  gap: 12rpx;
}

.field__label {
  font-size: 24rpx;
  color: var(--vm-muted);
}

.field__input {
  min-height: 92rpx;
  padding: 0 24rpx;
  border: 1rpx solid var(--vm-line);
  border-radius: 26rpx;
  color: var(--vm-text);
  background: rgba(15, 23, 42, 0.55);
}
</style>
