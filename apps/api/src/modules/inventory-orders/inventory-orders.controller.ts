import { BadRequestException, Body, Controller, Get, HttpCode, Inject, Post, Query, Req, UseGuards } from "@nestjs/common";

import type { SmartVmRefundPayload } from "@vm/shared-types";

import { ack, ok } from "../../common/dto/api-response";
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
  @UseGuards(RoleGuard)
  @AllowedRoles("admin", "merchant", "special")
  list(
    @Query("userId") userId?: string,
    @Query("role") role?: "special" | "merchant" | "admin",
    @Req() request?: { authUser?: { id: string; role: "admin" | "merchant" | "special" } }
  ) {
    const actor = request?.authUser;
    const resolvedUserId = actor && actor.role !== "admin" ? actor.id : userId;
    const resolvedRole = actor && actor.role !== "admin" ? actor.role : role;
    return ok(this.inventoryOrdersService.list(resolvedUserId, resolvedRole));
  }

  @Get("merchant-summary")
  @UseGuards(RoleGuard)
  @AllowedRoles("merchant", "admin")
  merchantSummary(
    @Query("userId") userId: string,
    @Req() request?: { authUser?: { id: string; role: "admin" | "merchant" } }
  ) {
    const actor = request?.authUser;
    return ok(this.inventoryOrdersService.getMerchantSummary(actor?.role === "merchant" ? actor.id : userId));
  }

  @Post("callbacks/refund")
  @HttpCode(200)
  refundCallback(@Body() body: SmartVmRefundPayload & Record<string, unknown>) {
    this.inventoryOrdersService.logRefundCallback(body);

    if (!this.smartVmGateway.verifySignedPayload(body)) {
      throw new BadRequestException("签名校验失败。");
    }

    this.inventoryOrdersService.handleRefundCallback(body);
    return ack();
  }

  @Post("refund")
  @HttpCode(200)
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
    return ok(
      this.inventoryOrdersService.markRefund(body.orderNo, body.transactionId, body.amount, {
        source: "manual",
        refundNo: body.refundNo
      })
    );
  }
}
