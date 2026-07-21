import { BadRequestException, Body, Controller, Delete, Get, Inject, Param, Patch, Post, Query, Req, UseGuards } from "@nestjs/common";

import type { BackofficeRole, UserRole } from "@vm/shared-types";

import { ok } from "../../common/dto/api-response";
import {
  AllowedBackofficePermissions,
  AllowedBackofficeSessionPermissions,
  AllowedRoles
} from "../../common/guards/allowed-roles.decorator";
import { RoleGuard } from "../../common/guards/role.guard";
import { UsersService } from "./users.service";

@Controller("users")
@UseGuards(RoleGuard)
@AllowedRoles("admin")
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
  @AllowedBackofficeSessionPermissions("users:view")
  list(
    @Query("role") role: UserRole | undefined,
    @Req() request: { authUser?: { backofficeRole?: BackofficeRole } }
  ) {
    return ok(this.usersService.list(role, request.authUser?.backofficeRole));
  }

  @Get(":userId")
  @AllowedBackofficeSessionPermissions("users:view")
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

  @Patch("batch")
  @AllowedBackofficeSessionPermissions("users:manage")
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
    this.assertRequestFields(body, ["userIds", "patch"], "批量更新");
    this.assertRequestFields(
      body.patch,
      ["status", "tags", "neighborhood", "regionId", "regionName", "quota"],
      "批量更新字段"
    );
    this.assertMobileRequestFields(body, ["userIds", "patch"], request.authUser?.backofficeRole);
    this.assertMobileRequestFields(body.patch, ["status"], request.authUser?.backofficeRole);
    return ok(
      this.usersService.batchUpdate(body, request.authUser?.id, request.authUser?.backofficeRole),
      "操作成功"
    );
  }

  @Patch(":userId")
  @AllowedBackofficeSessionPermissions("users:manage")
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
    this.assertRequestFields(
      body,
      ["role", "phone", "name", "status", "neighborhood", "regionId", "regionName", "tags", "quota"],
      "用户更新"
    );
    this.assertMobileRequestFields(
      body,
      ["phone", "name", "status", "neighborhood", "regionId", "regionName", "tags"],
      request.authUser?.backofficeRole
    );
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

  @Post(":userId/manual-adjustment")
  @AllowedBackofficeSessionPermissions("goods:stock-adjust")
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
    this.assertRequestFields(
      body,
      [
        "deviceCode",
        "goodsId",
        "relatedEventId",
        "relatedOrderNo",
        "goodsName",
        "category",
        "quantity",
        "unitPrice",
        "direction",
        "note",
        "confirmed",
        "batchConsumptions"
      ],
      "手工库存调整"
    );
    this.assertMobileRequestFields(
      body,
      ["deviceCode", "goodsId", "goodsName", "category", "quantity", "direction", "note", "confirmed"],
      request.authUser?.backofficeRole
    );
    return ok(
      this.usersService.manualAdjustment(
        userId,
        body,
        request.authUser?.id,
        request.authUser?.backofficeRole,
        request.authUser?.backofficeRole ? "backoffice" : "mobile"
      ),
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

  private assertMobileRequestFields(
    body: Record<string, unknown>,
    allowedFields: readonly string[],
    backofficeRole?: BackofficeRole
  ) {
    if (backofficeRole) {
      return;
    }

    const allowed = new Set(allowedFields);
    const unexpectedFields = Object.keys(body).filter((field) => !allowed.has(field));

    if (unexpectedFields.length) {
      throw new BadRequestException(`移动管理端不能提交字段：${unexpectedFields.join("、")}。`);
    }
  }

  private assertRequestFields(body: unknown, allowedFields: readonly string[], label: string) {
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      throw new BadRequestException(`${label}请求体必须是对象。`);
    }

    const allowed = new Set(allowedFields);
    const unexpectedFields = Object.keys(body).filter((field) => !allowed.has(field));

    if (unexpectedFields.length) {
      throw new BadRequestException(`${label}不能提交字段：${unexpectedFields.join("、")}。`);
    }
  }
}
