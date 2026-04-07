import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Inject,
  Injectable
} from "@nestjs/common";
import { Reflector } from "@nestjs/core";

import type { UserRole } from "@vm/shared-types";

import { ALLOWED_ROLES_KEY } from "./allowed-roles.decorator";

@Injectable()
export class RoleGuard implements CanActivate {
  // 双保险：正常情况下由 Nest 注入 Reflector；如果未来某处把 Guard 当普通类用，也不会直接崩掉。
  constructor(@Inject(Reflector) private readonly reflector: Reflector = new Reflector()) {}

  canActivate(context: ExecutionContext) {
    const allowedRoles = this.reflector.getAllAndOverride<UserRole[]>(ALLOWED_ROLES_KEY, [
      context.getHandler(),
      context.getClass()
    ]);

    if (!allowedRoles?.length) {
      return true;
    }

    const request = context.switchToHttp().getRequest<{
      headers: Record<string, string | undefined>;
      query: Record<string, string | undefined>;
      body?: Record<string, unknown>;
      userRole?: UserRole;
    }>();

    const headerRole = request.headers["x-role"];
    const queryRole = request.query.role;
    const bodyRole =
      typeof request.body?.role === "string" ? (request.body.role as UserRole) : undefined;
    const resolvedRole = (headerRole ?? queryRole ?? bodyRole) as UserRole | undefined;

    if (!resolvedRole || !allowedRoles.includes(resolvedRole)) {
      throw new ForbiddenException("当前角色无权访问该接口。");
    }

    request.userRole = resolvedRole;
    return true;
  }
}
