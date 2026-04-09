import { Body, Controller, Get, Inject, Param, Patch, Post, Query, Req, UseGuards } from "@nestjs/common";

import type { GoodsAlertPolicy } from "@vm/shared-types";

import { ok } from "../../common/dto/api-response";
import { AllowedRoles } from "../../common/guards/allowed-roles.decorator";
import { RoleGuard } from "../../common/guards/role.guard";
import { GoodsService } from "./goods.service";

@Controller()
export class GoodsController {
  constructor(@Inject(GoodsService) private readonly goodsService: GoodsService) {}

  @Get("goods-overview")
  @UseGuards(RoleGuard)
  @AllowedRoles("admin")
  overview() {
    return ok(this.goodsService.getOverview());
  }

  @Get("goods-catalog")
  @UseGuards(RoleGuard)
  @AllowedRoles("admin")
  catalog() {
    return ok(this.goodsService.listCatalog());
  }

  @Get("goods/:goodsId")
  @UseGuards(RoleGuard)
  @AllowedRoles("admin")
  detail(@Param("goodsId") goodsId: string) {
    return ok(this.goodsService.getDetail(goodsId));
  }

  @Post("goods")
  @UseGuards(RoleGuard)
  @AllowedRoles("admin")
  createGoods(
    @Body()
    body: {
      goodsCode: string;
      goodsId: string;
      name: string;
      category: "food" | "drink" | "daily";
      price: number;
      imageUrl: string;
    },
    @Req() request: { authUser?: { id: string } }
  ) {
    return ok(this.goodsService.createCatalogItem(body, request.authUser?.id), "货品种类已创建。");
  }

  @Patch("goods/:goodsId")
  @UseGuards(RoleGuard)
  @AllowedRoles("admin")
  updateGoods(
    @Param("goodsId") goodsId: string,
    @Body()
    body: {
      goodsCode?: string;
      name?: string;
      category?: "food" | "drink" | "daily";
      price?: number;
      imageUrl?: string;
      status?: "active" | "inactive";
    },
    @Req() request: { authUser?: { id: string } }
  ) {
    return ok(this.goodsService.updateCatalogItem(goodsId, body, request.authUser?.id), "货品信息已更新。");
  }

  @Post("goods/:goodsId/batches")
  @UseGuards(RoleGuard)
  @AllowedRoles("admin")
  addBatch(
    @Param("goodsId") goodsId: string,
    @Body()
    body: {
      deviceCode: string;
      quantity: number;
      expiresAt?: string;
      sourceType?: "admin" | "merchant" | "system";
      sourceUserId?: string;
      sourceUserName?: string;
      note?: string;
    },
    @Req() request: { authUser?: { id: string } }
  ) {
    return ok(this.goodsService.addBatch(goodsId, body, request.authUser?.id), "货物批次已入库。");
  }

  @Post("goods/batches/:batchId/remove")
  @UseGuards(RoleGuard)
  @AllowedRoles("admin")
  removeBatch(
    @Param("batchId") batchId: string,
    @Body()
    body: {
      quantity: number;
      note?: string;
    },
    @Req() request: { authUser?: { id: string } }
  ) {
    return ok(this.goodsService.removeBatch(batchId, body, request.authUser?.id), "批次库存已去除。");
  }

  @Get("goods-alert-policies")
  @UseGuards(RoleGuard)
  @AllowedRoles("admin")
  alertPolicies() {
    return ok(this.goodsService.listAlertPolicies());
  }

  @Post("goods-alert-policies")
  @UseGuards(RoleGuard)
  @AllowedRoles("admin")
  createAlertPolicy(
    @Body() body: Omit<GoodsAlertPolicy, "id">,
    @Req() request: { authUser?: { id: string } }
  ) {
    return ok(
      this.goodsService.createAlertPolicy(body, request.authUser?.id),
      "货品预警模板已创建。"
    );
  }

  @Patch("goods-alert-policies/:id")
  @UseGuards(RoleGuard)
  @AllowedRoles("admin")
  updateAlertPolicy(
    @Param("id") id: string,
    @Body() body: Partial<Omit<GoodsAlertPolicy, "id">>,
    @Req() request: { authUser?: { id: string } }
  ) {
    return ok(
      this.goodsService.updateAlertPolicy(id, body, request.authUser?.id),
      "货品预警模板已更新。"
    );
  }

  @Post("goods-alert-policies/batch-assign")
  @UseGuards(RoleGuard)
  @AllowedRoles("admin")
  batchAssignAlertPolicies(
    @Body()
    body: {
      deviceCodes: string[];
      policyIds: string[];
      mode: "bind" | "unbind" | "replace";
    },
    @Req() request: { authUser?: { id: string } }
  ) {
    return ok(
      this.goodsService.batchAssignAlertPolicies(body, request.authUser?.id),
      "货品预警模板批量绑定已更新。"
    );
  }

  @Post("devices/:deviceCode/sync-goods")
  @UseGuards(RoleGuard)
  @AllowedRoles("admin")
  async sync(
    @Param("deviceCode") deviceCode: string,
    @Query("doorNum") doorNum = "1",
    @Req() request: { authUser?: { id: string } }
  ) {
    return ok(
      await this.goodsService.syncDeviceGoods(deviceCode, doorNum, request.authUser?.id),
      "柜机货品种类已同步。"
    );
  }

  @Patch("devices/:deviceCode/goods/:goodsId/threshold")
  @UseGuards(RoleGuard)
  @AllowedRoles("admin")
  updateThreshold(
    @Param("deviceCode") deviceCode: string,
    @Param("goodsId") goodsId: string,
    @Body()
    body: {
      enabled: boolean;
      lowStockThreshold?: number;
    },
    @Req() request: { authUser?: { id: string } }
  ) {
    return ok(
      this.goodsService.updateDeviceThreshold(deviceCode, goodsId, body, request.authUser?.id),
      "柜机货品阈值已更新。"
    );
  }
}
