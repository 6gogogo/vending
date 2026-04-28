<script setup lang="ts">
import { computed, reactive, ref } from "vue";
import { RouterLink, RouterView, useRoute, useRouter } from "vue-router";

import { adminApi } from "../api/admin";
import { useAdminSessionStore } from "../stores/session";

interface NavItem {
  to: string;
  label: string;
  icon: string;
  roles?: Array<"super_admin" | "merchant">;
}

const route = useRoute();
const router = useRouter();
const sessionStore = useAdminSessionStore();
const showPasswordPanel = ref(false);
const passwordBusy = ref(false);
const passwordMessage = ref<{ type: "success" | "error"; text: string } | null>(null);
const passwordForm = reactive({
  currentPassword: "",
  newPassword: "",
  confirmPassword: ""
});

const navSections: Array<{ title: string; items: NavItem[] }> = [
  {
    title: "商家后台",
    items: [
      {
        to: "/merchant",
        label: "商家工作台",
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
        icon: "M4 6.75A2.75 2.75 0 0 1 6.75 4h10.5A2.75 2.75 0 0 1 20 6.75v10.5A2.75 2.75 0 0 1 17.25 20H6.75A2.75 2.75 0 0 1 4 17.25zm2.75.75a.75.75 0 0 0-.75.75v2.5h5v-3.25zm6.5 0v3.25h5v-2.5a.75.75 0 0 0-.75-.75zM6 12.25v4.5c0 .414.336.75.75.75h5V12.25zm6.5 0v5.25h4.75a.75.75 0 0 0 .75-.75v-4.5z"
      },
      {
        to: "/goods",
        label: "货物总览",
        icon: "M5.75 5A2.75 2.75 0 0 0 3 7.75v8.5A2.75 2.75 0 0 0 5.75 19h12.5A2.75 2.75 0 0 0 21 16.25v-8.5A2.75 2.75 0 0 0 18.25 5zm0 1.5h12.5c.69 0 1.25.56 1.25 1.25v1.5H4.5v-1.5c0-.69.56-1.25 1.25-1.25m-1.25 4.25h15v5.5c0 .69-.56 1.25-1.25 1.25H5.75c-.69 0-1.25-.56-1.25-1.25zm2.75 1.5a.75.75 0 0 0 0 1.5h3.5a.75.75 0 0 0 0-1.5z"
      },
      {
        to: "/operations",
        label: "柜机监控",
        icon: "M6.5 4h11A2.5 2.5 0 0 1 20 6.5v11a2.5 2.5 0 0 1-2.5 2.5h-11A2.5 2.5 0 0 1 4 17.5v-11A2.5 2.5 0 0 1 6.5 4m0 1.5c-.552 0-1 .448-1 1v11c0 .552.448 1 1 1h11c.552 0 1-.448 1-1v-11c0-.552-.448-1-1-1zm2.25 2.75a.75.75 0 0 0 0 1.5h6.5a.75.75 0 0 0 0-1.5zm0 3.5a.75.75 0 0 0 0 1.5h6.5a.75.75 0 0 0 0-1.5zm0 3.5a.75.75 0 0 0 0 1.5h3a.75.75 0 0 0 0-1.5z"
      },
      {
        to: "/data-monitor",
        label: "数据监控",
        icon: "M5.75 18A2.75 2.75 0 0 1 3 15.25v-6.5A2.75 2.75 0 0 1 5.75 6h12.5A2.75 2.75 0 0 1 21 8.75v6.5A2.75 2.75 0 0 1 18.25 18zm4.5-7a.75.75 0 0 0-1.5 0v3a.75.75 0 0 0 1.5 0zm2.5-1.5a.75.75 0 0 0-1.5 0v4.5a.75.75 0 0 0 1.5 0zm2.5 2a.75.75 0 0 0-1.5 0v2.5a.75.75 0 0 0 1.5 0z"
      },
      {
        to: "/warehouse",
        label: "本地仓库",
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
        icon: "M12 4.5a3.5 3.5 0 1 1 0 7a3.5 3.5 0 0 1 0-7m-5.25 11A3.75 3.75 0 0 1 10.5 11.75h3A3.75 3.75 0 0 1 17.25 15.5v2.25a.75.75 0 0 1-1.5 0V15.5a2.25 2.25 0 0 0-2.25-2.25h-3A2.25 2.25 0 0 0 8.25 15.5v2.25a.75.75 0 0 1-1.5 0z"
      },
      {
        to: "/logs",
        label: "日志总览",
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
        icon: "M10.29 3.86a1.75 1.75 0 0 1 3.42 0l.18.86a7.85 7.85 0 0 1 1.7.7l.76-.45a1.75 1.75 0 0 1 2.33.63l.42.74a1.75 1.75 0 0 1-.44 2.26l-.68.57q.08.4.08.83t-.08.83l.68.57a1.75 1.75 0 0 1 .44 2.26l-.42.74a1.75 1.75 0 0 1-2.33.63l-.76-.45a7.9 7.9 0 0 1-1.7.7l-.18.86a1.75 1.75 0 0 1-3.42 0l-.18-.86a7.84 7.84 0 0 1-1.7-.7l-.76.45a1.75 1.75 0 0 1-2.33-.63l-.42-.74a1.75 1.75 0 0 1 .44-2.26l.68-.57A4.3 4.3 0 0 1 5.75 12q0-.43.08-.83l-.68-.57a1.75 1.75 0 0 1-.44-2.26l.42-.74a1.75 1.75 0 0 1 2.33-.63l.76.45c.54-.3 1.11-.53 1.7-.7zm1.71 5.39a2.75 2.75 0 1 0 0 5.5a2.75 2.75 0 0 0 0-5.5"
      }
    ]
  },
  {
    title: "系统设置",
    items: [
      {
        to: "/settings",
        label: "统一设置",
        icon: "M10.29 3.86a1.75 1.75 0 0 1 3.42 0l.16.76c.52.14 1.02.34 1.49.62l.68-.41a1.75 1.75 0 0 1 2.35.61l.46.79a1.75 1.75 0 0 1-.43 2.25l-.6.5c.05.34.08.68.08 1.02s-.03.68-.08 1.02l.6.5a1.75 1.75 0 0 1 .43 2.25l-.46.79a1.75 1.75 0 0 1-2.35.61l-.68-.41c-.47.28-.97.49-1.49.62l-.16.76a1.75 1.75 0 0 1-3.42 0l-.16-.76a6.6 6.6 0 0 1-1.49-.62l-.68.41a1.75 1.75 0 0 1-2.35-.61l-.46-.79a1.75 1.75 0 0 1 .43-2.25l.6-.5A6.7 6.7 0 0 1 6.1 12c0-.34.03-.68.08-1.02l-.6-.5a1.75 1.75 0 0 1-.43-2.25l.46-.79a1.75 1.75 0 0 1 2.35-.61l.68.41c.47-.28.97-.49 1.49-.62zm1.71 5.14a2.5 2.5 0 1 0 0 5a2.5 2.5 0 0 0 0-5"
      }
    ]
  },
];

const visibleNavSections = computed(() => {
  const role = sessionStore.user?.backofficeRole ?? "super_admin";

  return navSections
    .map((section) => ({
      ...section,
      items: section.items.filter((item) => {
        if (item.roles) {
          return item.roles.includes(role);
        }

        return role === "super_admin";
      })
    }))
    .filter((section) => section.items.length > 0);
});

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

const logout = async () => {
  sessionStore.clearSession();
  await router.replace("/login");
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

const submitPasswordChange = async () => {
  passwordMessage.value = null;

  if (!passwordForm.currentPassword || !passwordForm.newPassword) {
    passwordMessage.value = {
      type: "error",
      text: "请先填写当前密码和新密码。"
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

  return route.path === target;
};
</script>

<template>
  <div class="admin-shell workbench">
    <aside class="workbench__sidebar">
      <div class="workbench__brand-panel admin-panel">
        <span class="admin-kicker">公益智助柜</span>
        <h1 class="workbench__brand">后台管理台</h1>
        <p class="workbench__brand-copy">面向街道与政府服务场景，按人员、货物、柜机和日志组织日常值守工作。</p>
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
        <p class="admin-copy workbench__status-copy">{{ sessionStore.user?.name ?? "后台用户" }}</p>
        <p class="admin-copy workbench__status-copy">角色：{{ sessionStore.user?.backofficeRole === "merchant" ? "商家" : "超级管理员" }}</p>
        <p class="admin-copy workbench__status-copy">登录账号：{{ sessionStore.auth?.username ?? "admin" }}</p>
        <div v-if="sessionStore.auth?.usesDefaultPassword" class="admin-note workbench__password-warning">
          当前仍在使用默认密码 `admin`，建议立即修改。
        </div>
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
              placeholder="请输入当前密码"
            />
          </label>
          <label class="admin-field">
            <span class="admin-field__label">新密码</span>
            <input
              v-model="passwordForm.newPassword"
              class="admin-input"
              type="password"
              placeholder="新密码至少 6 位"
            />
          </label>
          <label class="admin-field">
            <span class="admin-field__label">确认新密码</span>
            <input
              v-model="passwordForm.confirmPassword"
              class="admin-input"
              type="password"
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
        <button class="admin-button admin-button--ghost" @click="logout">退出登录</button>
      </div>
    </aside>

    <main class="workbench__main">
      <header class="workbench__header admin-panel">
        <div>
          <span class="admin-kicker">{{ currentMeta.eyebrow }}</span>
          <h2 class="admin-page-title">{{ currentMeta.title }}</h2>
          <p class="admin-subtitle workbench__header-copy">{{ currentMeta.description }}</p>
        </div>
        <div class="workbench__header-side">
          <span class="admin-kicker">工作视图</span>
          <span class="workbench__header-value">{{ currentGroup }}</span>
          <p class="admin-copy">当前模块的入口、数据和操作会在这一栏联动展示。</p>
        </div>
      </header>

      <section class="workbench__content">
        <RouterView />
      </section>
    </main>
  </div>
</template>

<style scoped>
.workbench__nav-icon {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 28px;
  height: 28px;
  margin-right: 10px;
  border-radius: 8px;
  background: rgba(29, 79, 145, 0.1);
  color: var(--admin-accent-strong);
}

.workbench__nav-icon svg {
  width: 16px;
  height: 16px;
  fill: currentColor;
}

.workbench__password-panel {
  display: grid;
  gap: 10px;
}

.workbench__password-warning {
  margin-top: 4px;
}

.workbench__password-note--error {
  background: #fff1ef;
  border-color: #e4b7b2;
  color: #a5443f;
}
</style>
