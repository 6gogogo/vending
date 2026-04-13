<script setup lang="ts">
import { computed } from "vue";
import { RouterLink, RouterView, useRoute, useRouter } from "vue-router";

import { useAdminSessionStore } from "../stores/session";

interface NavItem {
  to: string;
  label: string;
}

const route = useRoute();
const router = useRouter();
const sessionStore = useAdminSessionStore();

const navSections: Array<{ title: string; items: NavItem[] }> = [
  {
    title: "总览",
    items: [
      {
        to: "/dashboard",
        label: "运营总览"
      },
      {
        to: "/goods",
        label: "货物总览"
      },
      {
        to: "/operations",
        label: "柜机监控"
      },
      {
        to: "/data-monitor",
        label: "数据监控"
      }
    ]
  },
  {
    title: "人员与日志",
    items: [
      {
        to: "/users",
        label: "人员管理"
      },
      {
        to: "/logs",
        label: "日志总览"
      }
    ]
  },
];

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

  if (target === "/users") {
    return route.path.startsWith("/users");
  }

  if (target === "/logs") {
    return route.path.startsWith("/logs");
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
      </div>

      <nav class="workbench__nav">
        <section v-for="section in navSections" :key="section.title" class="workbench__nav-group">
          <p class="workbench__nav-title">{{ section.title }}</p>
          <RouterLink
            v-for="item in section.items"
            :key="item.to"
            :to="item.to"
            class="workbench__nav-link"
            :class="{ 'workbench__nav-link--active': isActive(item.to) }"
          >
            <span class="workbench__nav-label">{{ item.label }}</span>
          </RouterLink>
        </section>
      </nav>

      <div class="workbench__status admin-panel">
        <p class="admin-kicker">当前模块</p>
        <h2 class="workbench__status-title">{{ currentGroup }}</h2>
        <p class="admin-copy">{{ sessionStore.user?.name ?? "管理员" }}</p>
        <button class="admin-button admin-button--ghost" @click="logout">退出登录</button>
      </div>
    </aside>

    <main class="workbench__main">
      <header class="workbench__header admin-panel">
        <div>
          <span class="admin-kicker">{{ currentMeta.eyebrow }}</span>
          <h2 class="admin-page-title">{{ currentMeta.title }}</h2>
        </div>
        <p class="admin-copy workbench__header-copy">{{ currentMeta.description }}</p>
      </header>

      <section class="workbench__content">
        <RouterView />
      </section>
    </main>
  </div>
</template>
