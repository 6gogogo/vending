<script setup lang="ts">
import { computed, onMounted, onUnmounted, reactive, ref, watch } from "vue";
import { RouterLink, RouterView, useRoute, useRouter } from "vue-router";
import { ArrowUpRight, ChevronRight, ChevronsUpDown, Command, HeartHandshake, Menu, Search, X } from "@lucide/vue";
import { adminApi } from "../api/admin";
import AdminNavigation from "../components/AdminNavigation.vue";
import { useAdminSessionStore } from "../stores/session";
import { resolveWorkspaceServiceLabel } from "../utils/workspace-service-label";
import { adminDestinations, isAdminDestinationActive, canAccessAdminDestination, canAccessAdminSection } from "../utils/admin-navigation";

const route = useRoute();
const router = useRouter();
const sessionStore = useAdminSessionStore();
const searchDialog = ref<HTMLDialogElement>();
const accountDialog = ref<HTMLDialogElement>();
const navigationDialog = ref<HTMLDialogElement>();
const search = ref("");
const showPasswordPanel = ref(false);
const passwordBusy = ref(false);
const logoutBusy = ref(false);
const exitInstanceBusy = ref(false);
const passwordMessage = ref<{ type: "success" | "error"; text: string } | null>(null);
const passwordForm = reactive({ currentPassword: "", newPassword: "", confirmPassword: "" });
const visibleDestinations = computed(() => adminDestinations.filter(item =>
  canAccessAdminDestination(item, sessionStore.user?.backofficeRole, sessionStore.can)
));
const visibleNavSections = computed(() => Array.from(new Set(visibleDestinations.value.map(item => item.group))).map(title => ({
  title, items: visibleDestinations.value.filter(item => item.group === title)
})));
const currentDestination = computed(() => visibleDestinations.value.find(item => isAdminDestinationActive(route.path, item.path)));
const isDetail = computed(() => currentDestination.value && route.path !== currentDestination.value.path);
const currentTitle = computed(() => isDetail.value ? String(route.meta.eyebrow || route.meta.title || "详情") : currentDestination.value?.label || String(route.meta.title || "工作台"));
const currentDescription = computed(() => isDetail.value ? String(route.meta.description || "") : currentDestination.value?.description || "");
const workspaceServiceLabel = computed(() => resolveWorkspaceServiceLabel({ scope: sessionStore.user?.scope, tenantServiceMode: sessionStore.user?.tenantServiceMode }));
const isInsideProviderTenant = computed(() => sessionStore.user?.backofficeRole === "super_admin" && sessionStore.user?.scope === "tenant");
const roleLabel = computed(() => ({ restocker: "补货员", merchant: "商户", admin: "实例管理员", super_admin: isInsideProviderTenant.value ? "服务商 · 实例内" : "服务提供商" })[sessionStore.user?.backofficeRole || "admin"]);
const todayLabel = new Intl.DateTimeFormat("zh-CN", { month: "long", day: "numeric", weekday: "long", timeZone: "Asia/Shanghai" }).format(new Date());
const searchableEntries = computed(() => visibleDestinations.value.flatMap(item => [
  { label: item.label, detail: item.description, to: item.path, searchText: item.label + item.description },
  ...(item.sections || []).filter(section => canAccessAdminSection(section, sessionStore.can)).map(section => ({
    label: section.label, detail: item.label, to: `${item.path}?section=${section.value}`, searchText: item.label + section.label + (section.keywords || "")
  }))
]).filter(item => !search.value.trim() || item.searchText.toLowerCase().includes(search.value.trim().toLowerCase())));
const openSearch = () => { search.value = ""; searchDialog.value?.showModal(); };
const closeAccount = () => {
  if (passwordBusy.value) return;
  accountDialog.value?.close();
  showPasswordPanel.value = false;
  passwordMessage.value = null;
  Object.assign(passwordForm, { currentPassword: "", newPassword: "", confirmPassword: "" });
};
const handleShortcut = (event: KeyboardEvent) => {
  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "k") {
    event.preventDefault();
    if (!accountDialog.value?.open && !navigationDialog.value?.open) openSearch();
  }
};
watch(() => route.fullPath, () => { searchDialog.value?.close(); navigationDialog.value?.close(); });
onMounted(() => window.addEventListener("keydown", handleShortcut));
onUnmounted(() => window.removeEventListener("keydown", handleShortcut));
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

</script>

<template>
  <div class="console-shell">
    <a class="admin-skip-link" href="#admin-main-content">跳到主要内容</a>
    <aside class="console-sidebar" aria-label="工作空间导航">
      <RouterLink :to="sessionStore.defaultPath" class="console-brand">
        <span class="console-brand__mark"><HeartHandshake :size="23" :stroke-width="1.7" aria-hidden="true" /></span>
        <span><strong>小柜大爱</strong><small>公益智助柜 · 运营后台</small></span>
      </RouterLink>
      <button class="console-search-trigger" @click="openSearch"><Search :size="16" aria-hidden="true" />查找功能<kbd>Ctrl K</kbd></button>
      <AdminNavigation :sections="visibleNavSections" />
      <button class="console-account" @click="accountDialog?.showModal()">
        <span class="console-avatar" aria-hidden="true">{{ (sessionStore.user?.name || "管").slice(0, 1) }}</span>
        <span class="console-account__copy"><strong>{{ sessionStore.user?.name || "后台用户" }}</strong><small>{{ roleLabel }}</small></span>
        <ChevronsUpDown :size="16" aria-hidden="true" /><span class="sr-only">账户设置</span>
      </button>
    </aside>

    <div class="console-body">
      <header class="console-topbar">
        <div class="console-topbar__context">
          <button class="console-icon-button console-mobile-menu" aria-label="打开导航" @click="navigationDialog?.showModal()"><Menu :size="20" /></button>
          <span class="console-tenant" :title="sessionStore.user?.tenantName || '服务商平台'">{{ sessionStore.user?.tenantName || "服务商平台" }}</span>
          <ChevronRight :size="14" aria-hidden="true" />
          <RouterLink v-if="isDetail && currentDestination" :to="currentDestination.path" class="console-breadcrumb-link">{{ currentDestination.label }}</RouterLink>
          <span v-else class="console-topbar__group">{{ currentDestination?.group }}</span>
        </div>
        <div class="console-topbar__actions">
          <span class="console-service" role="status">{{ workspaceServiceLabel }}</span>
          <button v-if="isInsideProviderTenant" class="admin-button admin-button--ghost" :disabled="exitInstanceBusy" @click="exitPlatformInstance">{{ exitInstanceBusy ? "退出中…" : "退出实例" }}</button>
          <button class="console-icon-button" aria-label="搜索功能" title="搜索功能（Ctrl K）" @click="openSearch"><Search :size="19" /></button>
          <button class="console-avatar console-account-shortcut" aria-label="账户设置" @click="accountDialog?.showModal()">{{ (sessionStore.user?.name || "管").slice(0, 1) }}</button>
        </div>
      </header>
      <main id="admin-main-content" class="console-main" tabindex="-1">
        <header class="console-page-header">
          <div><h1>{{ currentTitle }}</h1><p>{{ currentDescription }}</p></div>
          <span class="console-date">{{ todayLabel }}</span>
        </header>
        <RouterView />
      </main>
    </div>

    <dialog ref="navigationDialog" class="console-navigation-dialog" aria-label="工作空间导航">
      <div class="console-dialog-heading"><strong>小柜大爱 · 运营后台</strong><button class="console-icon-button" aria-label="关闭导航" @click="navigationDialog?.close()"><X :size="20" /></button></div>
      <AdminNavigation :sections="visibleNavSections" />
    </dialog>

    <dialog ref="searchDialog" class="console-search-dialog" aria-label="查找功能">
      <div class="console-search-field"><Search :size="20" aria-hidden="true" /><input v-model="search" autofocus placeholder="搜索功能，如：导入、审核、调拨…" aria-label="搜索功能名称" /><button class="console-icon-button" aria-label="关闭搜索" @click="searchDialog?.close()"><X :size="18" /></button></div>
      <div class="console-search-results">
        <p class="console-search-caption">{{ search.trim() ? `找到 ${searchableEntries.length} 个入口` : "全部功能 · 可直接打开具体分区" }}</p>
        <RouterLink v-for="entry in searchableEntries" :key="entry.to" :to="entry.to" class="console-search-result">
          <span><strong>{{ entry.label }}</strong><small>{{ entry.detail }}</small></span><ArrowUpRight :size="17" aria-hidden="true" />
        </RouterLink>
        <div v-if="!searchableEntries.length" class="admin-empty"><strong>没有找到相关功能</strong><p>试试“人员”“库存”或“设置”。</p></div>
      </div>
      <div class="console-search-footer"><Command :size="14" aria-hidden="true" /> Tab 选择 · Enter 打开 · Esc 关闭</div>
    </dialog>

    <dialog ref="accountDialog" class="console-account-dialog" aria-labelledby="account-dialog-title" @cancel.prevent="closeAccount">
      <div class="console-dialog-heading"><h2 id="account-dialog-title">账户设置</h2><button class="console-icon-button" aria-label="关闭账户设置" :disabled="passwordBusy" @click="closeAccount"><X :size="20" /></button></div>
      <div class="console-account-info"><span class="console-avatar">{{ (sessionStore.user?.name || "管").slice(0, 1) }}</span><div><strong>{{ sessionStore.user?.name }}</strong><p>{{ roleLabel }} · {{ sessionStore.auth?.username }}</p></div></div>
      <div v-if="sessionStore.auth?.usesDefaultPassword" class="admin-note">当前使用默认密码，建议修改。</div>
      <button class="admin-button admin-button--ghost" :disabled="passwordBusy" @click="togglePasswordPanel">{{ showPasswordPanel ? "收起修改密码" : "修改密码" }}</button>
      <form v-if="showPasswordPanel" class="console-password-form" @submit.prevent="submitPasswordChange">
        <label class="admin-field"><span class="admin-field__label">当前密码</span><input v-model="passwordForm.currentPassword" class="admin-input" type="password" autocomplete="current-password" :disabled="passwordBusy" /></label>
        <label class="admin-field"><span class="admin-field__label">新密码（至少 {{ passwordMinimumLength }} 位）</span><input v-model="passwordForm.newPassword" class="admin-input" type="password" autocomplete="new-password" :disabled="passwordBusy" /></label>
        <label class="admin-field"><span class="admin-field__label">确认新密码</span><input v-model="passwordForm.confirmPassword" class="admin-input" type="password" autocomplete="new-password" :disabled="passwordBusy" /></label>
        <p v-if="passwordMessage" class="admin-note" :class="{ 'admin-alert--danger': passwordMessage.type === 'error' }" role="status">{{ passwordMessage.text }}</p>
        <button class="admin-button" :disabled="passwordBusy">{{ passwordBusy ? "保存中…" : "保存新密码" }}</button>
      </form>
      <button v-if="isInsideProviderTenant" class="admin-button admin-button--ghost" :disabled="exitInstanceBusy || passwordBusy" @click="exitPlatformInstance(); closeAccount()">{{ exitInstanceBusy ? "退出中…" : "退出当前实例" }}</button>
      <button class="admin-button admin-button--ghost" :disabled="logoutBusy || passwordBusy" @click="logout">{{ logoutBusy ? "退出中…" : "退出登录" }}</button>
    </dialog>
  </div>
</template>
