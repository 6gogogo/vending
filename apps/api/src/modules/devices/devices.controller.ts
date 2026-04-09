import { Body, Controller, Get, Inject, Param, Post, Query, Req, UseGuards } from "@nestjs/common";

import type { DeviceStatus, GoodsCategory } from "@vm/shared-types";

import { ok } from "../../common/dto/api-response";
import { AllowedRoles } from "../../common/guards/allowed-roles.decorator";
import { RoleGuard } from "../../common/guards/role.guard";
import { DevicesService } from "./devices.service";

@Controller("devices")
export class DevicesController {
  constructor(@Inject(DevicesService) private readonly devicesService: DevicesService) {}

  @Get()
  list() {
    return ok(this.devicesService.list());
  }

  @Get(":deviceCode")
  detail(@Param("deviceCode") deviceCode: string) {
    return ok(this.devicesService.getByCode(deviceCode));
  }

  @Get(":deviceCode/monitoring")
  @UseGuards(RoleGuard)
  @AllowedRoles("admin")
  monitoring(@Param("deviceCode") deviceCode: string) {
    return ok(this.devicesService.monitoringDetail(deviceCode));
  }

  @Post(":deviceCode/goods/query")
  async goods(@Param("deviceCode") deviceCode: string, @Query("doorNum") doorNum?: string) {
    return ok(await this.devicesService.getGoods(deviceCode, doorNum));
  }

  @Post(":deviceCode/refresh")
  @UseGuards(RoleGuard)
  @AllowedRoles("admin")
  async refresh(
    @Param("deviceCode") deviceCode: string,
    @Req() request: { authUser?: { id: string } }
  ) {
    return ok(await this.devicesService.refreshDevice(deviceCode, request.authUser?.id), "柜机状态已刷新。");
  }

  @Post(":deviceCode/remote-open")
  @UseGuards(RoleGuard)
  @AllowedRoles("admin")
  async remoteOpen(
    @Param("deviceCode") deviceCode: string,
    @Req() request: { authUser?: { id: string } },
    @Body()
    body: {
      doorNum?: string;
    } = {}
  ) {
    return ok(await this.devicesService.remoteOpen(deviceCode, body, request.authUser?.id), "远程开门指令已下发。");
  }

  @Post("mock/upsert")
  @UseGuards(RoleGuard)
  @AllowedRoles("admin")
  upsertMockDevice(
    @Body()
    body: {
      deviceCode: string;
      name: string;
      location: string;
      status?: DeviceStatus;
      doorNum?: string;
      goods: Array<{
        goodsId: string;
        goodsCode?: string;
        name: string;
        category: GoodsCategory;
        stock: number;
        price?: number;
        imageUrl?: string;
        expiresAt?: string;
      }>;
    },
    @Req() request: { authUser?: { id: string } }
  ) {
    return ok(this.devicesService.upsertMockDevice(body, request.authUser?.id), "模拟柜机已保存。");
  }
}
