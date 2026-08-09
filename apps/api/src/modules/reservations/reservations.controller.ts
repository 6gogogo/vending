import { Body, Controller, Get, HttpCode, Inject, Param, Patch, Post, Query, Req, UseGuards } from "@nestjs/common";

import type { ReservationSettings, UserRole } from "@vm/shared-types";

import { ok } from "../../common/dto/api-response";
import { parseCabinetReservationCreatePayload } from "../../common/validation/cabinet-operation-input";
import {
  AllowedBackofficePermissions,
  AllowedBackofficeSessionPermissions,
  AllowedRoles,
  TenantScopedBackofficeRoute
} from "../../common/guards/allowed-roles.decorator";
import { RoleGuard } from "../../common/guards/role.guard";
import { ReservationsService } from "./reservations.service";

type AuthRequest = {
  authUser?: {
    id: string;
    role: UserRole;
    tenantId?: string;
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
  @AllowedBackofficePermissions("reservations:manage")
  updateSettings(
    @Body() body: Partial<Pick<ReservationSettings, "enabled" | "holdMinutes" | "maxTimeouts">>,
    @Req() request: AuthRequest
  ) {
    return ok(this.reservationsService.updateSettings(body, request.authUser?.id));
  }

  @Get()
  @AllowedRoles("admin")
  @AllowedBackofficePermissions("users:view")
  @TenantScopedBackofficeRoute()
  list(
    @Query("userId") userId: string | undefined,
    @Req() request: AuthRequest
  ) {
    return ok(this.reservationsService.list(request.authUser, userId?.trim() || undefined));
  }

  @Get("my")
  @AllowedRoles("special")
  mine(@Req() request: AuthRequest) {
    return ok(this.reservationsService.list(request.authUser));
  }

  @Post()
  @HttpCode(200)
  @AllowedRoles("special")
  create(@Body() body: unknown, @Req() request: Required<AuthRequest>) {
    return ok(
      this.reservationsService.create(
        parseCabinetReservationCreatePayload(body),
        request.authUser
      )
    );
  }

  @Post(":id/cancel")
  @HttpCode(200)
  @AllowedRoles("admin", "special")
  @AllowedBackofficeSessionPermissions("reservations:manage")
  @TenantScopedBackofficeRoute()
  cancel(
    @Param("id") id: string,
    @Body() body: { reason?: unknown },
    @Req() request: Required<AuthRequest>
  ) {
    return ok(this.reservationsService.cancel(id, request.authUser, body?.reason));
  }

  @Post("users/:userId/reset-timeouts")
  @HttpCode(200)
  @AllowedRoles("admin")
  @AllowedBackofficePermissions("reservations:manage")
  resetTimeouts(@Param("userId") userId: string, @Req() request: AuthRequest) {
    return ok(this.reservationsService.resetUserTimeouts(userId, request.authUser?.id));
  }
}
