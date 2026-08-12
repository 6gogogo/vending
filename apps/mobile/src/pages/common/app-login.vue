<script setup lang="ts">
import { computed, nextTick, onMounted, ref } from "vue";
import { onLoad, onShow } from "@dcloudio/uni-app";

import type { AppLoginResult, VerificationProvider } from "@vm/shared-types";

import { mobileApi } from "../../api/mobile";
import { loadMobileRuntimeConfig } from "../../api/runtime-config";
import { appCopy } from "../../constants/copy";
import userDisclaimerText from "../../content/smart-cabinet-user-disclaimer.md?raw";
import { useSessionStore } from "../../stores/session";
import { createAppLoginContinuation } from "../../utils/app-login-continuation";
import {
  resolvePickupLoginTarget,
  type PickupLoginTarget
} from "../../utils/cabinet-entry";
import { getErrorMessage } from "../../utils/error-message";
import { syncNativeInputAccessibility } from "../../utils/native-input-accessibility";
import { resolveHomePath, syncRoleTabBar } from "../../utils/role-routing";
import {
  isAppLoginVerificationCode,
  resolveAppLoginVerificationPresentation
} from "../../utils/app-login-verification";
import { normalizeVerificationCode } from "../../utils/verification-code";

const sessionStore = useSessionStore();
const phone = ref("");
const code = ref("");
const previewCode = ref("");
const sendingCode = ref(false);
const submitting = ref(false);
const hasAcceptedDisclaimer = ref(false);
const showDisclaimer = ref(false);
const verificationProvider = ref<VerificationProvider>();
const pendingPickupTarget = ref<PickupLoginTarget>();
const showVerificationPreview =
  import.meta.env.DEV && import.meta.env.VITE_SHOW_VERIFICATION_PREVIEW === "true";

const verificationPresentation = computed(() =>
  resolveAppLoginVerificationPresentation(verificationProvider.value)
);
const disclaimerLines = computed(() =>
  userDisclaimerText
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
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

const normalizedPhone = () => phone.value.trim();

const validatePhone = () => {
  if (/^1\d{10}$/.test(normalizedPhone())) return true;
  uni.showToast({ title: "请输入 11 位手机号", icon: "none" });
  return false;
};

const validateCode = () => {
  if (isAppLoginVerificationCode(code.value, verificationProvider.value)) return true;
  uni.showToast({
    title: verificationProvider.value === "manual" ? "请输入 6 位一次性验证码" : "请输入验证码",
    icon: "none"
  });
  return false;
};

const ensureDisclaimerAccepted = () => {
  if (hasAcceptedDisclaimer.value) return true;
  uni.showToast({ title: appCopy.disclaimer.validationToast, icon: "none" });
  return false;
};

const syncLoginInputAccessibility = async () => {
  await nextTick();
  syncNativeInputAccessibility("app-login-phone", {
    labelId: "app-login-phone-label",
    name: "phone",
    autocomplete: "tel"
  });
  syncNativeInputAccessibility("app-login-code", {
    labelId: "app-login-code-label",
    name: "verification-code",
    autocomplete: "one-time-code"
  });
};

const loadVerificationProvider = async () => {
  try {
    const runtimeConfig = await loadMobileRuntimeConfig({ forceRefresh: true });
    verificationProvider.value = runtimeConfig.verificationProvider;
  } catch {
    verificationProvider.value = undefined;
  }
};

const sendCode = async () => {
  if (!verificationPresentation.value.canRequestCode) {
    uni.showToast({
      title: verificationProvider.value === "manual"
        ? "请向实例管理员获取一次性验证码"
        : "正在确认验证码方式，请稍后重试",
      icon: "none"
    });
    return;
  }
  if (!validatePhone() || !ensureDisclaimerAccepted()) return;

  sendingCode.value = true;
  try {
    const response = await mobileApi.requestCode(normalizedPhone(), "app-login");
    previewCode.value = showVerificationPreview ? response.previewCode ?? "" : "";
    uni.showToast({ title: "验证码已发送", icon: "none" });
  } catch (error) {
    uni.showToast({ title: getErrorMessage(error), icon: "none" });
  } finally {
    sendingCode.value = false;
  }
};

const handleAuthResult = (response: AppLoginResult) => {
  if (response.state === "approved") {
    continueApprovedLogin(response);
    return;
  }

  if (response.state === "needs_profile") {
    sessionStore.setDraft({
      draft: response.draft,
      profileDraft: response.profile
    });
    uni.reLaunch({ url: "/pages/common/profile" });
    return;
  }

  sessionStore.setDraft({
    draft: response.draft,
    application: response.application,
    profileDraft: response.application.profile
  });
  uni.reLaunch({ url: "/pages/common/review-status" });
};

const submit = async () => {
  if (!ensureDisclaimerAccepted() || !validatePhone() || !validateCode()) return;

  submitting.value = true;
  try {
    const response = await mobileApi.appLogin(
      normalizedPhone(),
      normalizeVerificationCode(code.value)
    );
    handleAuthResult(response);
  } catch (error) {
    uni.showToast({ title: getErrorMessage(error), icon: "none" });
  } finally {
    submitting.value = false;
  }
};

const restoreEntry = async () => {
  await sessionStore.bootstrap();
  if (pendingPickupTarget.value) {
    sessionStore.setPickupTarget(pendingPickupTarget.value);
    pendingPickupTarget.value = undefined;
  }

  if (sessionStore.user) {
    continueApprovedLogin({
      state: "approved",
      token: sessionStore.token!,
      user: sessionStore.user,
      quota: sessionStore.quota
    });
    return;
  }

  if (sessionStore.application && sessionStore.draft) {
    uni.reLaunch({ url: "/pages/common/review-status" });
    return;
  }

  if (sessionStore.draft) {
    uni.reLaunch({ url: "/pages/common/profile" });
  }
};

const goFeedback = () => {
  const query = normalizedPhone() ? `?phone=${encodeURIComponent(normalizedPhone())}` : "";
  uni.navigateTo({ url: `/pages/common/feedback${query}` });
};

onLoad((query) => {
  pendingPickupTarget.value = resolvePickupLoginTarget(query);
  if (typeof query.phone === "string") phone.value = query.phone;
});

onShow(() => {
  void restoreEntry();
  void loadVerificationProvider();
});

onMounted(() => {
  void syncLoginInputAccessibility();
});
</script>

<template>
  <view class="auth-page">
    <view class="auth-header"><text>登录</text></view>

    <view class="brand-hero">
      <image class="brand-hero__image" src="/static/auth/vm-auth-hero.png" mode="aspectFill" />
      <view class="brand-hero__copy">
        <text class="brand-hero__title">小柜大爱</text>
        <text class="brand-hero__subtitle">让公益更近一点</text>
      </view>
    </view>

    <view class="auth-card">
      <view class="auth-card__accent">
        <view class="auth-card__accent-green" />
        <view class="auth-card__accent-orange" />
      </view>
      <text class="auth-card__title">登录 / 注册</text>

      <view class="field-group">
        <text id="app-login-phone-label" class="field-label">手机号</text>
        <view class="input-shell">
          <input
            id="app-login-phone"
            v-model="phone"
            class="field-input"
            type="number"
            inputmode="numeric"
            maxlength="11"
            name="phone"
            autocomplete="tel"
            aria-label="手机号"
            placeholder="请输入手机号"
          />
        </view>
      </view>

      <view class="field-group">
        <text id="app-login-code-label" class="field-label">验证码</text>
        <view class="input-shell code-shell">
          <input
            id="app-login-code"
            v-model="code"
            class="field-input"
            type="number"
            inputmode="numeric"
            :maxlength="verificationProvider === 'manual' ? 6 : 8"
            name="verification-code"
            autocomplete="one-time-code"
            aria-label="验证码"
            placeholder="请输入验证码"
          />
          <button
            v-if="verificationPresentation.canRequestCode"
            class="code-button"
            :disabled="sendingCode"
            :loading="sendingCode"
            @tap="sendCode"
          >
            获取验证码
          </button>
        </view>
      </view>

      <checkbox-group @change="hasAcceptedDisclaimer = $event.detail.value.includes('accepted')">
        <label class="agreement-row">
          <checkbox value="accepted" :checked="hasAcceptedDisclaimer" color="#24854a" />
          <text>阅读并同意</text>
          <text class="agreement-link" @tap.stop="showDisclaimer = true">
            《{{ appCopy.disclaimer.title }}》
          </text>
        </label>
      </checkbox-group>

      <view v-if="showVerificationPreview && previewCode" class="preview-code">
        <text>当前验证码 {{ previewCode }}</text>
      </view>

      <button class="primary-button" :loading="submitting" :disabled="submitting" @tap="submit">
        登录 / 注册
      </button>
      <button class="support-button" @tap="goFeedback">联系工作人员</button>
    </view>

    <view v-if="showDisclaimer" class="disclaimer-mask" @tap.self="showDisclaimer = false">
      <view class="disclaimer-dialog">
        <text class="disclaimer-dialog__title">{{ appCopy.disclaimer.title }}</text>
        <scroll-view class="disclaimer-dialog__body" scroll-y>
          <text
            v-for="(line, index) in disclaimerLines"
            :key="`${index}-${line}`"
            class="disclaimer-dialog__line"
          >
            {{ line.replace(/^#{1,2}\s*/, "") }}
          </text>
        </scroll-view>
        <button class="primary-button" @tap="showDisclaimer = false">关闭并返回</button>
      </view>
    </view>
  </view>
</template>

<style scoped>
.auth-page {
  box-sizing: border-box;
  min-height: 100vh;
  padding: calc(env(safe-area-inset-top) + 28rpx) 24rpx calc(env(safe-area-inset-bottom) + 54rpx);
  background: #fffaf3;
  color: #191914;
}

.auth-header {
  display: flex;
  align-items: center;
  justify-content: center;
  height: 92rpx;
  font-size: 48rpx;
  font-weight: 900;
}

.brand-hero {
  position: relative;
  height: 350rpx;
  overflow: hidden;
  border-radius: 44rpx 44rpx 0 0;
}

.brand-hero__image {
  width: 100%;
  height: 100%;
}

.brand-hero__copy {
  position: absolute;
  left: 58rpx;
  top: 86rpx;
  display: flex;
  flex-direction: column;
  gap: 12rpx;
}

.brand-hero__title {
  font-size: 70rpx;
  line-height: 1.05;
  font-weight: 900;
  letter-spacing: -3rpx;
}

.brand-hero__subtitle {
  color: #756d64;
  font-size: 39rpx;
  line-height: 1.3;
  font-weight: 600;
}

.auth-card {
  position: relative;
  display: flex;
  flex-direction: column;
  gap: 34rpx;
  overflow: hidden;
  padding: 52rpx 38rpx 44rpx;
  border: 2rpx solid #d6e2d2;
  border-radius: 0 0 44rpx 44rpx;
  background: rgba(255, 255, 255, 0.97);
  box-shadow: 0 24rpx 54rpx rgba(82, 65, 42, 0.12);
}

.auth-card__accent {
  position: absolute;
  inset: 0 0 auto;
  display: flex;
  height: 7rpx;
}

.auth-card__accent-green { flex: 3; background: #24854a; }
.auth-card__accent-orange { flex: 1; background: #f29535; }

.auth-card__title {
  text-align: center;
  font-size: 52rpx;
  line-height: 1.15;
  font-weight: 900;
}

.field-group { display: flex; flex-direction: column; gap: 16rpx; }
.field-label { font-size: 32rpx; font-weight: 800; }

.input-shell {
  display: flex;
  align-items: center;
  min-height: 108rpx;
  padding: 0 24rpx;
  border: 3rpx solid #e5ddd1;
  border-radius: 28rpx;
  background: #ffffff;
}

.input-shell:focus-within {
  border-color: #24854a;
  box-shadow: 0 0 0 7rpx rgba(36, 133, 74, 0.1);
}

.field-input {
  flex: 1;
  min-width: 0;
  height: 104rpx;
  color: #191914;
  font-size: 32rpx;
  font-weight: 600;
}

.code-shell { gap: 16rpx; padding-right: 12rpx; }
.code-button {
  flex: 0 0 auto;
  min-width: 194rpx;
  height: 82rpx;
  margin: 0;
  padding: 0 18rpx;
  border: 2rpx solid #b8d4bc;
  border-radius: 22rpx;
  background: #eaf5eb;
  color: #176638;
  font-size: 28rpx;
  line-height: 82rpx;
  font-weight: 900;
}

.agreement-row {
  display: flex;
  align-items: center;
  min-width: 0;
  color: #69645e;
  font-size: 28rpx;
  line-height: 1.5;
  font-weight: 600;
}

.agreement-link { color: #24854a; font-weight: 800; }
.preview-code { color: #176638; font-size: 28rpx; text-align: center; }

.primary-button {
  width: 100%;
  min-height: 106rpx;
  margin: 0;
  border: 0;
  border-radius: 28rpx;
  background: #24854a;
  box-shadow: 0 18rpx 36rpx rgba(28, 113, 59, 0.18);
  color: #ffffff;
  font-size: 38rpx;
  line-height: 106rpx;
  font-weight: 900;
}

.support-button {
  margin: -6rpx auto 0;
  padding: 0;
  border: 0;
  background: transparent;
  color: #77736d;
  font-size: 30rpx;
  line-height: 1.6;
  text-decoration: underline;
}

.disclaimer-mask {
  position: fixed;
  inset: 0;
  z-index: 99;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 32rpx;
  background: rgba(12, 24, 19, 0.54);
}

.disclaimer-dialog {
  box-sizing: border-box;
  display: flex;
  flex-direction: column;
  gap: 24rpx;
  width: 100%;
  max-height: 84vh;
  padding: 36rpx;
  border-radius: 36rpx;
  background: #ffffff;
}

.disclaimer-dialog__title { font-size: 38rpx; font-weight: 900; }
.disclaimer-dialog__body { height: 56vh; }
.disclaimer-dialog__line {
  display: block;
  margin-bottom: 18rpx;
  color: #4f4b46;
  font-size: 27rpx;
  line-height: 1.7;
}
</style>
