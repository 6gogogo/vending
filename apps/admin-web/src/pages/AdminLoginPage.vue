<script setup lang="ts">
import { computed, ref } from "vue";
import { RouterLink, useRouter } from "vue-router";

import { adminApi } from "../api/admin";
import { useAdminSessionStore } from "../stores/session";

const router = useRouter();
const sessionStore = useAdminSessionStore();

const username = ref("");
const password = ref("");
const busy = ref(false);
const errorMessage = ref("");

const busyLabel = computed(() => (busy.value ? "登录中..." : "进入后台"));

const submit = async () => {
  if (busy.value) {
    return;
  }

  busy.value = true;
  errorMessage.value = "";
  try {
    const response = await adminApi.backofficeLogin(username.value, password.value);
    sessionStore.setSession(response);
    await router.replace(sessionStore.defaultPath);
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : "登录失败。";
  } finally {
    busy.value = false;
  }
};
</script>

<template>
  <section class="login-shell">
    <form class="login-panel admin-panel" @submit.prevent="submit">
      <div class="login-panel__head">
        <h1 class="login-panel__title">公益智助柜后台</h1>
        <p class="admin-copy">服务商平台账号、客户实例管理员和已开通后台账号的商家可登录 PC 后台。</p>
      </div>

      <label class="admin-field">
        <span class="admin-field__label">账号</span>
        <input
          v-model="username"
          class="admin-input"
          name="username"
          autocomplete="username"
          placeholder="请输入管理员账号"
        />
      </label>

      <label class="admin-field">
        <span class="admin-field__label">密码</span>
        <input
          v-model="password"
          class="admin-input"
          type="password"
          name="password"
          autocomplete="current-password"
          placeholder="请输入管理员密码"
        />
      </label>

      <div v-if="errorMessage" class="admin-note login-panel__error" role="alert">{{ errorMessage }}</div>

      <button class="admin-button" type="submit" :disabled="busy || !username || !password">
        {{ busyLabel }}
      </button>

      <RouterLink class="login-panel__guide" to="/guide">查看按身份操作指引</RouterLink>
    </form>
  </section>
</template>

<style scoped>
.login-shell {
  position: relative;
  isolation: isolate;
  min-height: 100vh;
  display: grid;
  place-items: center;
  padding: 24px;
  overflow: hidden;
  background: #eef5ef;
}

.login-shell::before,
.login-shell::after {
  position: absolute;
  z-index: -1;
  content: "";
  pointer-events: none;
}

.login-shell::before {
  width: min(56vw, 760px);
  height: min(56vw, 760px);
  right: -22vw;
  top: -26vw;
  border-radius: 46% 54% 60% 40%;
  background: #d7ead8;
  transform: rotate(18deg);
}

.login-shell::after {
  width: min(44vw, 620px);
  height: min(44vw, 620px);
  left: -18vw;
  bottom: -28vw;
  border-radius: 62% 38% 45% 55%;
  border: 1px solid rgba(23, 122, 103, 0.18);
  transform: rotate(-22deg);
}

.login-panel {
  position: relative;
  width: min(420px, 100%);
  display: grid;
  gap: 14px;
  padding: 24px;
  border: 1px solid #c7dac9;
  background: #ffffff;
  box-shadow: none;
}

.login-panel__head {
  display: grid;
  gap: 6px;
}

.login-panel__title {
  margin: 0;
  font-size: clamp(1.5rem, 3vw, 1.9rem);
}

.login-panel__error {
  background: #fff1ef;
  border-color: #e4b7b2;
  color: #a5443f;
}

.login-panel__guide {
  justify-self: start;
  color: var(--admin-accent-strong);
  font-weight: 700;
  text-decoration: none;
}

.login-panel__guide:hover {
  text-decoration: underline;
}

@media (max-width: 560px) {
  .login-shell {
    place-items: start center;
    padding: 72px 18px 24px;
  }

  .login-panel {
    padding: 22px 18px;
  }
}
</style>
