import { Body, Controller, Get, Inject, Param, Patch, Post, Query, Req, UseGuards } from "@nestjs/common";

import type { AlertTask } from "@vm/shared-types";

import { ok } from "../../common/dto/api-response";
import { AllowedRoles } from "../../common/guards/allowed-roles.decorator";
import { RoleGuard } from "../../common/guards/role.guard";
import { AlertsService } from "./alerts.service";

@Controller("alerts")
export class AlertsController {
  constructor(@Inject(AlertsService) private readonly alertsService: AlertsService) {}

  @Get()
  @UseGuards(RoleGuard)
  @AllowedRoles("admin", "merchant")
  list(@Query("status") status?: AlertTask["status"]) {
    return ok(this.alertsService.list(status));
  }

  @Patch(":id/resolve")
  @UseGuards(RoleGuard)
  @AllowedRoles("admin")
  resolve(
    @Param("id") id: string,
    @Body() body: { note?: string },
    @Req() request: { authUser?: { id: string } }
  ) {
    return ok(this.alertsService.resolve(id, request.authUser?.id, body?.note), "操作成功");
  }

  @Post("feedback")
  createFeedback(
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
    return ok(
      this.alertsService.createFeedbackTask({
        ...body,
        targetUserId: body.targetUserId ?? request.authUser?.id
      }),
      "操作成功"
    );
  }
}
