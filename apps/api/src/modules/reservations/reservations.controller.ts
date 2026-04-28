import { Body, Controller, Get, HttpCode, Inject, Param, Patch, Post, Req, UseGuards } from "@nestjs/common";

import type { CabinetReservationCreatePayload, ReservationSettings, UserRole } from "@vm/shared-types";

import { ok } from "../../common/dto/api-response";
import { AllowedRoles } from "../../common/guards/allowed-roles.decorator";
import { RoleGuard } from "../../common/guards/role.guard";
import { ReservationsService } from "./reservations.service";

type AuthRequest = {
  authUser?: {
    id: string;
    role: UserRole;
  };
};

@Controller("reservations")
@UseGuards(RoleGuard)
export class ReservationsController {
  constructor(@Inject(ReservationsService) private readonly reservationsService: ReservationsService) {}

  @Get("settings")
  @AllowedRoles("admin", "merchant", "special")
  settings() {
    return ok(this.reservationsService.getSettings());
  }

  @Patch("settings")
  @AllowedRoles("admin")
  updateSettings(
    @Body() body: Partial<Pick<ReservationSettings, "enabled" | "holdMinutes" | "maxTimeouts">>,
    @Req() request: AuthRequest
  ) {
    return ok(this.reservationsService.updateSettings(body, request.authUser?.id));
  }

  @Get()
  @AllowedRoles("admin")
  list(@Req() request: AuthRequest) {
    return ok(this.reservationsService.list(request.authUser));
  }

  @Get("my")
  @AllowedRoles("special")
  mine(@Req() request: AuthRequest) {
    return ok(this.reservationsService.list(request.authUser));
  }

  @Post()
  @HttpCode(200)
  @AllowedRoles("special")
  create(@Body() body: CabinetReservationCreatePayload, @Req() request: Required<AuthRequest>) {
    return ok(this.reservationsService.create(body, request.authUser));
  }

  @Post(":id/cancel")
  @HttpCode(200)
  @AllowedRoles("admin", "special")
  cancel(@Param("id") id: string, @Req() request: Required<AuthRequest>) {
    return ok(this.reservationsService.cancel(id, request.authUser));
  }

  @Post("users/:userId/reset-timeouts")
  @HttpCode(200)
  @AllowedRoles("admin")
  resetTimeouts(@Param("userId") userId: string, @Req() request: AuthRequest) {
    return ok(this.reservationsService.resetUserTimeouts(userId, request.authUser?.id));
  }
}
