import { Body, Controller, Get, Inject, Param, Patch, Post, Req, UseGuards } from "@nestjs/common";

import type { GoodsCategory } from "@vm/shared-types";

import { ok } from "../../common/dto/api-response";
import {
  AllowedBackofficeSessionPermissions,
  AllowedRoles,
  TenantScopedBackofficeRoute
} from "../../common/guards/allowed-roles.decorator";
import { RoleGuard } from "../../common/guards/role.guard";
import { MerchantGoodsTemplatesService } from "./merchant-goods-templates.service";

@Controller()
@UseGuards(RoleGuard)
export class MerchantGoodsTemplatesController {
  constructor(
    @Inject(MerchantGoodsTemplatesService)
    private readonly merchantGoodsTemplatesService: MerchantGoodsTemplatesService
  ) {}

  @Get("merchant-goods-templates")
  @AllowedRoles("merchant", "restocker", "admin")
  @AllowedBackofficeSessionPermissions("merchant-workbench:view")
  @TenantScopedBackofficeRoute()
  list(
    @Req()
    request: {
      authUser?: {
        id: string;
        role: "admin" | "merchant" | "restocker";
        tenantId?: string;
      };
    }
  ) {
    return ok(this.merchantGoodsTemplatesService.list(request.authUser));
  }

  @Post("merchant-goods-templates")
  @AllowedRoles("merchant")
  @AllowedBackofficeSessionPermissions("merchant-workbench:manage")
  @TenantScopedBackofficeRoute()
  create(
    @Body()
    body: {
      goodsId?: string;
      goodsCode?: string;
      goodsName: string;
      fullName?: string;
      category: GoodsCategory;
      categoryName?: string;
      packageForm?: string;
      specification?: string;
      manufacturer?: string;
      defaultQuantity: number;
      defaultShelfLifeDays: number;
      imageUrl?: string;
    },
    @Req() request: { authUser?: { id: string; tenantId?: string } }
  ) {
    return ok(
      this.merchantGoodsTemplatesService.create(
        request.authUser?.id ?? "",
        body,
        request.authUser?.tenantId
      ),
      "操作成功"
    );
  }

  @Patch("merchant-goods-templates/:id")
  @AllowedRoles("merchant")
  @AllowedBackofficeSessionPermissions("merchant-workbench:manage")
  @TenantScopedBackofficeRoute()
  update(
    @Param("id") id: string,
    @Body()
    body: Partial<{
      goodsId: string;
      goodsCode: string;
      goodsName: string;
      fullName: string;
      category: GoodsCategory;
      categoryName: string;
      packageForm: string;
      specification: string;
      manufacturer: string;
      defaultQuantity: number;
      defaultShelfLifeDays: number;
      imageUrl?: string;
      status: "active" | "inactive";
    }>,
    @Req() request: { authUser?: { id: string; tenantId?: string } }
  ) {
    return ok(
      this.merchantGoodsTemplatesService.update(
        request.authUser?.id ?? "",
        id,
        body,
        request.authUser?.tenantId
      ),
      "操作成功"
    );
  }

  @Post("merchant-restocks")
  @AllowedRoles("merchant", "restocker", "admin")
  @AllowedBackofficeSessionPermissions("merchant-workbench:manage")
  @TenantScopedBackofficeRoute()
  createRestock(
    @Body()
    body: {
      templateId: string;
      deviceCode: string;
      quantity?: number;
      productionDate: string;
      note?: string;
      confirmed?: boolean;
      cabinetEventId?: string;
    },
    @Req() request: { authUser?: { id: string; tenantId?: string } }
  ) {
    return ok(
      this.merchantGoodsTemplatesService.createRestock(
        request.authUser?.id ?? "",
        body,
        request.authUser?.tenantId
      ),
      "操作成功"
    );
  }

  @Get("merchant-restock-traces")
  @AllowedRoles("merchant", "restocker")
  @AllowedBackofficeSessionPermissions("merchant-workbench:view")
  @TenantScopedBackofficeRoute()
  traces(
    @Req() request: { authUser?: { id: string; tenantId?: string } }
  ) {
    return ok(
      this.merchantGoodsTemplatesService.listRestockTraces(
        request.authUser?.id ?? "",
        request.authUser?.tenantId
      )
    );
  }
}
