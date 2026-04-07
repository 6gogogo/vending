import { Body, Controller, Get, Inject, Param, Post, Query, UseGuards } from "@nestjs/common";

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

  @Post(":deviceCode/goods/query")
  async goods(@Param("deviceCode") deviceCode: string, @Query("doorNum") doorNum?: string) {
    return ok(await this.devicesService.getGoods(deviceCode, doorNum));
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
    }
  ) {
    return ok(this.devicesService.upsertMockDevice(body), "模拟柜机已保存。");
  }
}
