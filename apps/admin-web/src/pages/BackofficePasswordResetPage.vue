<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from "vue";
import { RouterLink } from "vue-router";

import type { VerificationProvider } from "@vm/shared-types";

import { adminApi } from "../api/admin";
import {
  backofficePasswordMinimumLengthForUsername,
  resolveBackofficePasswordResetPreview,
  validateBackofficePasswordResetDraft
} from "../utils/backoffice-provisioning";
import {
  BACKOFFICE_PASSWORD_RESET_RUNTIME_ERROR_MESSAGE,
  canRequestBackofficePasswordResetCode,
  isBackofficePasswordResetVerificationProvider,
  resolveBackofficePasswordResetCodeActionLabel,
  type BackofficePasswordResetRuntimeStatus
} from "../utils/backoffice-password-reset-runtime";
import { getAdminErrorMessage } from "../utils/error-message";

const username = ref("");
const phone = ref("");
const code = ref("");
const newPassword = ref("");
const confirmPassword = ref("");
const verificationProvider = ref<VerificationProvider>();
const runtimeConfigStatus = ref<BackofficePasswordResetRuntimeStatus>("loading");
const runtimeConfigErrorMessage = ref("");
const verificationPreviewEnabled = ref(false);
const previewCode = ref("");
const requestingCode = ref(false);
const resetting = ref(false);
const cooldownSeconds = ref(0);
const message = ref<{ type: "success" | "error" | "info"; text: string }>();
let cooldownTimer: number | undefined;

const isManualMode = computed(() => verificationProvider.value === "manual");
const minimumPasswordLength = computed(() =>
  backofficePasswordMinimumLengthForUsername(username.value)
);
const requestCodeState = computed(() => ({
  status: runtimeConfigStatus.value,
  provider: verificationProvider.value,
  username: username.value,
  phone: phone.value,
  requestingCode: requestingCode.value,
  cooldownSeconds: cooldownSeconds.value
}));
const canRequestCode = computed(() =>
  canRequestBackofficePasswordResetCode(requestCodeState.value)
);
const requestCodeActionLabel = computed(() =>
  resolveBackofficePasswordResetCodeActionLabel(requestCodeState.value)
);

const clearCooldownTimer = () => {
  if (cooldownTimer !== undefined) {
    window.clearInterval(cooldownTimer);
    cooldownTimer = undefined;
  }
};

const startCooldown = (seconds: number) => {
  clearCooldownTimer();
  cooldownSeconds.value = Math.max(1, Math.min(seconds, 60));
  cooldownTimer = window.setInterval(() => {
    cooldownSeconds.value -= 1;
    if (cooldownSeconds.value <= 0) {
      clearCooldownTimer();
    }
  }, 1000);
};

const loadRuntimeConfig = async () => {
  runtimeConfigStatus.value = "loading";
  runtimeConfigErrorMessage.value = "";
  try {
    const config = await adminApi.publicRuntimeConfig();
    if (!isBackofficePasswordResetVerificationProvider(config.verificationProvider)) {
      throw new Error("当前服务未返回可用的验证码方式。");
    }
    verificationProvider.value = config.verificationProvider;
    verificationPreviewEnabled.value = config.verificationPreviewEnabled === true;
    runtimeConfigStatus.value = "ready";
    if (!verificationPreviewEnabled.value) {
      previewCode.value = "";
    }
  } catch (error) {
    verificationProvider.value = undefined;
    verificationPreviewEnabled.value = false;
    previewCode.value = "";
    runtimeConfigStatus.value = "error";
    runtimeConfigErrorMessage.value = getAdminErrorMessage(
      error,
      BACKOFFICE_PASSWORD_RESET_RUNTIME_ERROR_MESSAGE
    );
  }
};

const requestCode = async () => {
  if (!canRequestCode.value) {
    return;
  }

  requestingCode.value = true;
  message.value = undefined;
  previewCode.value = "";
  try {
    const result = await adminApi.requestBackofficePasswordResetCode(
      username.value.trim().toLowerCase(),
      phone.value.trim()
    );
    verificationProvider.value = result.provider;
    previewCode.value = resolveBackofficePasswordResetPreview({
      provider: result.provider,
      previewEnabled: verificationPreviewEnabled.value,
      previewCode: result.previewCode
    });
    startCooldown(result.expiresInSeconds);
    message.value = {
      type: "info",
      text: "找回验证码已发送，请在有效期内完成重置。"
    };
  } catch (error) {
    message.value = {
      type: "error",
      text: getAdminErrorMessage(error, "找回验证码发送失败。")
    };
  } finally {
    requestingCode.value = false;
  }
};

const resetPassword = async () => {
  if (resetting.value) {
    return;
  }

  message.value = undefined;
  const validationMessage = validateBackofficePasswordResetDraft({
    username: username.value,
    phone: phone.value,
    code: code.value,
    newPassword: newPassword.value,
    confirmPassword: confirmPassword.value
  });

  if (validationMessage) {
    message.value = { type: "error", text: validationMessage };
    return;
  }

  resetting.value = true;
  try {
    await adminApi.resetOwnBackofficePassword({
      username: username.value.trim().toLowerCase(),
      phone: phone.value.trim(),
      code: code.value.trim(),
      newPassword: newPassword.value.trim()
    });
    clearCooldownTimer();
    code.value = "";
    previewCode.value = "";
    newPassword.value = "";
    confirmPassword.value = "";
    message.value = {
      type: "success",
      text: "密码已重置，旧登录会话已失效。请返回登录页使用新密码登录。"
    };
  } catch (error) {
    message.value = {
      type: "error",
      text: getAdminErrorMessage(error, "密码重置失败。")
    };
  } finally {
    resetting.value = false;
  }
};

onMounted(loadRuntimeConfig);
onUnmounted(clearCooldownTimer);
</script>

<template>
  <section class="reset-shell">
    <form class="reset-panel admin-panel" @submit.prevent="resetPassword">
      <header class="reset-panel__head">
        <p class="admin-kicker">后台账号恢复</p>
        <h1 class="reset-panel__title">找回实例后台密码</h1>
        <p class="admin-copy">
          使用后台账号绑定的手机号验证身份。重置成功后，该账号原有登录会话会立即失效。
        </p>
      </header>

      <div v-if="isManualMode" class="admin-note">
        当前实例使用人工验证码。请联系同实例另一位管理员签发“后台密码重置”验证码；如果没有其他可登录管理员，请联系服务提供商进入本实例代重置。
      </div>

      <div
        v-if="runtimeConfigErrorMessage"
        class="admin-note reset-panel__message reset-panel__message--error"
        role="alert"
      >
        {{ runtimeConfigErrorMessage }} 验证码获取入口已暂时关闭。
      </div>

      <div v-if="previewCode" class="admin-note" role="status">
        当前模拟验证码：<strong class="admin-number">{{ previewCode }}</strong>
      </div>

      <label class="admin-field">
        <span class="admin-field__label">后台登录账号</span>
        <input
          v-model="username"
          class="admin-input"
          name="username"
          autocomplete="username"
          maxlength="100"
          placeholder="请输入后台登录账号"
        />
      </label>

      <label class="admin-field">
        <span class="admin-field__label">绑定手机号</span>
        <input
          v-model="phone"
          class="admin-input"
          name="phone"
          inputmode="numeric"
          autocomplete="tel"
          maxlength="11"
          placeholder="请输入 11 位手机号"
        />
      </label>

      <div class="reset-panel__code-row">
        <label class="admin-field">
          <span class="admin-field__label">找回验证码</span>
          <input
            v-model="code"
            class="admin-input admin-code"
            name="code"
            inputmode="numeric"
            autocomplete="one-time-code"
            maxlength="8"
            placeholder="请输入 4 至 8 位数字"
          />
        </label>
        <button
          class="admin-button admin-button--ghost reset-panel__code-button"
          type="button"
          :disabled="!canRequestCode"
          @click="requestCode"
        >
          {{ requestCodeActionLabel }}
        </button>
      </div>

      <label class="admin-field">
        <span class="admin-field__label">新密码</span>
        <input
          v-model="newPassword"
          class="admin-input"
          type="password"
          name="new-password"
          autocomplete="new-password"
          :minlength="minimumPasswordLength"
          :placeholder="`至少 ${minimumPasswordLength} 位`"
        />
      </label>

      <label class="admin-field">
        <span class="admin-field__label">再次输入新密码</span>
        <input
          v-model="confirmPassword"
          class="admin-input"
          type="password"
          name="confirm-password"
          autocomplete="new-password"
          :minlength="minimumPasswordLength"
          placeholder="请再次输入新密码"
        />
      </label>

      <div
        v-if="message"
        class="admin-note reset-panel__message"
        :class="{
          'reset-panel__message--error': message.type === 'error',
          'reset-panel__message--success': message.type === 'success'
        }"
        :role="message.type === 'error' ? 'alert' : 'status'"
      >
        {{ message.text }}
      </div>

      <button class="admin-button" type="submit" :disabled="resetting">
        {{ resetting ? "重置中..." : "验证并重置密码" }}
      </button>

      <div class="reset-panel__links">
        <RouterLink class="admin-link" to="/login">返回后台登录</RouterLink>
        <RouterLink class="admin-link" to="/guide">查看登录帮助</RouterLink>
      </div>
    </form>
  </section>
</template>

<style scoped>
.reset-shell {
  min-height: 100vh;
  display: grid;
  place-items: center;
  padding: 28px 18px;
  background:
    radial-gradient(circle at 12% 10%, rgba(59, 137, 94, 0.16), transparent 34%),
    radial-gradient(circle at 92% 90%, rgba(223, 155, 67, 0.14), transparent 32%),
    #eef5ef;
}

.reset-panel {
  width: min(560px, 100%);
  display: grid;
  gap: 15px;
  padding: clamp(20px, 5vw, 30px);
  border: 1px solid #c7dac9;
  background: #fff;
}

.reset-panel__head {
  display: grid;
  gap: 6px;
}

.reset-panel__title {
  margin: 0;
  font-size: clamp(1.55rem, 4vw, 2rem);
}

.reset-panel__code-row {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  align-items: end;
  gap: 12px;
}

.reset-panel__code-button {
  min-width: 152px;
}

.reset-panel__message--error {
  border-color: #e4b7b2;
  background: #fff1ef;
  color: #a5443f;
}

.reset-panel__message--success {
  border-color: #b8d8c2;
  background: #eff8f1;
  color: #17663f;
}

.reset-panel__links {
  display: flex;
  flex-wrap: wrap;
  justify-content: space-between;
  gap: 10px 18px;
}

@media (max-width: 560px) {
  .reset-shell {
    place-items: start center;
    padding-top: 44px;
  }

  .reset-panel__code-row {
    grid-template-columns: 1fr;
  }

  .reset-panel__code-button {
    width: 100%;
  }
}
</style>
