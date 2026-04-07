import { Module } from "@nestjs/common";

import { GuardsModule } from "../../common/guards/guards.module";
import { AccessRulesModule } from "../access-rules/access-rules.module";
import { AlertsModule } from "../alerts/alerts.module";
import { DevicesModule } from "../devices/devices.module";
import { InventoryOrdersModule } from "../inventory-orders/inventory-orders.module";
import { CabinetEventsController } from "./cabinet-events.controller";
import { CabinetEventsService } from "./cabinet-events.service";

@Module({
  imports: [AccessRulesModule, DevicesModule, InventoryOrdersModule, AlertsModule, GuardsModule],
  controllers: [CabinetEventsController],
  providers: [CabinetEventsService],
  exports: [CabinetEventsService]
})
export class CabinetEventsModule {}
