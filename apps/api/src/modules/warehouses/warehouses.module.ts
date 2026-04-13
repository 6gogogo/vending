import { Module } from "@nestjs/common";

import { GuardsModule } from "../../common/guards/guards.module";
import { WarehousesController } from "./warehouses.controller";
import { WarehousesService } from "./warehouses.service";

@Module({
  imports: [GuardsModule],
  controllers: [WarehousesController],
  providers: [WarehousesService],
  exports: [WarehousesService]
})
export class WarehousesModule {}
