import { Body, Controller, Delete, Get, Inject, Param, Patch, Post, Query, Req, UseGuards } from "@nestjs/common";

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
  list(@Query("role") role?: UserRole) {
    return ok(this.usersService.list(role));
  }

  @Get(":userId")
  detail(
    @Param("userId") userId: string,
    @Query("month") month?: string,
    @Query("date") date?: string
  ) {
    return ok(
      this.usersService.detail(userId, {
        monthKey: month,
        dateKey: date
      })
    );
  }

  @Patch(":userId")
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
    @Req() request: { authUser?: { id: string } }
  ) {
    return ok(this.usersService.updateUser(userId, body, request.authUser?.id), "操作成功");
  }

  @Delete(":userId")
  removeUser(
    @Param("userId") userId: string,
    @Req() request: { authUser?: { id: string } }
  ) {
    return ok(this.usersService.removeUser(userId, request.authUser?.id), "操作成功");
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
        regionId?: string;
        regionName?: string;
        quota?: {
          dailyLimit: number;
          categoryLimit: Record<string, number>;
        };
      };
    },
    @Req() request: { authUser?: { id: string } }
  ) {
    return ok(this.usersService.batchUpdate(body, request.authUser?.id), "操作成功");
  }

  @Post(":userId/manual-adjustment")
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
    },
    @Req() request: { authUser?: { id: string } }
  ) {
    return ok(this.usersService.manualAdjustment(userId, body, request.authUser?.id), "操作成功");
  }

  @Post(":userId/access-policies")
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
    @Req() request: { authUser?: { id: string } }
  ) {
    return ok(this.usersService.saveAccessPolicy(userId, body, request.authUser?.id), "操作成功");
  }

  @Delete(":userId/access-policies/:policyId")
  deleteAccessPolicy(
    @Param("userId") userId: string,
    @Param("policyId") policyId: string,
    @Req() request: { authUser?: { id: string } }
  ) {
    return ok(this.usersService.deleteAccessPolicy(userId, policyId, request.authUser?.id), "操作成功");
  }

  @Post(":userId/access-policies/:policyId/apply-now")
  applyAccessPolicyNow(
    @Param("userId") userId: string,
    @Param("policyId") policyId: string,
    @Req() request: { authUser?: { id: string } }
  ) {
    return ok(this.usersService.applyAccessPolicyNow(userId, policyId, request.authUser?.id), "操作成功");
  }
}
