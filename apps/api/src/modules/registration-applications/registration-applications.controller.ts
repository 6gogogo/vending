import { Body, Controller, Get, Inject, Param, Patch, Post, Query, Req, UseGuards } from "@nestjs/common";

import type { RegistrationStatus } from "@vm/shared-types";

import { ok } from "../../common/dto/api-response";
import {
  AllowedBackofficePermissions,
  AllowedBackofficeSessionPermissions,
  AllowedRoles,
  TenantScopedBackofficeRoute
} from "../../common/guards/allowed-roles.decorator";
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
  @AllowedBackofficeSessionPermissions("users:view")
  @TenantScopedBackofficeRoute()
  list(
    @Query("status") status: RegistrationStatus | undefined,
    @Req() request?: { authUser?: { tenantId?: string } }
  ) {
    return ok(
      this.registrationApplicationsService.list(
        status,
        request?.authUser?.tenantId
      )
    );
  }

  @Get("by-phone")
  async byPhone(
    @Query("phone") phone: string,
    @Query("code") code?: string,
    @Req() request?: { ip?: string; hostname?: string }
  ) {
    const tenantId =
      this.registrationApplicationsService.resolvePublicTenantId(
        request?.hostname
      );
    return ok(
      await this.registrationApplicationsService.lookupByPhone(
        phone,
        code,
        request?.ip ?? "anonymous",
        tenantId
      )
    );
  }

  @Get(":id")
  @UseGuards(RoleGuard)
  @AllowedRoles("admin")
  @AllowedBackofficePermissions("users:view")
  @TenantScopedBackofficeRoute()
  detail(
    @Param("id") id: string,
    @Req() request: { authUser?: { tenantId?: string } }
  ) {
    return ok(
      this.registrationApplicationsService.detail(
        id,
        request.authUser?.tenantId
      )
    );
  }

  @Post()
  async createOrUpdate(
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
    },
    @Req() request?: { hostname?: string }
  ) {
    const tenantId =
      this.registrationApplicationsService.resolvePublicTenantId(
        request?.hostname
      );
    return ok(
      await this.registrationApplicationsService.createOrUpdateByPhone(
        body,
        tenantId
      ),
      "操作成功"
    );
  }

  @Patch(":id")
  async updatePending(
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
    },
    @Req() request?: { hostname?: string }
  ) {
    const tenantId =
      this.registrationApplicationsService.resolvePublicTenantId(
        request?.hostname
      );
    return ok(
      await this.registrationApplicationsService.updatePendingApplication(
        id,
        body,
        tenantId
      ),
      "操作成功"
    );
  }

  @Patch(":id/review")
  @UseGuards(RoleGuard)
  @AllowedRoles("admin")
  @AllowedBackofficeSessionPermissions("users:review")
  @TenantScopedBackofficeRoute()
  review(
    @Param("id") id: string,
    @Body()
    body: {
      decision: "approved" | "rejected";
      reason?: string;
    },
    @Req() request: { authUser?: { id: string; tenantId?: string } }
  ) {
    return ok(
      this.registrationApplicationsService.review(
        id,
        body,
        request.authUser?.id,
        request.authUser?.tenantId
      ),
      "操作成功"
    );
  }
}
