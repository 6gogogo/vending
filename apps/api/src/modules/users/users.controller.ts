import { Body, Controller, Get, Inject, Param, Patch, Post, Query, Req, UseGuards } from "@nestjs/common";

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

  @Post()
  createUser(
    @Body()
    body: {
      role: UserRole;
      phone: string;
      name: string;
      status?: "active" | "inactive";
      neighborhood?: string;
      tags?: string[];
      quota?: {
        dailyLimit: number;
        categoryLimit: Record<string, number>;
      };
    },
    @Req() request: { authUser?: { id: string } }
  ) {
    return ok(this.usersService.createUser(body, request.authUser?.id), "人员已新增。");
  }

  @Get()
  list(@Query("role") role?: UserRole) {
    return ok(this.usersService.list(role));
  }

  @Get(":userId")
  detail(@Param("userId") userId: string) {
    return ok(this.usersService.detail(userId));
  }

  @Patch(":userId")
  updateUser(
    @Param("userId") userId: string,
    @Body()
    body: {
      phone?: string;
      name?: string;
      status?: "active" | "inactive";
      neighborhood?: string;
      tags?: string[];
      quota?: {
        dailyLimit: number;
        categoryLimit: Record<string, number>;
      };
    },
    @Req() request: { authUser?: { id: string } }
  ) {
    return ok(this.usersService.updateUser(userId, body, request.authUser?.id), "人员信息已更新。");
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

  @Patch("batch")
  batchUpdate(
    @Body()
    body: {
      userIds: string[];
      patch: {
        status?: "active" | "inactive";
        tags?: string[];
        neighborhood?: string;
        quota?: {
          dailyLimit: number;
          categoryLimit: Record<string, number>;
        };
      };
    },
    @Req() request: { authUser?: { id: string } }
  ) {
    return ok(this.usersService.batchUpdate(body, request.authUser?.id), "批量人员属性已更新。");
  }

  @Post(":userId/manual-adjustment")
  manualAdjustment(
    @Param("userId") userId: string,
    @Body()
    body: {
      deviceCode: string;
      goodsId: string;
      goodsName?: string;
      category?: "food" | "drink" | "daily";
      quantity: number;
      unitPrice?: number;
      direction: "restock" | "deduct";
      note?: string;
    },
    @Req() request: { authUser?: { id: string } }
  ) {
    return ok(this.usersService.manualAdjustment(userId, body, request.authUser?.id), "手工库存调整已记录。");
  }
}
