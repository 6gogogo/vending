<script setup lang="ts">
import { computed, ref } from "vue";
import { RouterLink, useRouter } from "vue-router";

import { adminApi } from "../api/admin";
import { useAdminSessionStore } from "../stores/session";

const router = useRouter();
const sessionStore = useAdminSessionStore();

const username = ref("");
const password = ref("");
const showPassword = ref(false);
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
          placeholder="请输入后台登录账号"
        />
      </label>

      <div class="admin-field">
        <label class="admin-field__label" for="backoffice-password">密码</label>
        <div class="login-panel__password-control">
          <input
            id="backoffice-password"
            v-model="password"
            class="admin-input"
            :type="showPassword ? 'text' : 'password'"
            name="password"
            autocomplete="current-password"
            autocapitalize="none"
            spellcheck="false"
            placeholder="请输入管理员密码"
          />
          <button
            class="login-panel__password-toggle"
            type="button"
            :aria-pressed="showPassword"
            @click="showPassword = !showPassword"
          >
            {{ showPassword ? "隐藏密码" : "显示密码" }}
          </button>
        </div>
      </div>

      <div v-if="errorMessage" class="admin-note login-panel__error" role="alert">
        <span>{{ errorMessage }}</span>
        <small>刚重置过密码时，请先清空浏览器自动填充，再重新输入并核对。</small>
      </div>

      <button class="admin-button" type="submit" :disabled="busy || !username || !password">
        {{ busyLabel }}
      </button>

      <div class="login-panel__links">
        <RouterLink class="login-panel__guide" to="/forgot-password">忘记密码</RouterLink>
        <RouterLink class="login-panel__guide" to="/guide">登录前使用向导</RouterLink>
      </div>
    </form>
  </section>
</template>

<style scoped>
.login-shell {
  --login-shell-gutter: 48px;
  position: relative;
  isolation: isolate;
  min-height: 100vh;
  display: grid;
  grid-template-columns: minmax(0, 1fr);
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
  width: min(420px, calc(100vw - var(--login-shell-gutter)));
  max-width: 100%;
  min-width: 0;
  justify-self: center;
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
  display: grid;
  gap: 6px;
  background: #fff1ef;
  border-color: #e4b7b2;
  color: #a5443f;
}

.login-panel__password-control {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  gap: 8px;
}

.login-panel__password-control .admin-input {
  min-width: 0;
}

.login-panel__password-toggle {
  min-width: 84px;
  border: 1px solid var(--admin-line);
  border-radius: 10px;
  background: #ffffff;
  color: var(--admin-accent-strong);
  font: inherit;
  font-weight: 700;
  cursor: pointer;
}

.login-panel__password-toggle:hover,
.login-panel__password-toggle:focus-visible {
  border-color: var(--admin-accent);
  background: #f2f8f4;
}

.login-panel__guide {
  color: var(--admin-accent-strong);
  font-weight: 700;
  text-decoration: none;
}

.login-panel__guide:hover {
  text-decoration: underline;
}

.login-panel__links {
  display: flex;
  flex-wrap: wrap;
  justify-content: space-between;
  gap: 10px 18px;
}

@media (max-width: 560px) {
  .login-shell {
    --login-shell-gutter: 36px;
    place-items: start center;
    padding: 72px 18px 24px;
  }

  .login-panel {
    padding: 22px 18px;
  }
}
</style>
