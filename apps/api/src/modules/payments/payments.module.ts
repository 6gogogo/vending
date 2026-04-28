import { Module } from "@nestjs/common";

import { GuardsModule } from "../../common/guards/guards.module";
import { CabinetEventsModule } from "../cabinet-events/cabinet-events.module";
import { InventoryOrdersModule } from "../inventory-orders/inventory-orders.module";
import { PaymentsController } from "./payments.controller";
import { PaymentsService } from "./payments.service";

@Module({
  imports: [CabinetEventsModule, InventoryOrdersModule, GuardsModule],
  controllers: [PaymentsController],
  providers: [PaymentsService],
  exports: [PaymentsService]
})
export class PaymentsModule {}
