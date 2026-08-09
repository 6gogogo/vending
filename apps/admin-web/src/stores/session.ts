import { defineStore } from "pinia";
import {
  normalizeBackofficePermissions,
  type BackofficePermission,
  type BackofficeRole,
  type BackofficeScope
} from "@vm/shared-types";

const storageKey = "vm-admin-session";
const backofficeRoles = ["super_admin", "admin", "merchant", "restocker"] as const;

const defaultBackofficeRoutes: Array<{
  permission: BackofficePermission;
  path: string;
  roles: readonly BackofficeRole[];
}> = [
  { permission: "platform-overview:view", path: "/platform", roles: ["super_admin"] },
  { permission: "dashboard:view", path: "/dashboard", roles: ["super_admin", "admin"] },
  { permission: "merchant-workbench:view", path: "/merchant", roles: ["merchant"] },
  { permission: "devices:view", path: "/operations", roles: ["super_admin", "admin", "merchant", "restocker"] },
  { permission: "goods:view", path: "/goods", roles: ["super_admin", "admin"] },
  { permission: "warehouse:view", path: "/warehouse", roles: ["super_admin", "admin"] },
  { permission: "users:view", path: "/users", roles: ["super_admin", "admin"] },
  { permission: "operation-logs:view", path: "/logs", roles: ["super_admin", "admin"] },
  { permission: "analytics:data-monitor:view", path: "/data-monitor", roles: ["super_admin", "admin"] },
  { permission: "ai-insights:view", path: "/ai", roles: ["super_admin", "admin"] },
  { permission: "system-settings:view", path: "/settings", roles: ["super_admin", "admin"] }
];

interface AdminSessionUser {
  id: string;
  role: "admin" | "merchant" | "restocker";
  backofficeRole: BackofficeRole;
  scope: BackofficeScope;
  tenantId?: string;
  tenantName?: string;
  tenantServiceMode?: "simulation" | "production";
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

export const isBackofficeRole = (value: unknown): value is BackofficeRole =>
  typeof value === "string" && (backofficeRoles as readonly string[]).includes(value);

export const hasBackofficeRouteRole = (
  role: BackofficeRole | undefined,
  allowedRoles?: readonly BackofficeRole[]
) => !allowedRoles?.length || Boolean(role && allowedRoles.includes(role));

export const hasBackofficeRouteAccess = (
  role: BackofficeRole | undefined,
  grantedPermissions: readonly string[] | undefined,
  requiredPermissions: readonly BackofficePermission[],
  allowedRoles?: readonly BackofficeRole[]
) => {
  if (!hasBackofficeRouteRole(role, allowedRoles)) {
    return false;
  }

  const sessionPermissions = resolveBackofficeSessionPermissions(grantedPermissions);
  return requiredPermissions.every((permission) => sessionPermissions.includes(permission));
};

export const canRecoverManualSettlement = (
  role: BackofficeRole | undefined,
  permissions?: readonly string[]
) =>
  hasBackofficeRouteAccess(
    role,
    permissions,
    ["devices:operate", "goods:stock-adjust"],
    ["super_admin", "admin"]
  );

export const resolveBackofficeDefaultPath = (
  role: BackofficeRole | undefined,
  permissions?: readonly string[]
) => {
  if (!role) {
    return "/login";
  }

  const sessionPermissions = resolveBackofficeSessionPermissions(permissions);
  return (
    defaultBackofficeRoutes.find(
      (entry) =>
        hasBackofficeRouteRole(role, entry.roles) &&
        sessionPermissions.includes(entry.permission)
    )?.path ?? "/login"
  );
};

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

      return resolveBackofficeDefaultPath(
        state.user.backofficeRole,
        state.user.permissions
      );
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
