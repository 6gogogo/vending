<script setup lang="ts">
import { computed, ref } from "vue";
import { useRouter } from "vue-router";

import { adminApi } from "../api/admin";
import { useAdminSessionStore } from "../stores/session";

const router = useRouter();
const sessionStore = useAdminSessionStore();

const phone = ref("13800000001");
const code = ref("123456");
const previewCode = ref("");
const busy = ref(false);
const errorMessage = ref("");

const busyLabel = computed(() => (busy.value ? "处理中..." : "进入后台"));

const sendCode = async () => {
  busy.value = true;
  errorMessage.value = "";
  try {
    const response = await adminApi.requestCode(phone.value);
    previewCode.value = response.previewCode;
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : "验证码发送失败。";
  } finally {
    busy.value = false;
  }
};

const submit = async () => {
  busy.value = true;
  errorMessage.value = "";
  try {
    const response = await adminApi.adminLogin(phone.value, code.value);
    sessionStore.setSession(response);
    await router.replace("/dashboard");
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : "登录失败。";
  } finally {
    busy.value = false;
  }
};
</script>

<template>
  <section class="login-shell">
    <article class="login-panel admin-panel">
      <div class="login-panel__head">
        <span class="admin-kicker">管理员登录</span>
        <h1 class="login-panel__title">公益智助柜后台</h1>
        <p class="admin-copy">仅管理员可登录此 PC 后台并执行远程开门、人员修改和任务处理。</p>
      </div>

      <label class="admin-field">
        <span class="admin-field__label">手机号</span>
        <input v-model="phone" class="admin-input" placeholder="请输入管理员手机号" />
      </label>

      <div class="login-panel__code-row">
        <label class="admin-field">
          <span class="admin-field__label">验证码</span>
          <input v-model="code" class="admin-input" placeholder="请输入验证码" />
        </label>
        <button class="admin-button admin-button--ghost" :disabled="busy || !phone" @click="sendCode">
          获取验证码
        </button>
      </div>

      <div v-if="previewCode" class="admin-note">开发环境验证码：{{ previewCode }}</div>
      <div v-if="errorMessage" class="admin-note login-panel__error">{{ errorMessage }}</div>

      <button class="admin-button" :disabled="busy || !phone || !code" @click="submit">
        {{ busyLabel }}
      </button>
    </article>
  </section>
</template>

<style scoped>
.login-shell {
  min-height: 100vh;
  display: grid;
  place-items: center;
  padding: 24px;
  background: var(--admin-bg);
}

.login-panel {
  width: min(420px, 100%);
  display: grid;
  gap: 14px;
  padding: 24px;
}

.login-panel__head {
  display: grid;
  gap: 6px;
}

.login-panel__title {
  margin: 0;
  font-size: 1.42rem;
}

.login-panel__code-row {
  display: grid;
  grid-template-columns: minmax(0, 1fr) 120px;
  gap: 10px;
  align-items: end;
}

.login-panel__error {
  background: #fff1ef;
  border-color: #e4b7b2;
  color: #a5443f;
}

@media (max-width: 640px) {
  .login-panel__code-row {
    grid-template-columns: 1fr;
  }
}
</style>
