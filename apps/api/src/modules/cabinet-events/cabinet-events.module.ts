import { Module } from "@nestjs/common";

import { FinancialOperationCoordinatorModule } from "../../common/coordination/financial-operation-coordinator.module";
import { GuardsModule } from "../../common/guards/guards.module";
import { AccessRulesModule } from "../access-rules/access-rules.module";
import { AlertsModule } from "../alerts/alerts.module";
import { DevicesModule } from "../devices/devices.module";
import { InventoryOrdersModule } from "../inventory-orders/inventory-orders.module";
import { ReservationsModule } from "../reservations/reservations.module";
import { CabinetOpenQuoteService } from "./cabinet-open-quote.service";
import { CabinetEventsController } from "./cabinet-events.controller";
import { CabinetEventsService } from "./cabinet-events.service";
import { ManualSettlementRecoveryService } from "./manual-settlement-recovery.service";

@Module({
  imports: [
    FinancialOperationCoordinatorModule,
    AccessRulesModule,
    DevicesModule,
    InventoryOrdersModule,
    AlertsModule,
    ReservationsModule,
    GuardsModule
  ],
  controllers: [CabinetEventsController],
  providers: [CabinetEventsService, CabinetOpenQuoteService, ManualSettlementRecoveryService],
  exports: [CabinetEventsService, ManualSettlementRecoveryService]
})
export class CabinetEventsModule {}
