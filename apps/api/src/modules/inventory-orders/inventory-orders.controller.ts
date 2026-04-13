import { BadRequestException, Body, Controller, Get, Inject, Post, Query, UseGuards } from "@nestjs/common";

import type { SmartVmRefundPayload } from "@vm/shared-types";

import { ok } from "../../common/dto/api-response";
import { AllowedRoles } from "../../common/guards/allowed-roles.decorator";
import { RoleGuard } from "../../common/guards/role.guard";
import { SmartVmGateway } from "../devices/smartvm.gateway";
import { InventoryOrdersService } from "./inventory-orders.service";

@Controller("inventory-orders")
export class InventoryOrdersController {
  constructor(
    @Inject(InventoryOrdersService) private readonly inventoryOrdersService: InventoryOrdersService,
    @Inject(SmartVmGateway) private readonly smartVmGateway: SmartVmGateway
  ) {}

  @Get()
  list(
    @Query("userId") userId?: string,
    @Query("role") role?: "special" | "merchant" | "admin"
  ) {
    return ok(this.inventoryOrdersService.list(userId, role));
  }

  @Get("merchant-summary")
  @UseGuards(RoleGuard)
  @AllowedRoles("merchant", "admin")
  merchantSummary(@Query("userId") userId: string) {
    return ok(this.inventoryOrdersService.getMerchantSummary(userId));
  }

  @Post("callbacks/refund")
  refundCallback(@Body() body: SmartVmRefundPayload & Record<string, unknown>) {
    this.inventoryOrdersService.logRefundCallback(body);

    if (!this.smartVmGateway.verifySignedPayload(body)) {
      throw new BadRequestException("签名校验失败。");
    }

    return ok(this.inventoryOrdersService.handleRefundCallback(body), "退款回调已处理。");
  }

  @Post("refund")
  @UseGuards(RoleGuard)
  @AllowedRoles("admin")
  async refund(
    @Body()
    body: {
      orderNo: string;
      transactionId: string;
      deviceCode: string;
      refundNo: string;
      amount: number;
    }
  ) {
    await this.smartVmGateway.refund(body);
    return ok(this.inventoryOrdersService.markRefund(body.orderNo, body.transactionId, body.amount));
  }
}
