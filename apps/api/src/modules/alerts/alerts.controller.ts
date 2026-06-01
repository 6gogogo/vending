import { Body, Controller, Get, Headers, Inject, Param, Patch, Post, Query, Req, UseGuards } from "@nestjs/common";

import type { AlertTask } from "@vm/shared-types";

import { ok } from "../../common/dto/api-response";
import {
  AllowedBackofficeSessionPermissions,
  AllowedRoles
} from "../../common/guards/allowed-roles.decorator";
import { RoleGuard } from "../../common/guards/role.guard";
import { InMemoryStoreService } from "../../common/store/in-memory-store.service";
import { AlertsService } from "./alerts.service";

@Controller("alerts")
export class AlertsController {
  constructor(
    @Inject(AlertsService) private readonly alertsService: AlertsService,
    @Inject(InMemoryStoreService) private readonly store: InMemoryStoreService
  ) {}

  @Get()
  @UseGuards(RoleGuard)
  @AllowedRoles("admin", "merchant", "special")
  @AllowedBackofficeSessionPermissions("alerts:manage")
  list(
    @Query("status") status?: AlertTask["status"],
    @Query("targetUserId") targetUserId?: string,
    @Req() request?: { authUser?: { id: string; role: "admin" | "merchant" | "special" } }
  ) {
    const actor = request?.authUser;
    const resolvedTargetUserId =
      actor?.role === "special" || actor?.role === "merchant" ? actor.id : targetUserId;
    return ok(this.alertsService.list(status, resolvedTargetUserId));
  }

  @Patch(":id/resolve")
  @UseGuards(RoleGuard)
  @AllowedRoles("admin")
  @AllowedBackofficeSessionPermissions("alerts:manage")
  resolve(
    @Param("id") id: string,
    @Body() body: { note?: string },
    @Req() request: { authUser?: { id: string } }
  ) {
    return ok(this.alertsService.resolve(id, request.authUser?.id, body?.note), "操作成功");
  }

  @Post("feedback")
  createFeedback(
    @Headers("authorization") authorization: string | undefined,
    @Body()
    body: {
      title?: string;
      detail: string;
      deviceCode?: string;
      targetUserId?: string;
      feedbackType?: "机器故障" | "服务问题" | "其他";
    },
    @Req() request: { authUser?: { id: string } }
  ) {
    const token = authorization?.startsWith("Bearer ")
      ? authorization.slice("Bearer ".length)
      : undefined;
    const sessionUser = this.store.getSessionUser(token);

    return ok(
      this.alertsService.createFeedbackTask({
        ...body,
        targetUserId: sessionUser?.id ?? request.authUser?.id
      }),
      "操作成功"
    );
  }
}
