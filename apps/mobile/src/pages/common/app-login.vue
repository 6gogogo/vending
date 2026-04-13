<script setup lang="ts">
import { reactive, ref } from "vue";
import { onLoad, onShow } from "@dcloudio/uni-app";

import type { AppLoginResult } from "@vm/shared-types";

import { mobileApi } from "../../api/mobile";
import GlassCard from "../../components/ui/GlassCard.vue";
import MobileShell from "../../layouts/MobileShell.vue";
import { useSessionStore } from "../../stores/session";
import { getErrorMessage } from "../../utils/error-message";
import { resolveHomePath, syncRoleTabBar } from "../../utils/role-routing";

const sessionStore = useSessionStore();
const phone = ref("13800000002");
const code = ref("123456");
const previewCode = ref("");
const busy = ref(false);
const loginState = ref<AppLoginResult | null>(null);
const rejectedReason = ref("");

const helper = reactive({
  title: "",
  detail: ""
});

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

const sendCode = async () => {
  busy.value = true;
  try {
    const response = await mobileApi.requestCode(phone.value);
    previewCode.value = response.previewCode;
    uni.showToast({
      title: "验证码已发送",
      icon: "none"
    });
  } catch (error) {
    uni.showToast({
      title: getErrorMessage(error),
      icon: "none"
    });
  } finally {
    busy.value = false;
  }
};

const submit = async () => {
  busy.value = true;
  loginState.value = null;
  rejectedReason.value = "";

  try {
    const response = await mobileApi.appLogin(phone.value, code.value);
    loginState.value = response;

    if (response.state === "approved") {
      sessionStore.setSession(response);
      syncRoleTabBar(response.user.role);
      uni.switchTab({
        url: resolveHomePath(response.user.role)
      });
      return;
    }

    helper.title =
      response.state === "not_registered"
        ? "当前手机号未登记"
        : response.state === "pending_review"
          ? "当前手机号正在审核中"
          : "当前手机号审核未通过";
    helper.detail = response.message;
    rejectedReason.value =
      response.state === "rejected" ? response.application.reviewReason || "" : "";
  } catch (error) {
    uni.showToast({
      title: getErrorMessage(error),
      icon: "none"
    });
  } finally {
    busy.value = false;
  }
};

const goRegister = () => {
  uni.navigateTo({
    url: `/pages/common/register?phone=${encodeURIComponent(phone.value)}`
  });
};

const goReview = () => {
  if (!loginState.value || !("application" in loginState.value)) {
    return;
  }

  uni.navigateTo({
    url: `/pages/common/review-status?phone=${encodeURIComponent(loginState.value.phone)}`
  });
};

const goFeedback = () => {
  uni.navigateTo({
    url: `/pages/common/feedback?phone=${encodeURIComponent(phone.value)}`
  });
};

onLoad((query) => {
  if (typeof query.phone === "string" && query.phone) {
    phone.value = query.phone;
  }
});

onShow(() => {
  bootstrap();
});
</script>

<template>
  <MobileShell eyebrow="登录" title="手机号验证码登录" subtitle="登录不再选择账号类型，只对已登记且已通过审核的手机号开放。">
    <GlassCard tone="accent">
      <view class="vm-stack">
        <view class="vm-field">
          <text class="vm-field__label">手机号</text>
          <input
            v-model="phone"
            class="vm-field__input"
            type="number"
            maxlength="11"
            placeholder="请输入手机号"
          />
        </view>

        <view class="vm-field">
          <view class="field-header">
            <text class="vm-field__label">验证码</text>
            <text class="vm-field__helper">验证码为登录必填项</text>
          </view>
          <input
            v-model="code"
            class="vm-field__input"
            type="number"
            maxlength="6"
            placeholder="请输入验证码"
          />
        </view>

        <view class="entry-actions">
          <button class="vm-button vm-button--ghost" :loading="busy" @tap="sendCode">获取验证码</button>
          <button class="vm-button" :loading="busy" @tap="submit">进入系统</button>
        </view>

        <view v-if="previewCode" class="debug-box">
          <text class="debug-box__label">开发环境验证码</text>
          <text class="vm-number">{{ previewCode }}</text>
        </view>
      </view>
    </GlassCard>

    <GlassCard v-if="loginState && loginState.state !== 'approved'" :tone="loginState.state === 'rejected' ? 'warning' : 'quiet'">
      <view class="vm-stack">
        <view class="section-heading">
          <text class="section-heading__title">{{ helper.title }}</text>
          <text class="vm-subtitle">{{ helper.detail }}</text>
        </view>

        <view v-if="rejectedReason" class="status-box">
          <text class="status-box__label">驳回原因</text>
          <text class="status-box__value">{{ rejectedReason }}</text>
        </view>

        <view class="entry-actions">
          <button class="vm-button" @tap="goRegister">去注册 / 修改资料</button>
          <button v-if="loginState.state !== 'not_registered'" class="vm-button vm-button--ghost" @tap="goReview">
            查看审核状态
          </button>
          <button class="vm-button vm-button--soft" @tap="goFeedback">联系工作人员</button>
        </view>
      </view>
    </GlassCard>
  </MobileShell>
</template>

<style scoped>
.field-header,
.section-heading {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16rpx;
}

.section-heading {
  flex-direction: column;
  align-items: flex-start;
}

.section-heading__title {
  font-size: 30rpx;
  font-weight: 700;
  color: var(--vm-text);
}

.vm-field__helper,
.debug-box__label,
.status-box__label {
  font-size: 22rpx;
  color: var(--vm-text-soft);
}

.entry-actions {
  display: grid;
  gap: 16rpx;
}

.debug-box,
.status-box {
  display: grid;
  gap: 8rpx;
  padding: 22rpx 24rpx;
  border-radius: 24rpx;
  background: rgba(255, 255, 255, 0.64);
  border: 1rpx solid rgba(159, 127, 94, 0.14);
}

.status-box__value {
  font-size: 26rpx;
  color: var(--vm-text);
  line-height: 1.5;
}
</style>
