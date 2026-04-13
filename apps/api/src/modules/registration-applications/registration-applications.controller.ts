import { Body, Controller, Get, Inject, Param, Patch, Post, Query, Req, UseGuards } from "@nestjs/common";

import type { RegistrationStatus } from "@vm/shared-types";

import { ok } from "../../common/dto/api-response";
import { AllowedRoles } from "../../common/guards/allowed-roles.decorator";
import { RoleGuard } from "../../common/guards/role.guard";
import { RegistrationApplicationsService } from "./registration-applications.service";

@Controller("registration-applications")
export class RegistrationApplicationsController {
  constructor(
    @Inject(RegistrationApplicationsService)
    private readonly registrationApplicationsService: RegistrationApplicationsService
  ) {}

  @Get()
  @UseGuards(RoleGuard)
  @AllowedRoles("admin")
  list(@Query("status") status?: RegistrationStatus) {
    return ok(this.registrationApplicationsService.list(status));
  }

  @Get("by-phone")
  byPhone(@Query("phone") phone: string) {
    return ok(this.registrationApplicationsService.lookupByPhone(phone));
  }

  @Get(":id")
  @UseGuards(RoleGuard)
  @AllowedRoles("admin")
  detail(@Param("id") id: string) {
    return ok(this.registrationApplicationsService.detail(id));
  }

  @Post()
  createOrUpdate(
    @Body()
    body: {
      phone: string;
      code: string;
      requestedRole?: "admin" | "merchant" | "special";
      profile: {
        name: string;
        neighborhood?: string;
        regionId?: string;
        regionName?: string;
        note?: string;
        merchantName?: string;
        contactName?: string;
        address?: string;
        organization?: string;
        title?: string;
      };
    }
  ) {
    return ok(
      this.registrationApplicationsService.createOrUpdateByPhone(body),
      "操作成功"
    );
  }

  @Patch(":id")
  updatePending(
    @Param("id") id: string,
    @Body()
    body: {
      phone: string;
      code: string;
      requestedRole?: "admin" | "merchant" | "special";
      profile: {
        name: string;
        neighborhood?: string;
        regionId?: string;
        regionName?: string;
        note?: string;
        merchantName?: string;
        contactName?: string;
        address?: string;
        organization?: string;
        title?: string;
      };
    }
  ) {
    return ok(
      this.registrationApplicationsService.updatePendingApplication(id, body),
      "操作成功"
    );
  }

  @Patch(":id/review")
  @UseGuards(RoleGuard)
  @AllowedRoles("admin")
  review(
    @Param("id") id: string,
    @Body()
    body: {
      decision: "approved" | "rejected";
      reason?: string;
    },
    @Req() request: { authUser?: { id: string } }
  ) {
    return ok(
      this.registrationApplicationsService.review(id, body, request.authUser?.id),
      "操作成功"
    );
  }
}
