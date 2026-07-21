import {
  BadRequestException,
  Body,
  Controller,
  HttpCode,
  Inject,
  Post,
  Req,
  UseGuards
} from "@nestjs/common";

import type { SmartVmRefundPayload, UserRole } from "@vm/shared-types";

import { ack, ok } from "../../common/dto/api-response";
import {
  AllowedBackofficePermissions,
  AllowedRoles
} from "../../common/guards/allowed-roles.decorator";
import { RoleGuard } from "../../common/guards/role.guard";
import { SmartVmGateway } from "../devices/smartvm.gateway";
import { PaymentsService } from "./payments.service";

@Controller("inventory-orders")
export class LegacyRefundController {
  constructor(
    @Inject(PaymentsService) private readonly paymentsService: PaymentsService,
    @Inject(SmartVmGateway) private readonly smartVmGateway: SmartVmGateway
  ) {}

  @Post("callbacks/refund")
  @HttpCode(200)
  async refundCallback(@Body() body: SmartVmRefundPayload & Record<string, unknown>) {
    if (!this.smartVmGateway.verifySignedPayload(body)) {
      throw new BadRequestException("签名校验失败。");
    }

    await this.paymentsService.refundFromSmartVm({
      orderNo: body.orderNo,
      transactionId: body.transactionId,
      refundNo: body.refundNo,
      deviceCode: body.deviceCode,
      amount: Number(body.amount)
    });
    return ack();
  }

  @Post("refund")
  @HttpCode(200)
  @UseGuards(RoleGuard)
  @AllowedRoles("admin")
  @AllowedBackofficePermissions("payments:refund")
  async refund(
    @Body() body: {
      orderNo: string;
      transactionId: string;
      deviceCode: string;
      refundNo: string;
      amount: number;
      reason?: string;
    },
    @Req() request: { authUser?: { id: string; role: UserRole } }
  ) {
    return ok(
      await this.paymentsService.refundByBusinessOrder(body, request.authUser),
      "退款请求已进入统一支付退款账本。"
    );
  }
}
