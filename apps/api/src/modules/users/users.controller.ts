import { Body, Controller, Get, Inject, Post, Query, UseGuards } from "@nestjs/common";

import type { UserRole } from "@vm/shared-types";

import { ok } from "../../common/dto/api-response";
import { AllowedRoles } from "../../common/guards/allowed-roles.decorator";
import { RoleGuard } from "../../common/guards/role.guard";
import { UsersService } from "./users.service";

@Controller("users")
@UseGuards(RoleGuard)
@AllowedRoles("admin")
export class UsersController {
  constructor(@Inject(UsersService) private readonly usersService: UsersService) {}

  @Get()
  list(@Query("role") role?: UserRole) {
    return ok(this.usersService.list(role));
  }

  @Post("import")
  importUsers(
    @Body()
    body: {
      role: Extract<UserRole, "special" | "merchant">;
      entries: Array<Record<string, unknown> & { phone: string; name: string }>;
    }
  ) {
    return ok(this.usersService.importUsers(body));
  }
}
