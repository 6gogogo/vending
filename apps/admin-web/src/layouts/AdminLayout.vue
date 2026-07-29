<script setup lang="ts">
import { computed, inject, reactive, ref } from "vue";
import { RouterLink, RouterView, useRoute, useRouter } from "vue-router";
import type { BackofficePermission, BackofficeRole } from "@vm/shared-types";

import { adminApi } from "../api/admin";
import { hasBackofficeRouteRole, useAdminSessionStore } from "../stores/session";
import {
  runtimeStatusLabelInjectionKey
} from "../utils/runtime-data-plane";

interface NavItem {
  to: string;
  label: string;
  icon: string;
  permission: BackofficePermission;
  roles?: readonly BackofficeRole[];
}

const route = useRoute();
const router = useRouter();
const sessionStore = useAdminSessionStore();
const showPasswordPanel = ref(false);
const passwordBusy = ref(false);
const logoutBusy = ref(false);
const exitInstanceBusy = ref(false);
const runtimeStatusLabel = inject(runtimeStatusLabelInjectionKey, computed(() => ""));
const passwordMessage = ref<{ type: "success" | "error"; text: string } | null>(null);
const passwordForm = reactive({
  currentPassword: "",
  newPassword: "",
  confirmPassword: ""
});

const navSections: Array<{ title: string; items: NavItem[] }> = [
  {
    title: "服务商后台",
    items: [
      {
        to: "/platform",
        label: "全局工作台",
        permission: "platform-overview:view",
        roles: ["super_admin"],
        icon: "M5.75 4A2.75 2.75 0 0 0 3 6.75v10.5A2.75 2.75 0 0 0 5.75 20h12.5A2.75 2.75 0 0 0 21 17.25V6.75A2.75 2.75 0 0 0 18.25 4zm0 1.5h12.5c.69 0 1.25.56 1.25 1.25v10.5c0 .69-.56 1.25-1.25 1.25H5.75c-.69 0-1.25-.56-1.25-1.25V6.75c0-.69.56-1.25 1.25-1.25m1.25 3a.75.75 0 0 0 0 1.5h4a.75.75 0 0 0 0-1.5zm0 3.25a.75.75 0 0 0 0 1.5h10a.75.75 0 0 0 0-1.5zm0 3.25a.75.75 0 0 0 0 1.5h7a.75.75 0 0 0 0-1.5z"
      }
    ]
  },
  {
    title: "商家后台",
    items: [
      {
        to: "/merchant",
        label: "商家工作台",
        permission: "merchant-workbench:view",
        roles: ["merchant"],
        icon: "M5.75 5A2.75 2.75 0 0 0 3 7.75v8.5A2.75 2.75 0 0 0 5.75 19h12.5A2.75 2.75 0 0 0 21 16.25v-8.5A2.75 2.75 0 0 0 18.25 5zm0 1.5h12.5c.69 0 1.25.56 1.25 1.25v1.5H4.5v-1.5c0-.69.56-1.25 1.25-1.25m-1.25 4.25h15v5.5c0 .69-.56 1.25-1.25 1.25H5.75c-.69 0-1.25-.56-1.25-1.25zm2.75 1.5a.75.75 0 0 0 0 1.5h3.5a.75.75 0 0 0 0-1.5z"
      }
    ]
  },
  {
    title: "总览",
    items: [
      {
        to: "/dashboard",
        label: "运营总览",
        permission: "dashboard:view",
        roles: ["super_admin", "admin"],
        icon: "M4 6.75A2.75 2.75 0 0 1 6.75 4h10.5A2.75 2.75 0 0 1 20 6.75v10.5A2.75 2.75 0 0 1 17.25 20H6.75A2.75 2.75 0 0 1 4 17.25zm2.75.75a.75.75 0 0 0-.75.75v2.5h5v-3.25zm6.5 0v3.25h5v-2.5a.75.75 0 0 0-.75-.75zM6 12.25v4.5c0 .414.336.75.75.75h5V12.25zm6.5 0v5.25h4.75a.75.75 0 0 0 .75-.75v-4.5z"
      },
      {
        to: "/goods",
        label: "货品总览",
        permission: "goods:view",
        roles: ["super_admin", "admin"],
        icon: "M5.75 5A2.75 2.75 0 0 0 3 7.75v8.5A2.75 2.75 0 0 0 5.75 19h12.5A2.75 2.75 0 0 0 21 16.25v-8.5A2.75 2.75 0 0 0 18.25 5zm0 1.5h12.5c.69 0 1.25.56 1.25 1.25v1.5H4.5v-1.5c0-.69.56-1.25 1.25-1.25m-1.25 4.25h15v5.5c0 .69-.56 1.25-1.25 1.25H5.75c-.69 0-1.25-.56-1.25-1.25zm2.75 1.5a.75.75 0 0 0 0 1.5h3.5a.75.75 0 0 0 0-1.5z"
      },
      {
        to: "/operations",
        label: "柜机监控",
        permission: "devices:view",
        icon: "M6.5 4h11A2.5 2.5 0 0 1 20 6.5v11a2.5 2.5 0 0 1-2.5 2.5h-11A2.5 2.5 0 0 1 4 17.5v-11A2.5 2.5 0 0 1 6.5 4m0 1.5c-.552 0-1 .448-1 1v11c0 .552.448 1 1 1h11c.552 0 1-.448 1-1v-11c0-.552-.448-1-1-1zm2.25 2.75a.75.75 0 0 0 0 1.5h6.5a.75.75 0 0 0 0-1.5zm0 3.5a.75.75 0 0 0 0 1.5h6.5a.75.75 0 0 0 0-1.5zm0 3.5a.75.75 0 0 0 0 1.5h3a.75.75 0 0 0 0-1.5z"
      },
      {
        to: "/data-monitor",
        label: "数据监控",
        permission: "analytics:data-monitor:view",
        roles: ["super_admin", "admin"],
        icon: "M5.75 18A2.75 2.75 0 0 1 3 15.25v-6.5A2.75 2.75 0 0 1 5.75 6h12.5A2.75 2.75 0 0 1 21 8.75v6.5A2.75 2.75 0 0 1 18.25 18zm4.5-7a.75.75 0 0 0-1.5 0v3a.75.75 0 0 0 1.5 0zm2.5-1.5a.75.75 0 0 0-1.5 0v4.5a.75.75 0 0 0 1.5 0zm2.5 2a.75.75 0 0 0-1.5 0v2.5a.75.75 0 0 0 1.5 0z"
      },
      {
        to: "/warehouse",
        label: "本地仓库",
        permission: "warehouse:view",
        roles: ["super_admin", "admin"],
        icon: "M12 3.75l7.5 3.5v9.5L12 20.25l-7.5-3.5v-9.5zm0 1.65L6.03 8.18l5.97 2.78l5.97-2.78zm-6 4v6.4l5.25 2.45v-6.4zm6.75 8.85L18 15.8V9.4l-5.25 2.45z"
      }
    ]
  },
  {
    title: "人员与日志",
    items: [
      {
        to: "/users",
        label: "人员管理",
        permission: "users:view",
        roles: ["super_admin", "admin"],
        icon: "M12 4.5a3.5 3.5 0 1 1 0 7a3.5 3.5 0 0 1 0-7m-5.25 11A3.75 3.75 0 0 1 10.5 11.75h3A3.75 3.75 0 0 1 17.25 15.5v2.25a.75.75 0 0 1-1.5 0V15.5a2.25 2.25 0 0 0-2.25-2.25h-3A2.25 2.25 0 0 0 8.25 15.5v2.25a.75.75 0 0 1-1.5 0z"
      },
      {
        to: "/logs",
        label: "日志总览",
        permission: "operation-logs:view",
        roles: ["super_admin", "admin"],
        icon: "M6.75 4h8.69c.464 0 .909.184 1.237.513l2.81 2.81c.329.328.513.773.513 1.237v8.69A2.75 2.75 0 0 1 17.25 20H6.75A2.75 2.75 0 0 1 4 17.25V6.75A2.75 2.75 0 0 1 6.75 4m0 1.5c-.69 0-1.25.56-1.25 1.25v10.5c0 .69.56 1.25 1.25 1.25h10.5c.69 0 1.25-.56 1.25-1.25V9.31L14.69 5.5zm2 4a.75.75 0 0 0 0 1.5h6.5a.75.75 0 0 0 0-1.5zm0 3.5a.75.75 0 0 0 0 1.5h6.5a.75.75 0 0 0 0-1.5z"
      }
    ]
  },
  {
    title: "智能助手",
    items: [
      {
        to: "/ai",
        label: "AI 工作台",
        permission: "ai-insights:view",
        roles: ["super_admin", "admin"],
        icon: "M10.29 3.86a1.75 1.75 0 0 1 3.42 0l.18.86a7.85 7.85 0 0 1 1.7.7l.76-.45a1.75 1.75 0 0 1 2.33.63l.42.74a1.75 1.75 0 0 1-.44 2.26l-.68.57q.08.4.08.83t-.08.83l.68.57a1.75 1.75 0 0 1 .44 2.26l-.42.74a1.75 1.75 0 0 1-2.33.63l-.76-.45a7.9 7.9 0 0 1-1.7.7l-.18.86a1.75 1.75 0 0 1-3.42 0l-.18-.86a7.84 7.84 0 0 1-1.7-.7l-.76.45a1.75 1.75 0 0 1-2.33-.63l-.42-.74a1.75 1.75 0 0 1 .44-2.26l.68-.57A4.3 4.3 0 0 1 5.75 12q0-.43.08-.83l-.68-.57a1.75 1.75 0 0 1-.44-2.26l.42-.74a1.75 1.75 0 0 1 2.33-.63l.76.45c.54-.3 1.11-.53 1.7-.7zm1.71 5.39a2.75 2.75 0 1 0 0 5.5a2.75 2.75 0 0 0 0-5.5"
      }
    ]
  },
  {
    title: "系统设置",
    items: [
      {
        to: "/settings",
        label: "系统设置",
        permission: "system-settings:view",
        roles: ["super_admin", "admin"],
        icon: "M10.29 3.86a1.75 1.75 0 0 1 3.42 0l.16.76c.52.14 1.02.34 1.49.62l.68-.41a1.75 1.75 0 0 1 2.35.61l.46.79a1.75 1.75 0 0 1-.43 2.25l-.6.5c.05.34.08.68.08 1.02s-.03.68-.08 1.02l.6.5a1.75 1.75 0 0 1 .43 2.25l-.46.79a1.75 1.75 0 0 1-2.35.61l-.68-.41c-.47.28-.97.49-1.49.62l-.16.76a1.75 1.75 0 0 1-3.42 0l-.16-.76a6.6 6.6 0 0 1-1.49-.62l-.68.41a1.75 1.75 0 0 1-2.35-.61l-.46-.79a1.75 1.75 0 0 1 .43-2.25l.6-.5A6.7 6.7 0 0 1 6.1 12c0-.34.03-.68.08-1.02l-.6-.5a1.75 1.75 0 0 1-.43-2.25l.46-.79a1.75 1.75 0 0 1 2.35-.61l.68.41c.47-.28.97-.49 1.49-.62zm1.71 5.14a2.5 2.5 0 1 0 0 5a2.5 2.5 0 0 0 0-5"
      }
    ]
  },
];

const visibleNavSections = computed(() =>
  navSections
    .map((section) => ({
      ...section,
      items: section.items.filter(
        (item) =>
          sessionStore.can(item.permission) &&
          hasBackofficeRouteRole(sessionStore.user?.backofficeRole, item.roles)
      )
    }))
    .filter((section) => section.items.length > 0)
);
const canViewDataMonitor = computed(() =>
  sessionStore.can("analytics:data-monitor:view") &&
  hasBackofficeRouteRole(sessionStore.user?.backofficeRole, ["super_admin", "admin"])
);

const currentMeta = computed(() => ({
  eyebrow: typeof route.meta.eyebrow === "string" ? route.meta.eyebrow : "后台工作台",
  title: typeof route.meta.title === "string" ? route.meta.title : "公益智助柜后台",
  description:
    typeof route.meta.description === "string"
      ? route.meta.description
      : "围绕柜机、人员和日志组织后台运营工作流。"
}));

const currentGroup = computed(() =>
  typeof route.meta.group === "string" ? route.meta.group : "总览"
);

const isInsideProviderTenant = computed(
  () =>
    sessionStore.user?.backofficeRole === "super_admin" &&
    sessionStore.user?.scope === "tenant"
);

const roleLabel = computed(() => {
  if (sessionStore.user?.backofficeRole === "restocker") {
    return "补货员";
  }

  if (sessionStore.user?.backofficeRole === "merchant") {
    return "商家";
  }

  if (sessionStore.user?.backofficeRole === "admin") {
    return "客户管理员";
  }

  return isInsideProviderTenant.value ? "服务商（实例内）" : "服务商";
});
const todayLabel = new Intl.DateTimeFormat("zh-CN", {
  year: "numeric",
  month: "2-digit",
  day: "2-digit"
}).format(new Date());

const logout = async () => {
  if (logoutBusy.value) {
    return;
  }

  logoutBusy.value = true;
  try {
    await adminApi.logout();
  } catch {
    window.alert("服务器暂未确认令牌撤销，本机仍会退出登录。请勿在共享设备上保留此页面。");
  } finally {
    sessionStore.clearSession();
    await router.replace("/login");
    logoutBusy.value = false;
  }
};

const exitPlatformInstance = async () => {
  if (exitInstanceBusy.value || !isInsideProviderTenant.value) {
    return;
  }

  exitInstanceBusy.value = true;
  try {
    const session = await adminApi.exitPlatformTenant();
    sessionStore.setSession(session);
    await router.replace("/platform");
  } catch (error) {
    window.alert(error instanceof Error ? error.message : "退出客户实例失败，请稍后重试。");
  } finally {
    exitInstanceBusy.value = false;
  }
};

const togglePasswordPanel = () => {
  showPasswordPanel.value = !showPasswordPanel.value;
  passwordMessage.value = null;

  if (!showPasswordPanel.value) {
    passwordForm.currentPassword = "";
    passwordForm.newPassword = "";
    passwordForm.confirmPassword = "";
  }
};

const passwordMinimumLength = computed(() =>
  sessionStore.auth?.username === "admin" && sessionStore.user?.backofficeRole === "admin" ? 6 : 8
);

const submitPasswordChange = async () => {
  passwordMessage.value = null;

  if (!passwordForm.currentPassword || !passwordForm.newPassword) {
    passwordMessage.value = {
      type: "error",
      text: "请先填写当前密码和新密码。"
    };
    return;
  }

  if (passwordForm.newPassword.trim().length < passwordMinimumLength.value) {
    passwordMessage.value = {
      type: "error",
      text: `新密码至少需要 ${passwordMinimumLength.value} 位。`
    };
    return;
  }

  if (passwordForm.newPassword !== passwordForm.confirmPassword) {
    passwordMessage.value = {
      type: "error",
      text: "两次输入的新密码不一致。"
    };
    return;
  }

  passwordBusy.value = true;
  try {
    const response = await adminApi.changeAdminPassword({
      currentPassword: passwordForm.currentPassword,
      newPassword: passwordForm.newPassword
    });
    sessionStore.setSession(response);
    passwordMessage.value = {
      type: "success",
      text: "密码已更新。"
    };
    passwordForm.currentPassword = "";
    passwordForm.newPassword = "";
    passwordForm.confirmPassword = "";
  } catch (error) {
    passwordMessage.value = {
      type: "error",
      text: error instanceof Error ? error.message : "修改密码失败。"
    };
  } finally {
    passwordBusy.value = false;
  }
};

const isActive = (target: string) => {
  if (target === "/operations") {
    return route.path.startsWith("/operations");
  }

  if (target === "/goods") {
    return route.path.startsWith("/goods");
  }

  if (target === "/data-monitor") {
    return route.path.startsWith("/data-monitor");
  }

  if (target === "/warehouse") {
    return route.path.startsWith("/warehouse");
  }

  if (target === "/users") {
    return route.path.startsWith("/users");
  }

  if (target === "/logs") {
    return route.path.startsWith("/logs");
  }

  if (target === "/ai") {
    return route.path.startsWith("/ai");
  }

  if (target === "/merchant") {
    return route.path.startsWith("/merchant");
  }

  if (target === "/settings") {
    return route.path.startsWith("/settings");
  }

  if (target === "/platform") {
    return route.path.startsWith("/platform");
  }

  return route.path === target;
};
</script>

<template>
  <div class="admin-shell workbench">
    <a class="admin-skip-link" href="#admin-main-content">跳到主要内容</a>
    <aside class="workbench__sidebar">
      <div class="workbench__brand-panel admin-panel">
        <div class="workbench__brand-head">
          <span class="workbench__brand-mark" aria-hidden="true">
            <svg viewBox="0 0 24 24">
              <path d="M12 2.75 4.25 6.9 12 11.1l7.75-4.2z" />
              <path d="M3.5 8.1v8.2L11.2 21v-8.25z" />
              <path d="M12.8 21l7.7-4.7V8.1l-7.7 4.65z" />
              <path d="m7.1 6.95 4.9-2.62 4.9 2.62-4.9 2.66z" class="workbench__brand-mark-cut" />
            </svg>
          </span>
          <span class="admin-kicker">小柜大爱</span>
        </div>
        <h1 class="workbench__brand">运营后台</h1>
        <p class="workbench__brand-copy">面向社区运营场景，按人员、物资、柜机和日志组织日常值守工作。</p>
      </div>

      <nav class="workbench__nav">
        <section v-for="section in visibleNavSections" :key="section.title" class="workbench__nav-group">
          <p class="workbench__nav-title">{{ section.title }}</p>
          <RouterLink
            v-for="item in section.items"
            :key="item.to"
            :to="item.to"
            class="workbench__nav-link"
            :class="{ 'workbench__nav-link--active': isActive(item.to) }"
            :aria-current="isActive(item.to) ? 'page' : undefined"
          >
            <span class="workbench__nav-icon" aria-hidden="true">
              <svg viewBox="0 0 24 24">
                <path :d="item.icon" />
              </svg>
            </span>
            <span class="workbench__nav-label">{{ item.label }}</span>
          </RouterLink>
        </section>
      </nav>

      <div class="workbench__status admin-panel">
        <p class="admin-kicker">当前模块</p>
        <h2 class="workbench__status-title">{{ currentGroup }}</h2>
        <div class="workbench__operator">
          <span class="workbench__operator-name">{{ sessionStore.user?.name ?? "后台用户" }}</span>
          <span class="admin-pill admin-pill--success">{{ roleLabel }}</span>
        </div>
        <p class="admin-copy workbench__status-copy">
          登录账号：{{ sessionStore.auth?.username ?? "admin" }}
          <span v-if="sessionStore.user?.tenantName"> · {{ sessionStore.user.tenantName }}</span>
        </p>
        <div v-if="sessionStore.auth?.usesDefaultPassword" class="admin-note workbench__password-warning">
          当前仍在使用默认密码，建议立即修改。
        </div>
        <button
          v-if="isInsideProviderTenant"
          class="admin-button"
          :disabled="exitInstanceBusy"
          @click="exitPlatformInstance"
        >
          {{ exitInstanceBusy ? "退出实例中..." : "退出当前实例" }}
        </button>
        <button class="admin-button admin-button--ghost" @click="togglePasswordPanel">
          {{ showPasswordPanel ? "收起改密" : "修改密码" }}
        </button>
        <div v-if="showPasswordPanel" class="workbench__password-panel">
          <label class="admin-field">
            <span class="admin-field__label">当前密码</span>
            <input
              v-model="passwordForm.currentPassword"
              class="admin-input"
              type="password"
              autocomplete="current-password"
              placeholder="请输入当前密码"
            />
          </label>
          <label class="admin-field">
            <span class="admin-field__label">新密码</span>
            <input
              v-model="passwordForm.newPassword"
              class="admin-input"
              type="password"
              autocomplete="new-password"
              :placeholder="`新密码至少 ${passwordMinimumLength} 位`"
            />
          </label>
          <label class="admin-field">
            <span class="admin-field__label">确认新密码</span>
            <input
              v-model="passwordForm.confirmPassword"
              class="admin-input"
              type="password"
              autocomplete="new-password"
              placeholder="请再次输入新密码"
              @keyup.enter="submitPasswordChange"
            />
          </label>
          <div v-if="passwordMessage" class="admin-note" :class="{ 'workbench__password-note--error': passwordMessage.type === 'error' }">
            {{ passwordMessage.text }}
          </div>
          <button class="admin-button" :disabled="passwordBusy" @click="submitPasswordChange">
            {{ passwordBusy ? "保存中..." : "保存新密码" }}
          </button>
        </div>
        <button class="admin-button admin-button--ghost" :disabled="logoutBusy" @click="logout">
          {{ logoutBusy ? "退出中..." : "退出登录" }}
        </button>
      </div>
    </aside>

    <main id="admin-main-content" class="workbench__main" tabindex="-1">
      <header class="workbench__topbar admin-panel">
        <div class="workbench__breadcrumb">
          <span class="workbench__topbar-mark" aria-hidden="true">
            <svg viewBox="0 0 24 24">
              <path d="M12 3 4 7.2l8 4.35 8-4.35z" />
              <path d="M4 8.85v8.05l7.25 4.1v-8.05z" />
              <path d="M12.75 21 20 16.9V8.85l-7.25 4.1z" />
            </svg>
          </span>
          <strong>小柜大爱</strong>
          <span>/</span>
          <span>{{ currentGroup }}</span>
          <span>/</span>
          <span>{{ currentMeta.eyebrow }}</span>
        </div>
        <div class="workbench__topbar-actions">
          <span v-if="runtimeStatusLabel" class="workbench__topbar-chip workbench__topbar-chip--runtime" role="status">
            {{ runtimeStatusLabel }}
          </span>
          <span class="workbench__topbar-chip">业务日 {{ todayLabel }}</span>
          <span v-if="sessionStore.user?.tenantName" class="workbench__topbar-chip">
            {{ sessionStore.user.tenantName }}
          </span>
          <span class="workbench__topbar-chip">{{ roleLabel }}</span>
          <RouterLink
            v-if="canViewDataMonitor"
            class="workbench__topbar-link"
            to="/data-monitor"
          >
            数据监控
          </RouterLink>
        </div>
      </header>

      <header class="workbench__header admin-panel">
        <div>
          <span class="admin-kicker">{{ currentMeta.eyebrow }}</span>
          <h2 class="admin-page-title">{{ currentMeta.title }}</h2>
          <p class="admin-subtitle workbench__header-copy">{{ currentMeta.description }}</p>
        </div>
        <div class="workbench__header-side">
          <span class="admin-kicker">当前页面</span>
          <span class="workbench__header-value">{{ currentGroup }}</span>
          <p class="admin-copy">请按页面提示完成当前实例的日常管理。</p>
        </div>
      </header>

      <section class="workbench__content">
        <RouterView />
      </section>
    </main>
  </div>
</template>

<style scoped>
.workbench__brand-head {
  display: flex;
  align-items: center;
  gap: 10px;
}

.workbench__brand-mark {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 38px;
  height: 38px;
  border-radius: 8px;
  background: linear-gradient(135deg, var(--admin-accent-strong), var(--admin-accent));
  color: #ffffff;
  box-shadow: 0 10px 22px rgba(8, 91, 76, 0.2);
}

.workbench__brand-mark svg {
  width: 25px;
  height: 25px;
  fill: currentColor;
}

.workbench__brand-mark-cut {
  fill: #d8fff2;
  opacity: 0.9;
}

.workbench__topbar {
  min-height: 54px;
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 16px;
  padding: 10px 14px;
}

.workbench__breadcrumb,
.workbench__topbar-actions {
  display: flex;
  align-items: center;
  gap: 10px;
  min-width: 0;
}

.workbench__breadcrumb {
  color: var(--admin-text-muted);
  font-size: 0.86rem;
}

.workbench__breadcrumb strong {
  color: var(--admin-text);
  font-size: 0.94rem;
}

.workbench__topbar-mark {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 26px;
  height: 26px;
  border-radius: 6px;
  background: var(--admin-accent);
  color: #fff;
}

.workbench__topbar-mark svg {
  width: 18px;
  height: 18px;
  fill: currentColor;
}

.workbench__topbar-chip,
.workbench__topbar-link {
  min-height: 30px;
  display: inline-flex;
  align-items: center;
  padding: 0 10px;
  border: 1px solid var(--admin-line);
  border-radius: 6px;
  background: #fff;
  color: var(--admin-text-muted);
  font-size: 0.82rem;
  font-weight: 700;
  text-decoration: none;
  white-space: nowrap;
}

.workbench__topbar-link {
  color: var(--admin-accent-strong);
}

.workbench__topbar-chip--runtime {
  border-color: rgba(146, 64, 14, 0.36);
  color: #78350f;
  background: #fff7ed;
}

.workbench__nav-icon {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 28px;
  height: 28px;
  margin-right: 10px;
  border-radius: 8px;
  background: var(--admin-info-soft);
  color: var(--admin-info);
  transition: background-color 160ms ease, color 160ms ease;
}

.workbench__nav-link--active .workbench__nav-icon {
  background: var(--admin-accent);
  color: #ffffff;
}

.workbench__nav-icon svg {
  width: 16px;
  height: 16px;
  fill: currentColor;
}

.workbench__operator {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  margin-top: 10px;
}

.workbench__operator-name {
  min-width: 0;
  color: var(--admin-text);
  font-weight: 700;
}

.workbench__password-panel {
  position: absolute;
  left: 10px;
  right: 10px;
  bottom: calc(100% + 10px);
  z-index: 10;
  display: grid;
  gap: 10px;
  padding: 12px;
  border: 1px solid var(--admin-line);
  border-radius: 8px;
  background: #fff;
  box-shadow: var(--admin-shadow);
}

.workbench__password-warning {
  margin-top: 4px;
}

.workbench__password-note--error {
  background: #fff1ef;
  border-color: #e4b7b2;
  color: #a5443f;
}

@media (max-width: 900px) {
  .workbench__topbar,
  .workbench__topbar-actions {
    align-items: flex-start;
    flex-direction: column;
  }

  .workbench__breadcrumb {
    flex-wrap: wrap;
  }
}

@media (min-width: 561px) and (max-width: 760px) and (max-height: 650px) {
  .workbench__topbar {
    min-height: 44px;
    flex-direction: row;
    align-items: center;
    flex-wrap: wrap;
    gap: 6px 10px;
    padding: 6px 8px;
  }

  .workbench__breadcrumb {
    flex: 1 1 270px;
    align-items: center;
    flex-wrap: wrap;
    gap: 6px;
  }

  .workbench__topbar-actions {
    flex: 0 1 auto;
    flex-direction: row;
    align-items: center;
    justify-content: flex-end;
    flex-wrap: wrap;
    gap: 6px;
  }

  .workbench__topbar-chip,
  .workbench__topbar-link {
    min-height: 28px;
    padding: 0 8px;
    font-size: 0.78rem;
  }

  .workbench__sidebar {
    display: flex;
    align-items: center;
    gap: 8px;
    min-height: 0;
    padding: 6px 8px;
  }

  .workbench__brand-panel {
    display: flex;
    flex: 0 0 auto;
    align-items: center;
    gap: 8px;
    padding: 0;
  }

  .workbench__brand-head .admin-kicker,
  .workbench__status > .admin-kicker,
  .workbench__status-title,
  .workbench__status-copy,
  .workbench__password-warning {
    display: none;
  }

  .workbench__brand-mark {
    width: 32px;
    height: 32px;
  }

  .workbench__brand-mark svg {
    width: 21px;
    height: 21px;
  }

  .workbench__brand {
    margin: 0;
    white-space: nowrap;
  }

  .workbench__nav {
    display: flex;
    flex: 1 1 auto;
    align-items: center;
    gap: 4px;
    min-width: 0;
    padding: 0 0 3px;
    overflow-x: auto;
    overscroll-behavior-inline: contain;
  }

  .workbench__nav-group {
    display: contents;
  }

  .workbench__nav-title {
    display: none;
  }

  .workbench__nav-link {
    flex: 0 0 auto;
    min-height: 34px;
    padding: 0 8px;
    white-space: nowrap;
  }

  .workbench__nav-icon {
    width: 24px;
    height: 24px;
    margin-right: 5px;
  }

  .workbench__status {
    display: flex;
    flex: 0 0 auto;
    align-self: stretch;
    align-items: center;
    gap: 6px;
    padding: 0 0 0 8px;
    border: 0;
    border-left: 1px solid var(--admin-line);
  }

  .workbench__operator {
    margin: 0;
  }

  .workbench__status .admin-button {
    min-height: 32px;
    padding: 0 8px;
    white-space: nowrap;
  }

  .workbench__password-panel {
    top: calc(100% + 8px);
    right: 0;
    bottom: auto;
    left: auto;
    width: min(300px, calc(100vw - 20px));
  }
}
</style>
