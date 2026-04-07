import { Module } from "@nestjs/common";

import { GuardsModule } from "../../common/guards/guards.module";
import { AlertsModule } from "../alerts/alerts.module";
import { DevicesModule } from "../devices/devices.module";
import { InventoryOrdersController } from "./inventory-orders.controller";
import { InventoryOrdersService } from "./inventory-orders.service";

@Module({
  imports: [DevicesModule, AlertsModule, GuardsModule],
  controllers: [InventoryOrdersController],
  providers: [InventoryOrdersService],
  exports: [InventoryOrdersService]
})
export class InventoryOrdersModule {}
