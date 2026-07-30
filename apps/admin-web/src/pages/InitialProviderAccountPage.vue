<script setup lang="ts">
import { computed, reactive, ref } from "vue";
import { RouterLink, useRouter } from "vue-router";

import { adminApi } from "../api/admin";
import { useAdminSessionStore } from "../stores/session";

const router = useRouter();
const sessionStore = useAdminSessionStore();
const busy = ref(false);
const complete = ref(false);
const message = ref<{ type: "success" | "error"; text: string } | null>(null);
const form = reactive({
  currentAdminPassword: "",
  username: "",
  newPassword: "",
  confirmPassword: ""
});

const canClaim = computed(
  () =>
    sessionStore.user?.backofficeRole === "admin" &&
    sessionStore.auth?.username === "admin"
);

const submit = async () => {
  message.value = null;

  if (!canClaim.value) {
    message.value = {
      type: "error",
      text: "当前账号不能开通服务商平台账号。请使用初始实例管理员账号登录。"
    };
    return;
  }

  if (!form.currentAdminPassword || !form.username.trim() || !form.newPassword) {
    message.value = { type: "error", text: "请填写当前管理员密码、服务商账号和新密码。" };
    return;
  }

  if (form.newPassword.trim().length < 8) {
    message.value = { type: "error", text: "服务商密码至少需要 8 位。" };
    return;
  }

  if (form.newPassword !== form.confirmPassword) {
    message.value = { type: "error", text: "两次输入的新密码不一致。" };
    return;
  }

  busy.value = true;
  try {
    const response = await adminApi.claimInitialProviderAccount({
      currentAdminPassword: form.currentAdminPassword,
      username: form.username.trim(),
      newPassword: form.newPassword
    });
    form.currentAdminPassword = "";
    form.newPassword = "";
    form.confirmPassword = "";
    complete.value = true;
    message.value = {
      type: "success",
      text: `服务商平台账号“${response.username}”已开通。请退出当前管理员会话，再用该账号登录。`
    };
  } catch (error) {
    message.value = {
      type: "error",
      text: error instanceof Error ? error.message : "服务商平台账号开通失败。"
    };
  } finally {
    busy.value = false;
  }
};

const goToLogin = async () => {
  try {
    await adminApi.logout();
  } catch {
    // 本机仍会清理会话；服务器端令牌将在过期或下次撤销时失效。
  }
  sessionStore.clearSession();
  await router.replace("/login");
};
</script>

<template>
  <section class="admin-page provider-setup">
    <section class="admin-panel admin-panel-block provider-setup__panel">
      <p class="admin-kicker">首次开通</p>
      <h2>开通服务商平台账号</h2>
      <p class="admin-copy">
        首次开通时可执行一次。系统会验证当前实例管理员密码，已存在的服务商账号不会被覆盖。
      </p>

      <div class="admin-note">
        开通后，服务商可在“全局工作台”创建、维护并进入客户实例；进入实例后再处理该实例的人员、柜机、库存、预约和验证码。
      </div>

      <form v-if="!complete" class="provider-setup__form" @submit.prevent="submit">
        <label class="admin-field">
          <span class="admin-field__label">当前实例管理员密码</span>
          <input
            v-model="form.currentAdminPassword"
            class="admin-input"
            type="password"
            autocomplete="current-password"
            placeholder="用于确认开通权限"
          />
        </label>
        <label class="admin-field">
          <span class="admin-field__label">服务商登录账号</span>
          <input
            v-model="form.username"
            class="admin-input"
            autocomplete="username"
            maxlength="100"
            placeholder="例如 provider-admin"
          />
        </label>
        <label class="admin-field">
          <span class="admin-field__label">服务商密码</span>
          <input
            v-model="form.newPassword"
            class="admin-input"
            type="password"
            autocomplete="new-password"
            minlength="8"
            placeholder="至少 8 位"
          />
        </label>
        <label class="admin-field">
          <span class="admin-field__label">确认服务商密码</span>
          <input
            v-model="form.confirmPassword"
            class="admin-input"
            type="password"
            autocomplete="new-password"
            minlength="8"
            placeholder="请再次输入服务商密码"
            @keyup.enter="submit"
          />
        </label>

        <div
          v-if="message"
          class="admin-alert"
          :class="{ 'admin-alert--danger': message.type === 'error' }"
          :role="message.type === 'error' ? 'alert' : 'status'"
          aria-live="polite"
        >
          {{ message.text }}
        </div>

        <div class="provider-setup__actions">
          <button class="admin-button" type="submit" :disabled="busy || !canClaim">
            {{ busy ? "开通中..." : "开通服务商账号" }}
          </button>
          <RouterLink class="admin-button admin-button--ghost" to="/dashboard">返回当前后台</RouterLink>
        </div>
      </form>

      <div v-else class="provider-setup__complete">
        <div class="admin-alert" role="status" aria-live="polite">{{ message?.text }}</div>
        <button class="admin-button" type="button" @click="goToLogin">退出并使用服务商账号登录</button>
      </div>
    </section>
  </section>
</template>

<style scoped>
.provider-setup {
  max-width: 760px;
}

.provider-setup__panel,
.provider-setup__form,
.provider-setup__complete {
  display: grid;
  gap: 16px;
}

.provider-setup h2 {
  margin: 0;
}

.provider-setup__form {
  grid-template-columns: repeat(2, minmax(0, 1fr));
}

.provider-setup__form > .admin-note,
.provider-setup__form > .admin-alert,
.provider-setup__actions {
  grid-column: 1 / -1;
}

.provider-setup__actions {
  display: flex;
  flex-wrap: wrap;
  gap: 10px;
}

.provider-setup__actions a {
  text-decoration: none;
}

@media (max-width: 640px) {
  .provider-setup__form {
    grid-template-columns: 1fr;
  }

  .provider-setup__actions > * {
    width: 100%;
  }
}
</style>
