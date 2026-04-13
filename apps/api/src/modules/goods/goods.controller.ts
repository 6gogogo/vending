import { Body, Controller, Get, Inject, Param, Patch, Post, Query, Req, Res, UseGuards } from "@nestjs/common";

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

  @Get("goods-overview/export/file")
  @UseGuards(RoleGuard)
  @AllowedRoles("admin")
  exportOverview(
    @Res()
    response: {
      setHeader: (name: string, value: string) => void;
      send: (body: string) => void;
    }
  ) {
    const file = this.goodsService.buildOverviewExport();
    response.setHeader("Content-Type", file.contentType);
    response.setHeader("Content-Disposition", `attachment; filename=\"${file.filename}\"`);
    response.send(file.body);
  }

  @Get("goods-catalog")
  @UseGuards(RoleGuard)
  @AllowedRoles("admin")
  catalog() {
    return ok(this.goodsService.listCatalog());
  }

  @Get("goods-categories")
  @UseGuards(RoleGuard)
  @AllowedRoles("admin", "merchant")
  categories() {
    return ok(this.goodsService.listCategories());
  }

  @Post("goods-categories")
  @UseGuards(RoleGuard)
  @AllowedRoles("admin")
  createCategory(
    @Body()
    body: {
      name: string;
      category: "food" | "drink" | "daily";
      sortOrder?: number;
    },
    @Req() request: { authUser?: { id: string } }
  ) {
    return ok(this.goodsService.createCategory(body, request.authUser?.id), "操作成功");
  }

  @Patch("goods-categories/:id")
  @UseGuards(RoleGuard)
  @AllowedRoles("admin")
  updateCategory(
    @Param("id") id: string,
    @Body()
    body: {
      name?: string;
      category?: "food" | "drink" | "daily";
      status?: "active" | "inactive";
      sortOrder?: number;
    },
    @Req() request: { authUser?: { id: string } }
  ) {
    return ok(this.goodsService.updateCategory(id, body, request.authUser?.id), "操作成功");
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
      goodsId?: string;
      name: string;
      fullName?: string;
      category: "food" | "drink" | "daily";
      categoryName?: string;
      price: number;
      imageUrl: string;
      packageForm?: string;
      specification?: string;
      manufacturer?: string;
    },
    @Req() request: { authUser?: { id: string } }
  ) {
    return ok(this.goodsService.createCatalogItem(body, request.authUser?.id), "操作成功");
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
      fullName?: string;
      category?: "food" | "drink" | "daily";
      categoryName?: string;
      price?: number;
      imageUrl?: string;
      packageForm?: string;
      specification?: string;
      manufacturer?: string;
      status?: "active" | "inactive";
    },
    @Req() request: { authUser?: { id: string } }
  ) {
    return ok(this.goodsService.updateCatalogItem(goodsId, body, request.authUser?.id), "操作成功");
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
    return ok(this.goodsService.addBatch(goodsId, body, request.authUser?.id), "操作成功");
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
    return ok(this.goodsService.removeBatch(batchId, body, request.authUser?.id), "操作成功");
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
      "操作成功"
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
      "操作成功"
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
      "操作成功"
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
      "操作成功"
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
      "操作成功"
    );
  }
}
