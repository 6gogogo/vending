import { Module } from "@nestjs/common";

import { FinancialOperationCoordinatorModule } from "../../common/coordination/financial-operation-coordinator.module";
import { GuardsModule } from "../../common/guards/guards.module";
import { AlertsModule } from "../alerts/alerts.module";
import { CabinetEventsModule } from "../cabinet-events/cabinet-events.module";
import { DevicesModule } from "../devices/devices.module";
import { InventoryOrdersModule } from "../inventory-orders/inventory-orders.module";
import { LegacyRefundController } from "./legacy-refund.controller";
import { PaymentPayerIdentityHandleService } from "./payment-payer-identity-handle.service";
import { PaymentReconciliationScheduler } from "./payment-reconciliation.scheduler";
import { PaymentsController } from "./payments.controller";
import { PaymentsService } from "./payments.service";

@Module({
  imports: [
    FinancialOperationCoordinatorModule,
    AlertsModule,
    CabinetEventsModule,
    DevicesModule,
    InventoryOrdersModule,
    GuardsModule
  ],
  controllers: [PaymentsController, LegacyRefundController],
  providers: [
    PaymentPayerIdentityHandleService,
    PaymentsService,
    PaymentReconciliationScheduler
  ],
  exports: [PaymentsService]
})
export class PaymentsModule {}
