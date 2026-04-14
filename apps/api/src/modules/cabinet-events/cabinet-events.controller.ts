import { Body, Controller, Get, Inject, Post, Query, Req, UseGuards } from "@nestjs/common";

import type {
  CabinetOpenRequest,
  SmartVmAdjustmentPayload,
  SmartVmDoorStatusPayload,
  SmartVmPaymentPayload,
  SmartVmSettlementPayload
} from "@vm/shared-types";

import { ok } from "../../common/dto/api-response";
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
  async open(@Body() body: CabinetOpenRequest) {
    return ok(await this.cabinetEventsService.openCabinet(body));
  }

  @Post("callbacks/door-status")
  doorStatus(@Body() body: SmartVmDoorStatusPayload & Record<string, unknown>) {
    return ok(this.cabinetEventsService.handleDoorStatus(body), "门状态回调已处理。");
  }

  @Post("callbacks/settlement")
  settlement(@Body() body: SmartVmSettlementPayload & Record<string, unknown>) {
    return ok(this.cabinetEventsService.handleSettlement(body), "结算回调已处理。");
  }

  @Post("callbacks/adjustment")
  adjustment(@Body() body: SmartVmAdjustmentPayload & Record<string, unknown>) {
    return this.cabinetEventsService.handleAdjustment(body);
  }

  @Post("callbacks/payment-success")
  async paymentSuccess(@Body() body: SmartVmPaymentPayload & Record<string, unknown>) {
    return ok(await this.cabinetEventsService.handlePaymentSuccess(body), "支付回调已处理。");
  }

  @Post("payment-success")
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
}
