import { SetMetadata } from "@nestjs/common";

import type { UserRole } from "@vm/shared-types";

export const ALLOWED_ROLES_KEY = "allowed_roles";

export const AllowedRoles = (...roles: UserRole[]) => SetMetadata(ALLOWED_ROLES_KEY, roles);
