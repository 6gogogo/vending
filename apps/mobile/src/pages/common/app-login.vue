<script setup lang="ts">
import { computed, reactive, ref } from "vue";
import { onLoad, onShow } from "@dcloudio/uni-app";

import type { AppLoginResult } from "@vm/shared-types";

import { mobileApi } from "../../api/mobile";
import CabinetHeroArt from "../../components/ui/CabinetHeroArt.vue";
import GlassCard from "../../components/ui/GlassCard.vue";
import { useSmsCooldown } from "../../composables/useSmsCooldown";
import userDisclaimerText from "../../content/smart-cabinet-user-disclaimer.md?raw";
import MobileShell from "../../layouts/MobileShell.vue";
import { useSessionStore } from "../../stores/session";
import { getErrorMessage } from "../../utils/error-message";
import { resolveHomePath, syncRoleTabBar } from "../../utils/role-routing";

const sessionStore = useSessionStore();
const phone = ref("");
const code = ref("");
const previewCode = ref("");
const sendingCode = ref(false);
const submitting = ref(false);
const loginState = ref<AppLoginResult | null>(null);
const rejectedReason = ref("");
const hasAcceptedDisclaimer = ref(false);
const showDisclaimer = ref(false);
const { remainingSeconds, isCoolingDown, startCooldown } = useSmsCooldown(60);

const helper = reactive({
  title: "",
  detail: ""
});

const disclaimerLines = computed(() =>
  userDisclaimerText
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
);

const sendCodeLabel = computed(() =>
  isCoolingDown.value ? `${remainingSeconds.value}s 后重发` : "获取验证码"
);

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
  if (!ensureDisclaimerAccepted()) {
    return;
  }

  const normalizedPhone = phone.value.trim();

  if (!/^1\d{10}$/.test(normalizedPhone)) {
    uni.showToast({
      title: "请输入 11 位手机号",
      icon: "none"
    });
    return;
  }

  if (isCoolingDown.value) {
    uni.showToast({
      title: `请在 ${remainingSeconds.value}s 后重试`,
      icon: "none"
    });
    return;
  }

  sendingCode.value = true;
  try {
    const response = await mobileApi.requestCode(normalizedPhone, "app-login");
    previewCode.value = response.previewCode ?? "";
    startCooldown();
    uni.showToast({
      title: "验证码已发送",
      icon: "none"
    });
  } catch (error) {
    const message = getErrorMessage(error);
    const shouldRegister = message.includes("请注册");
    const shouldWaitReview = message.includes("请等待审核");

    uni.showModal({
      title: shouldWaitReview ? "请等待审核" : shouldRegister ? "请注册" : "获取验证码失败",
      content: shouldWaitReview
        ? "当前手机号资料还在审核中，审核通过前不能获取登录验证码。"
        : shouldRegister
          ? "当前手机号未登记或未通过审核，请先注册后再登录。"
          : message,
      showCancel: !shouldWaitReview,
      cancelText: "关闭",
      confirmText: shouldRegister ? "去注册" : "我知道了",
      success: ({ confirm }) => {
        if (confirm && shouldRegister) {
          goRegister();
        }
      }
    });
  } finally {
    sendingCode.value = false;
  }
};

const submit = async () => {
  if (!ensureDisclaimerAccepted()) {
    return;
  }

  submitting.value = true;
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
    submitting.value = false;
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

const ensureDisclaimerAccepted = () => {
  if (hasAcceptedDisclaimer.value) {
    return true;
  }

  showDisclaimer.value = true;
  uni.showToast({
    title: "请先阅读并同意免责声明",
    icon: "none"
  });
  return false;
};

const openDisclaimer = () => {
  showDisclaimer.value = true;
};

const acceptDisclaimer = () => {
  hasAcceptedDisclaimer.value = true;
  showDisclaimer.value = false;
};

const rejectDisclaimer = () => {
  showDisclaimer.value = false;
  uni.navigateBack({
    fail: () => {
      uni.redirectTo({ url: "/pages/common/login" });
    }
  });
};

onLoad((query) => {
  if (typeof query.phone === "string" && query.phone) {
    phone.value = query.phone;
  }

  showDisclaimer.value = true;
});

onShow(() => {
  bootstrap();
});
</script>

<template>
  <MobileShell eyebrow="身份识别" title="登录小柜大爱" subtitle="输入已认证手机号，系统会识别你的服务入口。">
    <GlassCard tone="neutral" class="login-card">
      <view class="vm-stack">
        <view class="login-card__visual">
          <CabinetHeroArt />
          <view class="login-card__brand">
            <text class="login-card__title">小柜大爱</text>
            <text class="login-card__subtitle">让公益更近一点</text>
          </view>
        </view>

        <view class="login-status-row">
          <text class="vm-status vm-status--certified">已认证</text>
          <text class="vm-status vm-status--pending">审核中</text>
          <text class="vm-status vm-status--available">可领取</text>
        </view>

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
          <button
            class="vm-button vm-button--ghost"
            :disabled="sendingCode || isCoolingDown || !hasAcceptedDisclaimer"
            :loading="sendingCode"
            @tap="sendCode"
          >
            {{ sendCodeLabel }}
          </button>
          <button class="vm-button" :disabled="!hasAcceptedDisclaimer" :loading="submitting" @tap="submit">登录 / 身份识别</button>
        </view>

        <button class="disclaimer-link" @tap="openDisclaimer">
          {{ hasAcceptedDisclaimer ? "已同意《智能货柜用户免责声明》，点击查看" : "阅读《智能货柜用户免责声明》" }}
        </button>

        <view v-if="previewCode" class="debug-box">
          <text class="debug-box__label">当前验证码</text>
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

    <view v-if="showDisclaimer" class="disclaimer-mask">
      <view class="disclaimer-dialog">
        <view class="disclaimer-dialog__header">
          <text class="disclaimer-dialog__title">智能货柜用户免责声明</text>
          <text class="disclaimer-dialog__hint">请阅读完整内容后继续使用</text>
        </view>

        <scroll-view class="disclaimer-dialog__body" scroll-y>
          <text
            v-for="(line, index) in disclaimerLines"
            :key="`${index}-${line}`"
            class="disclaimer-dialog__line"
            :class="{
              'disclaimer-dialog__line--title': line.startsWith('# '),
              'disclaimer-dialog__line--section': line.startsWith('## ')
            }"
          >
            {{ line.replace(/^#{1,2}\s*/, "") }}
          </text>
        </scroll-view>

        <view class="disclaimer-dialog__actions">
          <button class="vm-button vm-button--ghost" @tap="rejectDisclaimer">不同意</button>
          <button class="vm-button" @tap="acceptDisclaimer">同意并继续</button>
        </view>
      </view>
    </view>
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

.login-card {
  padding-top: 18rpx;
}

.login-card__visual {
  position: relative;
  min-height: 270rpx;
  overflow: hidden;
  border-radius: 26rpx;
}

.login-card__visual :deep(.cabinet-art) {
  min-height: 270rpx;
  border-radius: 26rpx;
}

.login-card__brand {
  position: absolute;
  left: 30rpx;
  top: 32rpx;
  display: grid;
  gap: 10rpx;
}

.login-card__title {
  font-size: 44rpx;
  line-height: 1.12;
  font-weight: 900;
  color: #1f1f1f;
}

.login-card__subtitle {
  font-size: 26rpx;
  color: #4e453d;
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

.login-status-row {
  display: flex;
  flex-wrap: wrap;
  gap: 12rpx;
}

.disclaimer-link {
  width: 100%;
  padding: 6rpx 0;
  color: var(--vm-accent-strong);
  font-size: 24rpx;
  line-height: 1.6;
  text-align: left;
}

.debug-box,
.status-box {
  display: grid;
  gap: 8rpx;
  padding: 22rpx 24rpx;
  border-radius: 24rpx;
  background: var(--vm-surface-soft);
  border: 1rpx solid var(--vm-line);
}

.status-box__value {
  font-size: 26rpx;
  color: var(--vm-text);
  line-height: 1.5;
}

.disclaimer-mask {
  position: fixed;
  inset: 0;
  z-index: 99;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 40rpx 28rpx calc(40rpx + env(safe-area-inset-bottom));
  background: rgba(10, 24, 38, 0.48);
}

.disclaimer-dialog {
  display: flex;
  flex-direction: column;
  width: 100%;
  max-width: 680rpx;
  max-height: 86vh;
  border-radius: 28rpx;
  border: 1rpx solid var(--vm-line-strong);
  background: var(--vm-surface-strong);
  box-shadow: 0 28rpx 80rpx rgba(10, 24, 38, 0.2);
  overflow: hidden;
}

.disclaimer-dialog__header {
  display: grid;
  gap: 8rpx;
  padding: 28rpx 30rpx 22rpx;
  border-bottom: 1rpx solid var(--vm-line);
}

.disclaimer-dialog__title {
  font-size: 34rpx;
  font-weight: 800;
  color: var(--vm-text);
}

.disclaimer-dialog__hint {
  font-size: 24rpx;
  color: var(--vm-muted);
}

.disclaimer-dialog__body {
  height: 58vh;
  padding: 24rpx 30rpx;
}

.disclaimer-dialog__line {
  display: block;
  margin-bottom: 16rpx;
  font-size: 25rpx;
  line-height: 1.72;
  color: var(--vm-text);
}

.disclaimer-dialog__line--title {
  font-size: 31rpx;
  font-weight: 800;
}

.disclaimer-dialog__line--section {
  margin-top: 8rpx;
  font-size: 28rpx;
  font-weight: 800;
  color: var(--vm-accent-strong);
}

.disclaimer-dialog__actions {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 16rpx;
  padding: 22rpx 30rpx 28rpx;
  border-top: 1rpx solid var(--vm-line);
  background: var(--vm-surface-soft);
}
</style>

