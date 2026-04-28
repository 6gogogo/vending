import { Body, Controller, Get, HttpCode, Inject, Param, Post, Query, Req, UseGuards } from "@nestjs/common";

import type {
  CabinetOpenRequest,
  SmartVmAdjustmentPayload,
  SmartVmDoorStatusPayload,
  SmartVmPaymentPayload,
  SmartVmSettlementPayload
} from "@vm/shared-types";

import { ack, ok } from "../../common/dto/api-response";
import { AllowedRoles } from "../../common/guards/allowed-roles.decorator";
import { RoleGuard } from "../../common/guards/role.guard";
import { CabinetEventsService } from "./cabinet-events.service";

@Controller("cabinet-events")
export class CabinetEventsController {
  constructor(@Inject(CabinetEventsService) private readonly cabinetEventsService: CabinetEventsService) {}

  @Get()
  list(@Query("userId") userId?: string) {
    return ok(this.cabinetEventsService.list(userId));
  }

  @Get("event/:eventId")
  @UseGuards(RoleGuard)
  @AllowedRoles("admin", "merchant", "special")
  detail(
    @Param("eventId") eventId: string,
    @Req() request: { authUser?: { id: string; role: "admin" | "merchant" | "special" } }
  ) {
    return ok(this.cabinetEventsService.getDetail(eventId, request.authUser));
  }

  @Get("callback-logs")
  @UseGuards(RoleGuard)
  @AllowedRoles("admin")
  callbackLogs(
    @Query("limit") limit?: string,
    @Query("deviceCode") deviceCode?: string
  ) {
    const resolvedLimit = Number(limit ?? 20);
    return ok(
      this.cabinetEventsService.listCallbackLogs(
        Number.isNaN(resolvedLimit) ? 20 : resolvedLimit,
        deviceCode
      )
    );
  }

  @Post("open")
  @HttpCode(200)
  async open(@Body() body: CabinetOpenRequest) {
    return ok(await this.cabinetEventsService.openCabinet(body));
  }

  @Post("open/pre-settlement")
  @HttpCode(200)
  preSettlement(@Body() body: CabinetOpenRequest) {
    return ok(this.cabinetEventsService.previewOpenSettlement(body));
  }

  @Post("callbacks/door-status")
  @HttpCode(200)
  doorStatus(@Body() body: SmartVmDoorStatusPayload & Record<string, unknown>) {
    this.cabinetEventsService.handleDoorStatus(body);
    return ack();
  }

  @Post("callbacks/settlement")
  @HttpCode(200)
  settlement(@Body() body: SmartVmSettlementPayload & Record<string, unknown>) {
    this.cabinetEventsService.handleSettlement(body);
    return ack();
  }

  @Post("callbacks/adjustment")
  @HttpCode(200)
  adjustment(@Body() body: SmartVmAdjustmentPayload & Record<string, unknown>) {
    this.cabinetEventsService.handleAdjustment(body);
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

  @Post("event/:eventId/billing-confirmation")
  @HttpCode(200)
  @UseGuards(RoleGuard)
  @AllowedRoles("admin")
  confirmBilling(
    @Param("eventId") eventId: string,
    @Body() body: { note?: string },
    @Req() request: { authUser?: { id: string } }
  ) {
    return ok(
      this.cabinetEventsService.confirmBillingResolution(eventId, request.authUser?.id, body),
      "操作成功"
    );
  }
}
