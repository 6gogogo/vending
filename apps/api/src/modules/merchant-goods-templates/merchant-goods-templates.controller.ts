import { Body, Controller, Get, Inject, Param, Patch, Post, Req, UseGuards } from "@nestjs/common";

import type { GoodsCategory } from "@vm/shared-types";

import { ok } from "../../common/dto/api-response";
import { AllowedRoles } from "../../common/guards/allowed-roles.decorator";
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
  @AllowedRoles("merchant")
  list() {
    return ok(this.merchantGoodsTemplatesService.list());
  }

  @Post("merchant-goods-templates")
  @AllowedRoles("merchant")
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
    @Req() request: { authUser?: { id: string } }
  ) {
    return ok(
      this.merchantGoodsTemplatesService.create(request.authUser?.id ?? "", body),
      "操作成功"
    );
  }

  @Patch("merchant-goods-templates/:id")
  @AllowedRoles("merchant")
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
    @Req() request: { authUser?: { id: string } }
  ) {
    return ok(
      this.merchantGoodsTemplatesService.update(request.authUser?.id ?? "", id, body),
      "操作成功"
    );
  }

  @Post("merchant-restocks")
  @AllowedRoles("merchant")
  createRestock(
    @Body()
    body: {
      templateId: string;
      deviceCode: string;
      quantity?: number;
      productionDate: string;
      note?: string;
      confirmed?: boolean;
    },
    @Req() request: { authUser?: { id: string } }
  ) {
    return ok(
      this.merchantGoodsTemplatesService.createRestock(request.authUser?.id ?? "", body),
      "操作成功"
    );
  }

  @Get("merchant-restock-traces")
  @AllowedRoles("merchant")
  traces(@Req() request: { authUser?: { id: string } }) {
    return ok(this.merchantGoodsTemplatesService.listRestockTraces(request.authUser?.id ?? ""));
  }
}
