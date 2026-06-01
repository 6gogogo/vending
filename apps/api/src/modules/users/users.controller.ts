import { Body, Controller, Delete, Get, Inject, Param, Patch, Post, Query, Req, UseGuards } from "@nestjs/common";

import type { BackofficeRole, UserRole } from "@vm/shared-types";

import { ok } from "../../common/dto/api-response";
import {
  AllowedBackofficePermissions,
  AllowedRoles
} from "../../common/guards/allowed-roles.decorator";
import { RoleGuard } from "../../common/guards/role.guard";
import { UsersService } from "./users.service";

@Controller("users")
@UseGuards(RoleGuard)
@AllowedRoles("admin")
@AllowedBackofficePermissions("users:view")
export class UsersController {
  constructor(@Inject(UsersService) private readonly usersService: UsersService) {}

  @Post()
  @AllowedBackofficePermissions("users:manage")
  createUser(
    @Body()
    body: {
      role: UserRole;
      phone: string;
      name: string;
      status?: "active" | "inactive";
      neighborhood?: string;
      regionId?: string;
      regionName?: string;
      tags?: string[];
      quota?: {
        dailyLimit: number;
        categoryLimit: Record<string, number>;
      };
    },
    @Req() request: { authUser?: { id: string } }
  ) {
    return ok(this.usersService.createUser(body, request.authUser?.id), "操作成功");
  }

  @Get()
  list(
    @Query("role") role: UserRole | undefined,
    @Req() request: { authUser?: { backofficeRole?: BackofficeRole } }
  ) {
    return ok(this.usersService.list(role, request.authUser?.backofficeRole));
  }

  @Get(":userId")
  detail(
    @Param("userId") userId: string,
    @Query("month") month: string | undefined,
    @Query("date") date: string | undefined,
    @Req() request: { authUser?: { backofficeRole?: BackofficeRole } }
  ) {
    return ok(
      this.usersService.detail(userId, {
        monthKey: month,
        dateKey: date
      }, request.authUser?.backofficeRole)
    );
  }

  @Patch(":userId")
  @AllowedBackofficePermissions("users:manage")
  updateUser(
    @Param("userId") userId: string,
    @Body()
    body: {
      role?: UserRole;
      phone?: string;
      name?: string;
      status?: "active" | "inactive";
      neighborhood?: string;
      regionId?: string;
      regionName?: string;
      tags?: string[];
      quota?: {
        dailyLimit: number;
        categoryLimit: Record<string, number>;
      };
    },
    @Req() request: { authUser?: { id: string; backofficeRole?: BackofficeRole } }
  ) {
    return ok(
      this.usersService.updateUser(userId, body, request.authUser?.id, request.authUser?.backofficeRole),
      "操作成功"
    );
  }

  @Delete(":userId")
  @AllowedBackofficePermissions("users:manage")
  removeUser(
    @Param("userId") userId: string,
    @Req() request: { authUser?: { id: string; backofficeRole?: BackofficeRole } }
  ) {
    return ok(
      this.usersService.removeUser(userId, request.authUser?.id, request.authUser?.backofficeRole),
      "操作成功"
    );
  }

  @Post("import")
  @AllowedBackofficePermissions("users:manage")
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
  @AllowedBackofficePermissions("users:manage")
  batchUpdate(
    @Body()
    body: {
      userIds: string[];
      patch: {
        status?: "active" | "inactive";
        tags?: string[];
        neighborhood?: string;
        regionId?: string;
        regionName?: string;
        quota?: {
          dailyLimit: number;
          categoryLimit: Record<string, number>;
        };
      };
    },
    @Req() request: { authUser?: { id: string; backofficeRole?: BackofficeRole } }
  ) {
    return ok(
      this.usersService.batchUpdate(body, request.authUser?.id, request.authUser?.backofficeRole),
      "操作成功"
    );
  }

  @Post(":userId/manual-adjustment")
  @AllowedBackofficePermissions("goods:stock-adjust")
  manualAdjustment(
    @Param("userId") userId: string,
    @Body()
    body: {
      deviceCode: string;
      goodsId: string;
      relatedEventId?: string;
      relatedOrderNo?: string;
      goodsName?: string;
      category?: "food" | "drink" | "daily";
      quantity: number;
      unitPrice?: number;
      direction: "restock" | "deduct";
      note?: string;
      confirmed?: boolean;
      batchConsumptions?: Array<{
        batchId: string;
        quantity: number;
      }>;
    },
    @Req() request: { authUser?: { id: string; backofficeRole?: BackofficeRole } }
  ) {
    return ok(
      this.usersService.manualAdjustment(userId, body, request.authUser?.id, request.authUser?.backofficeRole),
      "操作成功"
    );
  }

  @Post(":userId/access-policies")
  @AllowedBackofficePermissions("users:rules:manage")
  saveAccessPolicy(
    @Param("userId") userId: string,
    @Body()
    body: {
      id?: string;
      name: string;
      weekdays: number[];
      startHour: number;
      endHour: number;
      goodsLimits: Array<{
        goodsId: string;
        quantity: number;
      }>;
      status: "active" | "inactive";
      sourcePolicyId?: string;
    },
    @Req() request: { authUser?: { id: string; backofficeRole?: BackofficeRole } }
  ) {
    return ok(
      this.usersService.saveAccessPolicy(userId, body, request.authUser?.id, request.authUser?.backofficeRole),
      "操作成功"
    );
  }

  @Delete(":userId/access-policies/:policyId")
  @AllowedBackofficePermissions("users:rules:manage")
  deleteAccessPolicy(
    @Param("userId") userId: string,
    @Param("policyId") policyId: string,
    @Req() request: { authUser?: { id: string; backofficeRole?: BackofficeRole } }
  ) {
    return ok(
      this.usersService.deleteAccessPolicy(
        userId,
        policyId,
        request.authUser?.id,
        request.authUser?.backofficeRole
      ),
      "操作成功"
    );
  }

  @Post(":userId/access-policies/:policyId/apply-now")
  @AllowedBackofficePermissions("users:rules:manage")
  applyAccessPolicyNow(
    @Param("userId") userId: string,
    @Param("policyId") policyId: string,
    @Req() request: { authUser?: { id: string; backofficeRole?: BackofficeRole } }
  ) {
    return ok(
      this.usersService.applyAccessPolicyNow(
        userId,
        policyId,
        request.authUser?.id,
        request.authUser?.backofficeRole
      ),
      "操作成功"
    );
  }
}
