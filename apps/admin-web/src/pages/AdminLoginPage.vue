<script setup lang="ts">
import { computed, ref } from "vue";
import { useRouter } from "vue-router";

import { adminApi } from "../api/admin";
import { useAdminSessionStore } from "../stores/session";

const router = useRouter();
const sessionStore = useAdminSessionStore();

const username = ref("admin");
const password = ref("");
const busy = ref(false);
const errorMessage = ref("");

const busyLabel = computed(() => (busy.value ? "登录中..." : "进入后台"));

const submit = async () => {
  busy.value = true;
  errorMessage.value = "";
  try {
    const response = await adminApi.backofficeLogin(username.value, password.value);
    sessionStore.setSession(response);
    await router.replace(response.user.backofficeRole === "merchant" ? "/merchant" : "/dashboard");
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
        <span class="admin-kicker">后台登录</span>
        <h1 class="login-panel__title">公益智助柜后台</h1>
        <p class="admin-copy">超级管理员和已开通后台账号的商家可登录 PC 后台。</p>
      </div>

      <label class="admin-field">
        <span class="admin-field__label">账号</span>
        <input v-model="username" class="admin-input" placeholder="请输入管理员账号" />
      </label>

      <label class="admin-field">
        <span class="admin-field__label">密码</span>
        <input
          v-model="password"
          class="admin-input"
          type="password"
          placeholder="请输入管理员密码"
          @keyup.enter="submit"
        />
      </label>

      <div class="admin-note">空库或无超级管理员凭证时，系统会自动补建超级管理员：账号 `admin`，密码 `admin`。</div>
      <div v-if="errorMessage" class="admin-note login-panel__error">{{ errorMessage }}</div>

      <button class="admin-button" :disabled="busy || !username || !password" @click="submit">
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

.login-panel__error {
  background: #fff1ef;
  border-color: #e4b7b2;
  color: #a5443f;
}
</style>
