import { BadRequestException } from "@nestjs/common";

import type { UserRecord, UserRole } from "@vm/shared-types";

interface TenantAdminContinuityStore {
  users: UserRecord[];
  backofficeCredentials: Array<{
    userId: string;
    role: string;
    tenantId?: string;
  }>;
  getUserTenantId(user: UserRecord): string | undefined;
  isHiddenBackofficeUser(user?: UserRecord): boolean;
}

export interface TenantAdminContinuityChange {
  user: UserRecord;
  nextRole?: UserRole;
  nextStatus?: UserRecord["status"];
}

const hasTenantAdminCredential = (
  store: TenantAdminContinuityStore,
  user: UserRecord,
  tenantId: string
) =>
  store.backofficeCredentials.some(
    (credential) =>
      credential.userId === user.id &&
      credential.role === "admin" &&
      credential.tenantId === tenantId
  );

const isAvailableTenantAdmin = (
  store: TenantAdminContinuityStore,
  user: UserRecord,
  tenantId: string,
  role = user.role,
  status = user.status
) =>
  role === "admin" &&
  status === "active" &&
  !store.isHiddenBackofficeUser(user) &&
  store.getUserTenantId(user) === tenantId &&
  hasTenantAdminCredential(store, user, tenantId);

export const assertTenantsKeepActiveBackofficeAdmin = (
  store: TenantAdminContinuityStore,
  changes: TenantAdminContinuityChange[]
) => {
  const affectedTenantIds = new Set(
    changes
      .filter(({ user, nextRole, nextStatus }) => {
        const tenantId = store.getUserTenantId(user);
        return (
          tenantId !== undefined &&
          isAvailableTenantAdmin(store, user, tenantId) &&
          !isAvailableTenantAdmin(
            store,
            user,
            tenantId,
            nextRole ?? user.role,
            nextStatus ?? user.status
          )
        );
      })
      .map(({ user }) => store.getUserTenantId(user))
      .filter((tenantId): tenantId is string => tenantId !== undefined)
  );

  if (!affectedTenantIds.size) {
    return;
  }

  const changesByUserId = new Map(changes.map((change) => [change.user.id, change]));
  for (const tenantId of affectedTenantIds) {
    const keepsAvailableAdmin = store.users.some((user) => {
      const change = changesByUserId.get(user.id);
      return isAvailableTenantAdmin(
        store,
        user,
        tenantId,
        change?.nextRole ?? user.role,
        change?.nextStatus ?? user.status
      );
    });

    if (!keepsAvailableAdmin) {
      throw new BadRequestException(
        "每个客户实例至少需要保留一名启用且可登录的实例管理员。"
      );
    }
  }
};
