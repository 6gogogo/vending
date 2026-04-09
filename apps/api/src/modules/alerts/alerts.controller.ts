import { Body, Controller, Get, Inject, Param, Patch, Post, Query, Req, UseGuards } from "@nestjs/common";

import type { AlertTask } from "@vm/shared-types";

import { ok } from "../../common/dto/api-response";
import { AllowedRoles } from "../../common/guards/allowed-roles.decorator";
import { RoleGuard } from "../../common/guards/role.guard";
import { AlertsService } from "./alerts.service";

@Controller("alerts")
@UseGuards(RoleGuard)
@AllowedRoles("admin", "merchant")
export class AlertsController {
  constructor(@Inject(AlertsService) private readonly alertsService: AlertsService) {}

  @Get()
  list(@Query("status") status?: AlertTask["status"]) {
    return ok(this.alertsService.list(status));
  }

  @Patch(":id/resolve")
  @AllowedRoles("admin")
  resolve(
    @Param("id") id: string,
    @Body() body: { note?: string },
    @Req() request: { authUser?: { id: string } }
  ) {
    return ok(this.alertsService.resolve(id, request.authUser?.id, body?.note));
  }

  @Post("feedback")
  @AllowedRoles("special", "merchant", "admin")
  createFeedback(
    @Body()
    body: {
      title: string;
      detail: string;
      deviceCode?: string;
      targetUserId?: string;
    }
  ) {
    return ok(this.alertsService.createFeedbackTask(body), "反馈任务已提交。");
  }
}
