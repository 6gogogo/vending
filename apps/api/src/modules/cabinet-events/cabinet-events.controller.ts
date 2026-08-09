import { Body, Controller, Get, HttpCode, Inject, Param, Post, Query, Req, UseGuards } from "@nestjs/common";

import type {
  SmartVmAdjustmentPayload,
  SmartVmDoorStatusPayload,
  SmartVmPaymentPayload,
  SmartVmSettlementPayload,
  ManualSettlementCreatePayload,
  ManualSettlementConflictResolutionPayload,
  ManualSettlementOrderLinkPayload,
  ManualSettlementRevertPayload,
  UserRole
} from "@vm/shared-types";

import { ack, ok } from "../../common/dto/api-response";
import { parseCabinetOpenRequest } from "../../common/validation/cabinet-operation-input";
import {
  AllowedBackofficeAllPermissions,
  AllowedBackofficePermissions,
  AllowedBackofficeSessionPermissions,
  AllowedRoles,
  TenantScopedBackofficeRoute
} from "../../common/guards/allowed-roles.decorator";
import { RoleGuard } from "../../common/guards/role.guard";
import { CabinetEventsService } from "./cabinet-events.service";
import { ManualSettlementRecoveryService } from "./manual-settlement-recovery.service";

@Controller("cabinet-events")
export class CabinetEventsController {
  constructor(
    @Inject(CabinetEventsService) private readonly cabinetEventsService: CabinetEventsService,
    @Inject(ManualSettlementRecoveryService)
    private readonly manualSettlementRecoveryService: ManualSettlementRecoveryService
  ) {}

  @Get("manual-settlement-candidates")
  @UseGuards(RoleGuard)
  @AllowedRoles("admin")
  @AllowedBackofficeAllPermissions("devices:operate", "goods:stock-adjust")
  @TenantScopedBackofficeRoute()
  manualSettlementCandidates(
    @Query("userId") userId?: string,
    @Req() request?: { authUser?: { tenantId?: string } }
  ) {
    return ok(
      this.manualSettlementRecoveryService.listCandidates(
        userId,
        request?.authUser?.tenantId
      )
    );
  }

  @Post("event/:eventId/manual-settlement")
  @HttpCode(200)
  @UseGuards(RoleGuard)
  @AllowedRoles("admin")
  @AllowedBackofficeAllPermissions("devices:operate", "goods:stock-adjust")
  @TenantScopedBackofficeRoute()
  createManualSettlement(
    @Param("eventId") eventId: string,
    @Body() body: ManualSettlementCreatePayload,
    @Req() request: { authUser?: { id?: string; tenantId?: string } }
  ) {
    return ok(
      this.manualSettlementRecoveryService.create(eventId, body, request.authUser),
      "人工结算补记已完成。"
    );
  }

  @Post("event/:eventId/manual-settlement/order-link")
  @HttpCode(200)
  @UseGuards(RoleGuard)
  @AllowedRoles("admin")
  @AllowedBackofficeAllPermissions("devices:operate", "goods:stock-adjust")
  @TenantScopedBackofficeRoute()
  linkManualSettlementOrder(
    @Param("eventId") eventId: string,
    @Body() body: ManualSettlementOrderLinkPayload,
    @Req() request: { authUser?: { id?: string; tenantId?: string } }
  ) {
    return ok(
      this.manualSettlementRecoveryService.linkOrder(eventId, body, request.authUser),
      "平台订单号已关联。"
    );
  }

  @Post("event/:eventId/manual-settlement/revert")
  @HttpCode(200)
  @UseGuards(RoleGuard)
  @AllowedRoles("admin")
  @AllowedBackofficeAllPermissions("devices:operate", "goods:stock-adjust")
  @TenantScopedBackofficeRoute()
  revertManualSettlement(
    @Param("eventId") eventId: string,
    @Body() body: ManualSettlementRevertPayload,
    @Req() request: { authUser?: { id?: string; tenantId?: string } }
  ) {
    return ok(
      this.manualSettlementRecoveryService.revert(eventId, body, request.authUser),
      "人工结算补记已撤销，原批次库存和领取额度已恢复。"
    );
  }

  @Post("event/:eventId/manual-settlement/conflict-resolution")
  @HttpCode(200)
  @UseGuards(RoleGuard)
  @AllowedRoles("admin")
  @AllowedBackofficeAllPermissions("devices:operate", "goods:stock-adjust")
  @TenantScopedBackofficeRoute()
  resolveManualSettlementConflict(
    @Param("eventId") eventId: string,
    @Body() body: ManualSettlementConflictResolutionPayload,
    @Req() request: { authUser?: { id?: string; tenantId?: string } }
  ) {
    return ok(
      this.manualSettlementRecoveryService.resolveConflict(
        eventId,
        body,
        request.authUser
      ),
      "人工结算补记明细冲突已核对。"
    );
  }

  @Post("event/:eventId/manual-settlement/platform-completion")
  @HttpCode(200)
  @UseGuards(RoleGuard)
  @AllowedRoles("admin")
  @AllowedBackofficeAllPermissions("devices:operate", "goods:stock-adjust")
  @TenantScopedBackofficeRoute()
  async completeManualSettlementPlatform(
    @Param("eventId") eventId: string,
    @Req() request: { authUser?: { id?: string; tenantId?: string } }
  ) {
    this.manualSettlementRecoveryService.getPlatformCompletionRecord(
      eventId,
      request.authUser
    );
    const platformCompletion = await this.cabinetEventsService.retryZeroCostPlatformCompletion(
      eventId,
      request.authUser?.id,
      request.authUser?.tenantId,
      true
    );
    return ok(
      {
        manualSettlement: this.manualSettlementRecoveryService.getPlatformCompletionRecord(
          eventId,
          request.authUser
        ),
        platformCompletion
      },
      "平台完成回写已成功。"
    );
  }

  @Get()
  @UseGuards(RoleGuard)
  @AllowedRoles("admin", "merchant", "restocker", "special")
  @AllowedBackofficeSessionPermissions("operation-logs:view")
  @TenantScopedBackofficeRoute()
  list(
    @Query("userId") userId?: string,
    @Req()
    request?: {
      authUser?: { id: string; role: UserRole; tenantId?: string };
    }
  ) {
    return ok(this.cabinetEventsService.list(userId, request?.authUser));
  }

  @Get("event/:eventId")
  @UseGuards(RoleGuard)
  @AllowedRoles("admin", "merchant", "restocker", "special")
  @AllowedBackofficeSessionPermissions("operation-logs:view")
  @TenantScopedBackofficeRoute()
  detail(
    @Param("eventId") eventId: string,
    @Req()
    request: {
      authUser?: { id: string; role: UserRole; tenantId?: string };
    }
  ) {
    return ok(this.cabinetEventsService.getDetail(eventId, request.authUser));
  }

  @Get("callback-logs")
  @UseGuards(RoleGuard)
  @AllowedRoles("admin")
  @AllowedBackofficePermissions("operation-logs:view")
  @TenantScopedBackofficeRoute()
  callbackLogs(
    @Query("limit") limit?: string,
    @Query("deviceCode") deviceCode?: string,
    @Req() request?: { authUser?: { tenantId?: string } }
  ) {
    const resolvedLimit = Number(limit ?? 20);
    return ok(
      this.cabinetEventsService.listCallbackLogs(
        Number.isNaN(resolvedLimit) ? 20 : resolvedLimit,
        deviceCode,
        request?.authUser?.tenantId
      )
    );
  }

  @Post("open")
  @HttpCode(200)
  @UseGuards(RoleGuard)
  @AllowedRoles("admin", "merchant", "restocker", "special")
  @AllowedBackofficeSessionPermissions("devices:operate")
  @TenantScopedBackofficeRoute()
  async open(
    @Body() body: unknown,
    @Req() request: {
      authUser?: { id: string; role: UserRole; tenantId?: string };
    }
  ) {
    return ok(
      await this.cabinetEventsService.openCabinet(
        parseCabinetOpenRequest(body),
        request.authUser
      )
    );
  }

  @Post("open/pre-settlement")
  @HttpCode(200)
  @UseGuards(RoleGuard)
  @AllowedRoles("admin", "merchant", "restocker", "special")
  @AllowedBackofficeSessionPermissions("devices:operate")
  @TenantScopedBackofficeRoute()
  preSettlement(
    @Body() body: unknown,
    @Req() request: {
      authUser?: { id: string; role: UserRole; tenantId?: string };
    }
  ) {
    return ok(
      this.cabinetEventsService.previewOpenSettlement(
        parseCabinetOpenRequest(body),
        request.authUser
      )
    );
  }

  @Post("callbacks/door-status")
  @HttpCode(200)
  doorStatus(@Body() body: SmartVmDoorStatusPayload & Record<string, unknown>) {
    this.cabinetEventsService.handleDoorStatus(body);
    return ack();
  }

  @Post("callbacks/settlement")
  @HttpCode(200)
  async settlement(@Body() body: SmartVmSettlementPayload & Record<string, unknown>) {
    await this.cabinetEventsService.handleSettlement(body);
    return ack();
  }

  @Post("callbacks/adjustment")
  @HttpCode(200)
  async adjustment(@Body() body: SmartVmAdjustmentPayload & Record<string, unknown>) {
    await this.cabinetEventsService.handleAdjustment(body);
    return ack();
  }

  @Post("callbacks/payment-success")
  @HttpCode(200)
  async paymentSuccess(@Body() body: SmartVmPaymentPayload & Record<string, unknown>) {
    await this.cabinetEventsService.handlePaymentSuccess(body);
    return ack();
  }

  @Post("payment-success")
  @HttpCode(200)
  @UseGuards(RoleGuard)
  @AllowedRoles("admin")
  @AllowedBackofficeAllPermissions("devices:operate", "payments:refund")
  async notifyPaymentSuccess(
    @Body()
    body: SmartVmPaymentPayload & {
      openId?: string;
    },
    @Req() request: { authUser?: { id: string } }
  ) {
    return ok(
      await this.cabinetEventsService.notifyPaymentSuccess(body, request?.authUser?.id),
      "操作成功"
    );
  }

  @Post("event/:eventId/platform-completion-retry")
  @HttpCode(200)
  @UseGuards(RoleGuard)
  @AllowedRoles("admin")
  @AllowedBackofficePermissions("devices:operate")
  async retryPlatformCompletion(
    @Param("eventId") eventId: string,
    @Req() request: { authUser?: { id: string } }
  ) {
    return ok(
      await this.cabinetEventsService.retryZeroCostPlatformCompletion(
        eventId,
        request.authUser?.id
      ),
      "操作成功"
    );
  }

  @Post("event/:eventId/billing-confirmation")
  @HttpCode(200)
  @UseGuards(RoleGuard)
  @AllowedRoles("admin")
  @AllowedBackofficePermissions("devices:operate")
  async confirmBilling(
    @Param("eventId") eventId: string,
    @Body() body: { note?: string },
    @Req() request: { authUser?: { id: string } }
  ) {
    return ok(
      await this.cabinetEventsService.confirmBillingResolution(
        eventId,
        request.authUser?.id,
        body
      ),
      "操作成功"
    );
  }
}
