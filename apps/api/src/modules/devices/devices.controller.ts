import { Body, Controller, Delete, Get, Inject, Param, Patch, Post, Query, Req, UseGuards } from "@nestjs/common";

import type { DeviceStatus, GoodsCategory, UserRole } from "@vm/shared-types";

import { ok } from "../../common/dto/api-response";
import {
  AllowedBackofficePermissions,
  AllowedBackofficeSessionPermissions,
  AllowedRoles,
  TenantScopedBackofficeRoute
} from "../../common/guards/allowed-roles.decorator";
import { RoleGuard } from "../../common/guards/role.guard";
import { DevicesService } from "./devices.service";

@Controller("devices")
@TenantScopedBackofficeRoute()
export class DevicesController {
  constructor(@Inject(DevicesService) private readonly devicesService: DevicesService) {}

  @Get()
  @UseGuards(RoleGuard)
  @AllowedRoles("admin", "merchant", "restocker", "special")
  @AllowedBackofficeSessionPermissions("devices:view")
  list(
    @Query("longitude") longitude?: string,
    @Query("latitude") latitude?: string,
    @Req() request?: {
      authUser?: { id: string; role: UserRole; tenantId?: string };
    }
  ) {
    return ok(
      this.devicesService.list({
        longitude: longitude ? Number(longitude) : undefined,
        latitude: latitude ? Number(latitude) : undefined
      },
      request?.authUser?.role,
      request?.authUser?.id,
      request?.authUser?.tenantId)
    );
  }

  @Post()
  @UseGuards(RoleGuard)
  @AllowedRoles("admin")
  @AllowedBackofficePermissions("devices:manage")
  upsert(
    @Body()
    body: {
      deviceCode: string;
      name: string;
      location: string;
      address?: string;
      longitude?: number;
      latitude?: number;
      doorNum?: string;
      doorLabel?: string;
    },
    @Req() request: { authUser?: { id: string; tenantId?: string } }
  ) {
    return ok(
      this.devicesService.upsertDevice(
        body,
        request.authUser?.id,
        request.authUser?.tenantId
      ),
      "操作成功"
    );
  }

  @Get(":deviceCode")
  @UseGuards(RoleGuard)
  @AllowedRoles("admin", "merchant", "restocker", "special")
  @AllowedBackofficeSessionPermissions("devices:view")
  detail(
    @Param("deviceCode") deviceCode: string,
    @Req() request?: {
      authUser?: { id: string; role: UserRole; tenantId?: string };
    }
  ) {
    return ok(
      this.devicesService.getViewByCode(
        deviceCode,
        request?.authUser?.role,
        request?.authUser?.id,
        request?.authUser?.tenantId
      )
    );
  }

  @Delete(":deviceCode")
  @UseGuards(RoleGuard)
  @AllowedRoles("admin")
  @AllowedBackofficePermissions("devices:manage")
  remove(
    @Param("deviceCode") deviceCode: string,
    @Req() request: { authUser?: { id: string; tenantId?: string } }
  ) {
    return ok(
      this.devicesService.removeDevice(
        deviceCode,
        request.authUser?.id,
        request.authUser?.tenantId
      ),
      "操作成功"
    );
  }

  @Get(":deviceCode/monitoring")
  @UseGuards(RoleGuard)
  @AllowedRoles("admin")
  @AllowedBackofficeSessionPermissions("devices:view", "warehouse:view")
  monitoring(
    @Param("deviceCode") deviceCode: string,
    @Req() request: { authUser?: { tenantId?: string } }
  ) {
    return ok(
      this.devicesService.monitoringDetail(
        deviceCode,
        request.authUser?.tenantId
      )
    );
  }

  @Post(":deviceCode/goods/query")
  @UseGuards(RoleGuard)
  @AllowedRoles("admin", "merchant", "restocker", "special")
  @AllowedBackofficeSessionPermissions("devices:view")
  async goods(
    @Param("deviceCode") deviceCode: string,
    @Query("doorNum") doorNum?: string,
    @Req() request?: {
      authUser?: { id: string; role: UserRole; tenantId?: string };
    }
  ) {
    return ok(
      await this.devicesService.getGoods(
        deviceCode,
        doorNum,
        request?.authUser?.role,
        request?.authUser?.id,
        request?.authUser?.tenantId
      )
    );
  }

  @Post(":deviceCode/refresh")
  @UseGuards(RoleGuard)
  @AllowedRoles("admin")
  @AllowedBackofficeSessionPermissions("devices:operate")
  async refresh(
    @Param("deviceCode") deviceCode: string,
    @Req() request: { authUser?: { id: string; tenantId?: string } }
  ) {
    return ok(
      await this.devicesService.refreshDevice(
        deviceCode,
        request.authUser?.id,
        request.authUser?.tenantId
      ),
      "操作成功"
    );
  }

  @Post(":deviceCode/confirm-door-closed")
  @UseGuards(RoleGuard)
  @AllowedRoles("admin")
  @AllowedBackofficePermissions("devices:operate")
  confirmDoorClosed(
    @Param("deviceCode") deviceCode: string,
    @Req() request: { authUser?: { id: string; tenantId?: string } }
  ) {
    return ok(
      this.devicesService.confirmDoorClosed(
        deviceCode,
        request.authUser?.id,
        request.authUser?.tenantId
      ),
      "柜门关闭状态已确认"
    );
  }

  @Post(":deviceCode/remote-open")
  @UseGuards(RoleGuard)
  @AllowedRoles("admin")
  @AllowedBackofficePermissions("devices:operate")
  async remoteOpen(
    @Param("deviceCode") deviceCode: string,
    @Req() request: { authUser?: { id: string; tenantId?: string } },
    @Body()
    body: {
      doorNum?: string;
      reason: string;
    }
  ) {
    return ok(
      await this.devicesService.remoteOpen(
        deviceCode,
        body,
        request.authUser?.id,
        request.authUser?.tenantId
      ),
      "操作成功"
    );
  }

  @Post(":deviceCode/goods")
  @UseGuards(RoleGuard)
  @AllowedRoles("admin")
  @AllowedBackofficePermissions("devices:manage")
  addGoods(
    @Param("deviceCode") deviceCode: string,
    @Body()
    body: {
      goodsId: string;
      doorNum?: string;
    },
    @Req() request: { authUser?: { id: string; tenantId?: string } }
  ) {
    return ok(
      this.devicesService.addGoodsToDevice(
        deviceCode,
        body,
        request.authUser?.id,
        request.authUser?.tenantId
      ),
      "操作成功"
    );
  }

  @Delete(":deviceCode/goods/:goodsId")
  @UseGuards(RoleGuard)
  @AllowedRoles("admin")
  @AllowedBackofficePermissions("devices:manage")
  removeGoods(
    @Param("deviceCode") deviceCode: string,
    @Param("goodsId") goodsId: string,
    @Query("doorNum") doorNum: string | undefined,
    @Req() request: { authUser?: { id: string; tenantId?: string } }
  ) {
    return ok(
      this.devicesService.removeGoodsFromDevice(
        deviceCode,
        goodsId,
        { doorNum },
        request.authUser?.id,
        request.authUser?.tenantId
      ),
      "操作成功"
    );
  }

  @Patch(":deviceCode/location")
  @UseGuards(RoleGuard)
  @AllowedRoles("admin")
  @AllowedBackofficePermissions("devices:manage")
  updateLocation(
    @Param("deviceCode") deviceCode: string,
    @Body()
    body: {
      location?: string;
      address?: string;
      longitude?: number;
      latitude?: number;
    },
    @Req() request: { authUser?: { id: string; tenantId?: string } }
  ) {
    return ok(
      this.devicesService.updateLocation(
        deviceCode,
        body,
        request.authUser?.id,
        request.authUser?.tenantId
      ),
      "操作成功"
    );
  }

  @Post("mock/upsert")
  @UseGuards(RoleGuard)
  @AllowedRoles("admin")
  @AllowedBackofficePermissions("devices:manage")
  upsertMockDevice(
    @Body()
    body: {
      deviceCode: string;
      name: string;
      location: string;
      address?: string;
      longitude?: number;
      latitude?: number;
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
    @Req() request: { authUser?: { id: string; tenantId?: string } }
  ) {
    return ok(
      this.devicesService.upsertMockDevice(
        body,
        request.authUser?.id,
        request.authUser?.tenantId
      ),
      "操作成功"
    );
  }
}
