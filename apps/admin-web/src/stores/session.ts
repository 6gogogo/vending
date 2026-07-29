import { defineStore } from "pinia";
import {
  normalizeBackofficePermissions,
  type BackofficePermission,
  type BackofficeRole,
  type BackofficeScope
} from "@vm/shared-types";

const storageKey = "vm-admin-session";
const defaultBackofficeRoutes: Array<{ permission: BackofficePermission; path: string }> = [
  { permission: "platform-overview:view", path: "/platform" },
  { permission: "dashboard:view", path: "/dashboard" },
  { permission: "merchant-workbench:view", path: "/merchant" },
  { permission: "goods:view", path: "/goods" },
  { permission: "devices:view", path: "/operations" },
  { permission: "warehouse:view", path: "/warehouse" },
  { permission: "users:view", path: "/users" },
  { permission: "operation-logs:view", path: "/logs" },
  { permission: "analytics:data-monitor:view", path: "/data-monitor" },
  { permission: "ai-insights:view", path: "/ai" },
  { permission: "system-settings:view", path: "/settings" }
];

interface AdminSessionUser {
  id: string;
  role: "admin" | "merchant" | "restocker";
  backofficeRole: BackofficeRole;
  scope: BackofficeScope;
  tenantId?: string;
  tenantName?: string;
  permissions?: BackofficePermission[];
  name: string;
  phone: string;
  tags: string[];
}

interface AdminSessionAuth {
  username: string;
  usesDefaultPassword: boolean;
  passwordUpdatedAt: string;
}

interface AdminSessionState {
  token?: string;
  user?: AdminSessionUser;
  auth?: AdminSessionAuth;
  validatedToken?: string;
}

/**
 * 后台的可见菜单与路由必须服从当前服务端会话下发的权限集。
 * 这与角色的理论默认权限不同：服务商在平台态、默认实例和新实例会拿到不同集合。
 */
export const resolveBackofficeSessionPermissions = (
  permissions?: readonly string[]
): BackofficePermission[] => normalizeBackofficePermissions(permissions);

const readStoredState = (): AdminSessionState => {
  if (typeof window === "undefined") {
    return {};
  }

  const raw = window.localStorage.getItem(storageKey);

  if (!raw) {
    return {};
  }

  try {
    return JSON.parse(raw) as AdminSessionState;
  } catch {
    return {};
  }
};

export const useAdminSessionStore = defineStore("admin-session", {
  state: (): AdminSessionState => ({
    ...readStoredState(),
    validatedToken: undefined
  }),
  getters: {
    isAuthenticated: (state) => Boolean(state.token && state.user),
    isSuperAdmin: (state) => state.user?.backofficeRole === "super_admin",
    isProvider: (state) => state.user?.scope === "provider",
    isProviderSuperAdmin: (state) =>
      state.user?.backofficeRole === "super_admin" && state.user.scope === "provider",
    isAdmin: (state) => state.user?.backofficeRole === "admin",
    isMerchant: (state) => state.user?.backofficeRole === "merchant",
    isRestocker: (state) => state.user?.backofficeRole === "restocker",
    permissions: (state) => resolveBackofficeSessionPermissions(state.user?.permissions),
    can: (state) => (permission: BackofficePermission) =>
      resolveBackofficeSessionPermissions(state.user?.permissions).includes(permission),
    canAny: (state) => (permissions: BackofficePermission[]) =>
      permissions.some((permission) =>
        resolveBackofficeSessionPermissions(state.user?.permissions).includes(permission)
      ),
    defaultPath: (state) => {
      if (!state.user) {
        return "/login";
      }

      const permissions = resolveBackofficeSessionPermissions(state.user.permissions);
      return defaultBackofficeRoutes.find((entry) => permissions.includes(entry.permission))?.path ?? "/login";
    },
    needsValidation: (state) => Boolean(state.token && state.token !== state.validatedToken)
  },
  actions: {
    setSession(payload: { token: string; user: AdminSessionUser; auth: AdminSessionAuth }) {
      this.token = payload.token;
      this.user = payload.user;
      this.auth = payload.auth;
      this.validatedToken = payload.token;
      this.persist();
    },
    markValidated(token: string) {
      this.validatedToken = token;
    },
    clearSession() {
      this.token = undefined;
      this.user = undefined;
      this.auth = undefined;
      this.validatedToken = undefined;
      this.persist();
    },
    persist() {
      if (typeof window === "undefined") {
        return;
      }

      if (!this.token || !this.user) {
        window.localStorage.removeItem(storageKey);
        return;
      }

      window.localStorage.setItem(
        storageKey,
        JSON.stringify({
          token: this.token,
          user: this.user,
          auth: this.auth
        })
      );
    }
  }
});
