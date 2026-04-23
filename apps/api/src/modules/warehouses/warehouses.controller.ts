import { Body, Controller, Get, Inject, Param, Post, Req, Res, UseGuards } from "@nestjs/common";

import { ok } from "../../common/dto/api-response";
import { AllowedRoles } from "../../common/guards/allowed-roles.decorator";
import { RoleGuard } from "../../common/guards/role.guard";
import { WarehousesService } from "./warehouses.service";

@Controller()
@UseGuards(RoleGuard)
@AllowedRoles("admin")
export class WarehousesController {
  constructor(@Inject(WarehousesService) private readonly warehousesService: WarehousesService) {}

  @Get("warehouses")
  list() {
    return ok(this.warehousesService.list());
  }

  @Get("warehouse-inventory")
  inventory() {
    return ok(this.warehousesService.getInventory());
  }

  @Post("inventory-transfers")
  transfer(
    @Body()
    body: {
      fromCode: string;
      toCode: string;
      goodsId: string;
      quantity: number;
      sourceBatchId?: string;
      note?: string;
    },
    @Req() request: { authUser?: { id: string } }
  ) {
    return ok(this.warehousesService.transfer(body, request.authUser?.id), "操作成功");
  }

  @Post("stocktakes")
  stocktake(
    @Body()
    body: {
      deviceCode: string;
      note?: string;
      items: Array<{
        goodsId: string;
        actualQuantity: number;
      }>;
    },
    @Req() request: { authUser?: { id: string } }
  ) {
    return ok(this.warehousesService.stocktake(body, request.authUser?.id), "操作成功");
  }

  @Get("stocktakes/:id/export")
  export(@Param("id") id: string, @Res() response: { setHeader: (name: string, value: string) => void; send: (body: string) => void }) {
    const file = this.warehousesService.buildStocktakeExport(id);
    response.setHeader("Content-Type", file.contentType);
    response.setHeader("Content-Disposition", `attachment; filename=\"${file.filename}\"`);
    response.send(file.body);
  }
}
