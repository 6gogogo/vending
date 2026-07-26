import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Inject,
  Injectable
} from "@nestjs/common";
import { Reflector } from "@nestjs/core";

import type { BackofficePermission, BackofficeRole, UserRole } from "@vm/shared-types";

import {
  ALLOWED_BACKOFFICE_ALL_PERMISSIONS_KEY,
  ALLOWED_BACKOFFICE_PERMISSIONS_KEY,
  ALLOWED_BACKOFFICE_ROLES_KEY,
  ALLOWED_BACKOFFICE_SESSION_PERMISSIONS_KEY,
  ALLOWED_ROLES_KEY,
  TENANT_SCOPED_BACKOFFICE_ROUTE_KEY
} from "./allowed-roles.decorator";
import { InMemoryStoreService } from "../store/in-memory-store.service";

@Injectable()
export class RoleGuard implements CanActivate {
  // 双保险：正常情况下由 Nest 注入 Reflector；如果未来某处把 Guard 当普通类用，也不会直接崩掉。
  constructor(
    @Inject(Reflector) private readonly reflector: Reflector = new Reflector(),
    @Inject(InMemoryStoreService) private readonly store: InMemoryStoreService = new InMemoryStoreService()
  ) {}

  canActivate(context: ExecutionContext) {
    const allowedRoles = this.reflector.getAllAndOverride<UserRole[]>(ALLOWED_ROLES_KEY, [
      context.getHandler(),
      context.getClass()
    ]);
    const allowedBackofficeRoles = this.reflector.getAllAndOverride<BackofficeRole[]>(
      ALLOWED_BACKOFFICE_ROLES_KEY,
      [context.getHandler(), context.getClass()]
    );
    const allowedBackofficePermissions = this.reflector.getAllAndOverride<BackofficePermission[]>(
      ALLOWED_BACKOFFICE_PERMISSIONS_KEY,
      [context.getHandler(), context.getClass()]
    );
    const requiredBackofficePermissions = this.reflector.getAllAndOverride<BackofficePermission[]>(
      ALLOWED_BACKOFFICE_ALL_PERMISSIONS_KEY,
      [context.getHandler(), context.getClass()]
    );
    const backofficeSessionPermissions = this.reflector.getAllAndOverride<BackofficePermission[]>(
      ALLOWED_BACKOFFICE_SESSION_PERMISSIONS_KEY,
      [context.getHandler(), context.getClass()]
    );
    const tenantScopedBackofficeRoute = this.reflector.getAllAndOverride<boolean>(
      TENANT_SCOPED_BACKOFFICE_ROUTE_KEY,
      [context.getHandler(), context.getClass()]
    );

    if (
      !allowedRoles?.length &&
      !allowedBackofficeRoles?.length &&
      !allowedBackofficePermissions?.length &&
      !requiredBackofficePermissions?.length &&
      !backofficeSessionPermissions?.length
    ) {
      return true;
    }

    const request = context.switchToHttp().getRequest<{
      headers: Record<string, string | undefined>;
      query: Record<string, string | undefined>;
      body?: Record<string, unknown>;
      userRole?: UserRole;
      authUser?: {
        id: string;
        role: UserRole;
        name: string;
        backofficeRole?: BackofficeRole;
        tenantId?: string;
        permissions?: BackofficePermission[];
      };
    }>();

    const authHeader = request.headers.authorization ?? request.headers.Authorization;
    const bearerToken = authHeader?.startsWith("Bearer ")
      ? authHeader.slice("Bearer ".length)
      : undefined;
    const session = this.store.getSession(bearerToken);
    const sessionUser = session?.backofficeRole
      ? this.store.getBackofficeSessionUser(bearerToken)?.user
      : this.store.getSessionUser(bearerToken);

    if (sessionUser) {
      const requiresBackofficeAccount =
        Boolean(allowedBackofficeRoles?.length) ||
        Boolean(allowedBackofficePermissions?.length) ||
        Boolean(requiredBackofficePermissions?.length);
      const backofficePermissions = this.store.getBackofficeSessionPermissions(session);
      const isBackofficeSession = Boolean(session?.backofficeRole);
      const isNonDefaultTenantSession = Boolean(
        session?.backofficeRole &&
          session.tenantId &&
          session.tenantId !== this.store.getDefaultTenantId()
      );

      if (isNonDefaultTenantSession && !tenantScopedBackofficeRoute) {
        throw new ForbiddenException("当前客户实例暂未开放该业务域。");
      }

      if (allowedRoles?.length && !allowedRoles.includes(sessionUser.role)) {
        throw new ForbiddenException("当前角色无权访问该接口。");
      }

      if (requiresBackofficeAccount && !session?.backofficeRole) {
        throw new ForbiddenException("当前接口需要后台账号登录后访问。");
      }

      if (allowedBackofficeRoles?.length && !allowedBackofficeRoles.includes(session!.backofficeRole!)) {
        throw new ForbiddenException("当前后台账号无权访问该接口。");
      }

      if (
        allowedBackofficePermissions?.length &&
        !allowedBackofficePermissions.some((permission) => backofficePermissions.includes(permission))
      ) {
        throw new ForbiddenException("当前后台账号无权访问该接口。");
      }

      if (
        requiredBackofficePermissions?.length &&
        !requiredBackofficePermissions.every((permission) => backofficePermissions.includes(permission))
      ) {
        throw new ForbiddenException("当前后台账号无权访问该接口。");
      }

      if (
        isBackofficeSession &&
        backofficeSessionPermissions?.length &&
        !backofficeSessionPermissions.some((permission) => backofficePermissions.includes(permission))
      ) {
        throw new ForbiddenException("当前后台账号无权访问该接口。");
      }

      request.userRole = sessionUser.role;
      request.authUser = {
        id: sessionUser.id,
        role: sessionUser.role,
        name: sessionUser.name,
        backofficeRole: session?.backofficeRole,
        tenantId: session?.tenantId,
        permissions: backofficePermissions
      };
      return true;
    }

    if (
      allowedBackofficeRoles?.length ||
      allowedBackofficePermissions?.length ||
      requiredBackofficePermissions?.length
    ) {
      throw new ForbiddenException("当前接口需要后台账号登录后访问。");
    }

    throw new ForbiddenException("当前接口需要登录后访问。");
  }
}
