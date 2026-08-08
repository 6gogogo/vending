<script setup lang="ts">
import { computed, nextTick, onMounted, reactive, ref } from "vue";
import { onLoad, onShow } from "@dcloudio/uni-app";

import type { AppLoginResult, VerificationProvider } from "@vm/shared-types";

import { mobileApi } from "../../api/mobile";
import { loadMobileRuntimeConfig } from "../../api/runtime-config";
import GlassCard from "../../components/ui/GlassCard.vue";
import MenuIcon from "../../components/ui/MenuIcon.vue";
import { appCopy } from "../../constants/copy";
import userDisclaimerText from "../../content/smart-cabinet-user-disclaimer.md?raw";
import MobileShell from "../../layouts/MobileShell.vue";
import { useSessionStore } from "../../stores/session";
import { getErrorMessage } from "../../utils/error-message";
import {
  resolvePickupLoginTarget,
  type PickupLoginTarget
} from "../../utils/cabinet-entry";
import { createAppLoginContinuation } from "../../utils/app-login-continuation";
import { syncNativeInputAccessibility } from "../../utils/native-input-accessibility";
import { resolveHomePath, syncRoleTabBar } from "../../utils/role-routing";
import {
  normalizeVerificationCode
} from "../../utils/verification-code";
import {
  isAppLoginVerificationCode,
  resolveAppLoginVerificationPresentation
} from "../../utils/app-login-verification";

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
const disclaimerValidationMessage = ref("");
const disclaimerDialog = ref<HTMLElement | { $el?: HTMLElement }>();
let disclaimerPreviousFocus: HTMLElement | undefined;
const verificationProvider = ref<VerificationProvider>();
const pickupLoginTarget = ref<PickupLoginTarget>();
const showVerificationPreview =
  import.meta.env.DEV && import.meta.env.VITE_SHOW_VERIFICATION_PREVIEW === "true";

const verificationPresentation = computed(() =>
  resolveAppLoginVerificationPresentation(verificationProvider.value)
);
const registrationActionLabel = computed(() =>
  verificationProvider.value === "manual" ? "未登记？查看管理员建档指引" : "首次使用？去注册"
);
const registrationStateActionLabel = computed(() =>
  verificationProvider.value === "manual" ? "查看管理员建档指引" : "去注册 / 修改资料"
);

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

const helper = reactive({
  title: "",
  detail: ""
});

const normalizedPhone = () => phone.value.trim();

const validatePhone = () => {
  if (/^1\d{10}$/.test(normalizedPhone())) {
    return true;
  }

  uni.showToast({
    title: "请输入 11 位手机号",
    icon: "none"
  });
  return false;
};

const validateCode = () => {
  if (isAppLoginVerificationCode(code.value, verificationProvider.value)) {
    return true;
  }

  uni.showToast({
    title: verificationProvider.value === "manual" ? "请输入 6 位一次性验证码" : "请输入验证码",
    icon: "none"
  });
  return false;
};

const disclaimerLines = computed(() =>
  userDisclaimerText
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
);

const { continueApprovedLogin, restoreExistingSession } =
  createAppLoginContinuation({
    getPickupTarget: () => pickupLoginTarget.value,
    bootstrapSession: () => sessionStore.bootstrap(),
    getSessionRole: () => sessionStore.user?.role,
    setSession: (session) => sessionStore.setSession(session),
    redirectTo: (url) => uni.redirectTo({ url }),
    routeRoleHome: (role) => {
      syncRoleTabBar(role);
      uni.switchTab({ url: resolveHomePath(role) });
    }
  });

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
      title:
        verificationProvider.value === "manual"
          ? "请向实例管理员获取一次性验证码"
          : "正在确认验证码方式，请稍后重试",
      icon: "none"
    });
    return;
  }

  if (!validatePhone()) {
    return;
  }

  if (!ensureDisclaimerAccepted()) {
    return;
  }

  sendingCode.value = true;
  try {
    const response = await mobileApi.requestCode(normalizedPhone(), "app-login");
    previewCode.value = showVerificationPreview ? response.previewCode ?? "" : "";
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
        ? "当前手机号资料还在审核中，可以先查看审核状态；如需人工协助，请通过反馈入口联系工作人员。"
        : shouldRegister
          ? "当前手机号未登记或未通过审核，请先注册后再登录。"
          : message,
      showCancel: !shouldWaitReview,
      cancelText: "关闭",
      confirmText: shouldWaitReview ? "查看状态" : shouldRegister ? "去注册" : "我知道了",
      success: ({ confirm }) => {
        if (confirm && shouldRegister) {
          goRegister();
        }
        if (confirm && shouldWaitReview) {
          uni.navigateTo({
            url: `/pages/common/review-status?phone=${encodeURIComponent(normalizedPhone())}`
          });
        }
      }
    });
  } finally {
    sendingCode.value = false;
  }
};

const submit = async () => {
  if (!ensureDisclaimerAccepted() || !validatePhone() || !validateCode()) {
    return;
  }

  submitting.value = true;
  loginState.value = null;
  rejectedReason.value = "";

  try {
    const response = await mobileApi.appLogin(
      normalizedPhone(),
      normalizeVerificationCode(code.value)
    );
    loginState.value = response;

    if (response.state === "approved") {
      continueApprovedLogin(response);
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
  if (verificationProvider.value === "manual") {
    uni.navigateTo({ url: "/pages/common/register" });
    return;
  }

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
    disclaimerValidationMessage.value = "";
    return true;
  }

  disclaimerValidationMessage.value = appCopy.disclaimer.validationMessage;
  uni.showToast({
    title: appCopy.disclaimer.validationToast,
    icon: "none"
  });
  return false;
};

const handleDisclaimerAgreementChange = (event: { detail?: { value?: string[] } }) => {
  hasAcceptedDisclaimer.value = event.detail?.value?.includes("accepted") ?? false;

  if (hasAcceptedDisclaimer.value) {
    disclaimerValidationMessage.value = "";
  }
};

const resolveDisclaimerElement = () => {
  const target = disclaimerDialog.value;

  if (typeof HTMLElement !== "undefined" && target instanceof HTMLElement) {
    return target;
  }

  return target?.$el;
};

const restoreDisclaimerFocus = async () => {
  const target = disclaimerPreviousFocus;
  disclaimerPreviousFocus = undefined;
  await nextTick();

  if (target?.isConnected) {
    target.focus();
  }
};

const openDisclaimer = async () => {
  disclaimerPreviousFocus = typeof document !== "undefined" &&
    typeof HTMLElement !== "undefined" &&
    document.activeElement instanceof HTMLElement
    ? document.activeElement
    : undefined;
  showDisclaimer.value = true;
  await nextTick();
  resolveDisclaimerElement()?.focus();
};

const closeDisclaimer = async () => {
  showDisclaimer.value = false;
  await restoreDisclaimerFocus();
};

onLoad((query) => {
  pickupLoginTarget.value = resolvePickupLoginTarget(query);

  if (typeof query.phone === "string" && query.phone) {
    phone.value = query.phone;
  }
});

onShow(() => {
  void restoreExistingSession();
  void loadVerificationProvider();
});

onMounted(() => {
  void syncLoginInputAccessibility();
});
</script>

<template>
  <MobileShell eyebrow="小柜大爱" title="小柜大爱" subtitle="让公益更近一点">
    <GlassCard tone="neutral" class="login-card">
      <view class="vm-stack">
        <view class="login-heading">
          <text class="login-heading__title">登录</text>
          <text class="login-heading__body">已注册或已审核通过的手机号可直接登录</text>
        </view>

        <view class="login-guide">
          <view class="login-guide__item">
            <text class="login-guide__index">1</text>
            <text>{{ appCopy.disclaimer.loginGuide }}</text>
          </view>
          <view class="login-guide__item">
            <text class="login-guide__index">2</text>
            <text>{{ verificationPresentation.guideText }}</text>
          </view>
          <view class="login-guide__item">
            <text class="login-guide__index">3</text>
            <text>系统会按身份进入领取、补货或管理页面</text>
          </view>
        </view>

        <view class="vm-field">
          <text id="app-login-phone-label" class="vm-field__label">手机号</text>
          <view class="vm-field-shell">
            <MenuIcon name="phone" size="sm" tone="neutral" />
            <input
              v-model="phone"
              id="app-login-phone"
              class="vm-field-shell__input"
              type="tel"
              inputmode="numeric"
              maxlength="11"
              name="phone"
              autocomplete="tel"
              aria-label="手机号"
              placeholder="请输入手机号"
            />
          </view>
        </view>

        <view class="vm-field">
          <view class="field-header">
            <text id="app-login-code-label" class="vm-field__label">验证码</text>
            <text class="vm-field__helper">{{ verificationPresentation.codeHelper }}</text>
          </view>
          <view class="vm-field-shell vm-field-shell--stacked-action">
            <MenuIcon name="code" size="sm" tone="neutral" />
            <input
              v-model="code"
              id="app-login-code"
              class="vm-field-shell__input"
              type="tel"
              inputmode="numeric"
              :maxlength="verificationProvider === 'manual' ? 6 : 8"
              name="verification-code"
              autocomplete="one-time-code"
              aria-label="验证码"
              :placeholder="verificationProvider === 'manual' ? '请输入 6 位一次性验证码' : '请输入验证码'"
            />
            <button
              v-if="verificationPresentation.canRequestCode"
              class="vm-field-shell__button"
              :disabled="sendingCode"
              :loading="sendingCode"
              @tap="sendCode"
              aria-label="获取验证码"
            >
              获取验证码
            </button>
          </view>
        </view>

        <view
          class="disclaimer-agreement"
          :class="{ 'disclaimer-agreement--invalid': Boolean(disclaimerValidationMessage) }"
          :aria-invalid="String(Boolean(disclaimerValidationMessage))"
        >
          <checkbox-group @change="handleDisclaimerAgreementChange">
            <label class="disclaimer-agreement__label">
              <checkbox
                value="accepted"
                :checked="hasAcceptedDisclaimer"
                color="#167a67"
              />
              <text class="disclaimer-agreement__copy">{{ appCopy.disclaimer.agreementCopy }}</text>
              <text class="disclaimer-link" @tap.stop="openDisclaimer">
                《{{ appCopy.disclaimer.title }}》
              </text>
            </label>
          </checkbox-group>
          <text
            v-if="disclaimerValidationMessage"
            class="disclaimer-agreement__error"
            role="alert"
            aria-live="assertive"
          >
            {{ disclaimerValidationMessage }}
          </text>
        </view>

        <view class="entry-actions">
          <button class="vm-button" :loading="submitting" @tap="submit">登录 / 身份识别</button>
        </view>

        <view class="login-footnote">
          <text class="register-link" @tap="goRegister">{{ registrationActionLabel }}</text>
        </view>

        <view v-if="showVerificationPreview && previewCode" class="debug-box">
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
          <button class="vm-button" @tap="goRegister">{{ registrationStateActionLabel }}</button>
          <button v-if="loginState.state !== 'not_registered'" class="vm-button vm-button--ghost" @tap="goReview">
            查看审核状态
          </button>
          <button class="vm-button vm-button--soft" @tap="goFeedback">联系工作人员</button>
        </view>
      </view>
    </GlassCard>

    <view v-if="showDisclaimer" class="disclaimer-mask">
      <view
        ref="disclaimerDialog"
        class="disclaimer-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="disclaimer-dialog-title"
        aria-describedby="disclaimer-dialog-hint disclaimer-dialog-progress"
        tabindex="-1"
        @keydown.esc.stop.prevent="closeDisclaimer"
      >
        <view class="disclaimer-dialog__header">
          <text id="disclaimer-dialog-title" class="disclaimer-dialog__title">{{ appCopy.disclaimer.title }}</text>
          <text id="disclaimer-dialog-hint" class="disclaimer-dialog__hint">{{ appCopy.disclaimer.dialogHint }}</text>
        </view>

        <scroll-view
          class="disclaimer-dialog__body"
          scroll-y
          :aria-label="appCopy.disclaimer.bodyAriaLabel"
        >
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

        <view class="disclaimer-dialog__actions disclaimer-dialog__actions--single">
          <button class="vm-button" @tap="closeDisclaimer">关闭并返回登录</button>
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
  padding-top: 34rpx;
}

.login-heading {
  display: grid;
  justify-items: center;
  gap: 8rpx;
  padding: 4rpx 0 10rpx;
  text-align: center;
}

.login-heading__title {
  font-size: 40rpx;
  line-height: 1.16;
  font-weight: 900;
  color: var(--vm-text);
}

.login-heading__body {
  font-size: 24rpx;
  line-height: 1.5;
  color: var(--vm-text-soft);
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

.login-guide {
  display: grid;
  gap: 12rpx;
  padding: 18rpx 20rpx;
  border-radius: 22rpx;
  border: 1rpx solid var(--vm-line);
  background: var(--vm-surface-soft);
}

.login-guide__item {
  display: grid;
  grid-template-columns: auto minmax(0, 1fr);
  align-items: center;
  gap: 12rpx;
  font-size: 24rpx;
  line-height: 1.5;
  color: var(--vm-text);
}

.login-guide__index {
  display: grid;
  place-items: center;
  width: 36rpx;
  height: 36rpx;
  border-radius: 50%;
  background: var(--vm-accent);
  color: #ffffff;
  font-size: 20rpx;
  font-weight: 900;
}

.disclaimer-link {
  padding: 4rpx 0;
  border: 0;
  background: transparent;
  box-shadow: none;
  color: var(--vm-accent-strong);
  font-size: 24rpx;
  line-height: 1.6;
  text-align: left;
  text-decoration: underline;
  text-underline-offset: 4rpx;
}

.disclaimer-agreement {
  display: grid;
  gap: 10rpx;
  padding: 18rpx 20rpx;
  border: 2rpx solid var(--vm-line);
  border-radius: 20rpx;
  background: var(--vm-surface-soft);
  transition: border-color 180ms ease, background-color 180ms ease, box-shadow 180ms ease;
}

.disclaimer-agreement--invalid {
  border-color: var(--vm-warning);
  background: color-mix(in srgb, var(--vm-warning) 8%, var(--vm-surface-soft));
  box-shadow: 0 0 0 4rpx color-mix(in srgb, var(--vm-warning) 14%, transparent);
}

.disclaimer-agreement__label {
  display: flex;
  align-items: flex-start;
  gap: 10rpx;
  min-width: 0;
  font-size: 24rpx;
  line-height: 1.6;
  color: var(--vm-text);
}

.disclaimer-agreement__copy {
  flex: 0 0 auto;
}

.disclaimer-agreement__error {
  display: block;
  color: var(--vm-warning);
  font-size: 23rpx;
  font-weight: 700;
  line-height: 1.5;
}

.register-link {
  padding: 6rpx 0;
  border: 0;
  background: transparent;
  box-shadow: none;
  color: var(--vm-warning);
  font-size: 24rpx;
  line-height: 1.6;
}

.login-footnote {
  display: grid;
  grid-template-columns: 1fr;
  justify-items: start;
  gap: 16rpx;
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
  box-sizing: border-box;
  width: 100%;
  min-width: 0;
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

.disclaimer-dialog__actions--single {
  grid-template-columns: 1fr;
}
</style>

