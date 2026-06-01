import { SetMetadata } from "@nestjs/common";

import type { BackofficePermission, BackofficeRole, UserRole } from "@vm/shared-types";

export const ALLOWED_ROLES_KEY = "allowed_roles";
export const ALLOWED_BACKOFFICE_ROLES_KEY = "allowed_backoffice_roles";
export const ALLOWED_BACKOFFICE_PERMISSIONS_KEY = "allowed_backoffice_permissions";
export const ALLOWED_BACKOFFICE_ALL_PERMISSIONS_KEY = "allowed_backoffice_all_permissions";
export const ALLOWED_BACKOFFICE_SESSION_PERMISSIONS_KEY = "allowed_backoffice_session_permissions";

export const AllowedRoles = (...roles: UserRole[]) => SetMetadata(ALLOWED_ROLES_KEY, roles);
export const AllowedBackofficeRoles = (...roles: BackofficeRole[]) =>
  SetMetadata(ALLOWED_BACKOFFICE_ROLES_KEY, roles);
export const AllowedBackofficePermissions = (...permissions: BackofficePermission[]) =>
  SetMetadata(ALLOWED_BACKOFFICE_PERMISSIONS_KEY, permissions);
export const AllowedBackofficeAllPermissions = (...permissions: BackofficePermission[]) =>
  SetMetadata(ALLOWED_BACKOFFICE_ALL_PERMISSIONS_KEY, permissions);
export const AllowedBackofficeSessionPermissions = (...permissions: BackofficePermission[]) =>
  SetMetadata(ALLOWED_BACKOFFICE_SESSION_PERMISSIONS_KEY, permissions);
