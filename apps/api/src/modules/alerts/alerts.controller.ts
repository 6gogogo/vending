import { Controller, Get, Inject, Param, Patch, Query, UseGuards } from "@nestjs/common";

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
  resolve(@Param("id") id: string) {
    return ok(this.alertsService.resolve(id));
  }
}
