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
}
