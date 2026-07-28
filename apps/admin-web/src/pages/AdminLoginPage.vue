<script setup lang="ts">
import { computed, inject, ref } from "vue";
import { useRouter } from "vue-router";

import { adminApi } from "../api/admin";
import { useAdminSessionStore } from "../stores/session";
import { runtimeStatusLabelInjectionKey } from "../utils/runtime-data-plane";

const router = useRouter();
const sessionStore = useAdminSessionStore();

const username = ref("");
const password = ref("");
const busy = ref(false);
const errorMessage = ref("");
const runtimeStatusLabel = inject(runtimeStatusLabelInjectionKey, computed(() => ""));

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
        <span class="admin-kicker">后台登录</span>
        <span v-if="runtimeStatusLabel" class="login-panel__status" role="status">{{ runtimeStatusLabel }}</span>
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
    </form>
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

.login-panel__status {
  justify-self: start;
  padding: 4px 8px;
  border: 1px solid rgba(146, 64, 14, 0.36);
  border-radius: 999px;
  color: #78350f;
  background: #fff7ed;
  font-size: 0.78rem;
  font-weight: 700;
}

.login-panel__error {
  background: #fff1ef;
  border-color: #e4b7b2;
  color: #a5443f;
}
</style>
