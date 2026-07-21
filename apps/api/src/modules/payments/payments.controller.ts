import { Body, Controller, Get, Header, Headers, HttpCode, Inject, Param, Post, Req, UseGuards } from "@nestjs/common";

import type { PaymentOrderCreatePayload, PaymentPayerIdentityPayload, UserRole } from "@vm/shared-types";

import { ok } from "../../common/dto/api-response";
import {
  AllowedBackofficePermissions,
  AllowedBackofficeSessionPermissions,
  AllowedRoles
} from "../../common/guards/allowed-roles.decorator";
import { RoleGuard } from "../../common/guards/role.guard";
import { PaymentsService } from "./payments.service";

@Controller("payments")
export class PaymentsController {
  constructor(@Inject(PaymentsService) private readonly paymentsService: PaymentsService) {}

  @Get("diagnostics")
  @UseGuards(RoleGuard)
  @AllowedRoles("admin")
  @AllowedBackofficeSessionPermissions("system-settings:view")
  diagnostics() {
    return ok(this.paymentsService.getPaymentDiagnostics());
  }

  @Post("orders")
  @UseGuards(RoleGuard)
  @AllowedRoles("admin", "merchant", "special")
  async createOrder(
    @Body() body: PaymentOrderCreatePayload,
    @Req() request: { authUser?: { id: string; role: UserRole } }
  ) {
    return ok(await this.paymentsService.createOrder(body, request.authUser), "支付单已创建。");
  }

  @Post("payer-identity")
  @UseGuards(RoleGuard)
  @AllowedRoles("admin", "merchant", "special")
  async payerIdentity(
    @Body() body: PaymentPayerIdentityPayload,
    @Req() request: { authUser?: { id: string; role: UserRole } }
  ) {
    return ok(await this.paymentsService.resolvePayerIdentity(body, request.authUser));
  }

  @Get("orders/:id")
  @UseGuards(RoleGuard)
  @AllowedRoles("admin", "merchant", "special")
  detail(
    @Param("id") id: string,
    @Req() request: { authUser?: { id: string; role: UserRole } }
  ) {
    return ok(this.paymentsService.detail(id, request.authUser));
  }

  @Post("orders/:id/reconciliation-requests")
  @HttpCode(202)
  @UseGuards(RoleGuard)
  @AllowedRoles("special")
  requestOwnOrderReconciliation(
    @Param("id") id: string,
    @Req() request: { authUser?: { id: string; role: UserRole } }
  ) {
    return ok(
      this.paymentsService.requestOwnOrderReconciliation(id, request.authUser),
      "已请求后台安全核对原支付单。"
    );
  }

  @Post("orders/:id/reconcile")
  @HttpCode(200)
  @UseGuards(RoleGuard)
  @AllowedRoles("admin", "merchant")
  @AllowedBackofficePermissions("payments:refund")
  async reconcileOrder(
    @Param("id") id: string,
    @Req() request: { authUser?: { id: string; role: UserRole } }
  ) {
    return ok(
      await this.paymentsService.reconcileOrder(id, request.authUser),
      "支付状态已核对。"
    );
  }

  @Post("refunds/:id/reconcile")
  @HttpCode(200)
  @UseGuards(RoleGuard)
  @AllowedRoles("admin", "merchant")
  @AllowedBackofficePermissions("payments:refund")
  async reconcileRefund(
    @Param("id") id: string,
    @Req() request: { authUser?: { id: string; role: UserRole } }
  ) {
    return ok(
      await this.paymentsService.reconcileRefund(id, request.authUser),
      "退款状态已核对。"
    );
  }

  @Post("orders/:id/close")
  @HttpCode(200)
  @UseGuards(RoleGuard)
  @AllowedRoles("admin", "merchant")
  @AllowedBackofficePermissions("payments:refund")
  async closeUnpaidOrder(
    @Param("id") id: string,
    @Req() request: { authUser?: { id: string; role: UserRole } }
  ) {
    return ok(
      await this.paymentsService.closeUnpaidOrder(id, request.authUser),
      "未支付订单已安全关单。"
    );
  }

  @Post("orders/:id/mock-paid")
  @HttpCode(200)
  @UseGuards(RoleGuard)
  @AllowedRoles("admin", "merchant", "special")
  @AllowedBackofficeSessionPermissions("payments:refund")
  async mockPaid(
    @Param("id") id: string,
    @Req() request: { authUser?: { id: string; role: UserRole } }
  ) {
    return ok(await this.paymentsService.markMockPaid(id, request.authUser), "模拟支付成功。");
  }

  @Post("callbacks/wechat")
  @HttpCode(200)
  async wechatCallback(
    @Body() body: Record<string, unknown>,
    @Headers() headers: Record<string, string | undefined>,
    @Req() request: { rawBody?: string }
  ) {
    await this.paymentsService.handleWechatCallback(body, headers, request.rawBody);
    return {
      code: "SUCCESS",
      message: "成功"
    };
  }

  @Post("callbacks/alipay")
  @HttpCode(200)
  @Header("Content-Type", "text/plain;charset=utf-8")
  async alipayCallback(
    @Body() body: Record<string, unknown>,
    @Headers() headers: Record<string, string | undefined>
  ) {
    await this.paymentsService.handleAlipayCallback(body, headers);
    return "success";
  }

  @Post("callbacks/wechat-refund")
  @HttpCode(200)
  async wechatRefundCallback(
    @Body() body: Record<string, unknown>,
    @Headers() headers: Record<string, string | undefined>,
    @Req() request: { rawBody?: string }
  ) {
    await this.paymentsService.handleWechatRefundCallback(body, headers, request.rawBody);
    return {
      code: "SUCCESS",
      message: "成功"
    };
  }

  @Post("refunds")
  @UseGuards(RoleGuard)
  @AllowedRoles("admin", "merchant")
  @AllowedBackofficePermissions("payments:refund")
  async refund(
    @Body()
    body: {
      paymentOrderId: string;
      amount: number;
      reason?: string;
    },
    @Headers("idempotency-key") idempotencyKey: string | undefined,
    @Req() request: { authUser?: { id: string; role: UserRole } }
  ) {
    return ok(
      await this.paymentsService.refund(
        body,
        request.authUser,
        idempotencyKey
      ),
      "退款已处理。"
    );
  }
}
