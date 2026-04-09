import { Module } from "@nestjs/common";
import { ConfigModule } from "@nestjs/config";

import { AppController } from "./app.controller";
import { StoreModule } from "./common/store/store.module";
import { AccessRulesModule } from "./modules/access-rules/access-rules.module";
import { AlertsModule } from "./modules/alerts/alerts.module";
import { AnalyticsModule } from "./modules/analytics/analytics.module";
import { AuthModule } from "./modules/auth/auth.module";
import { CabinetEventsModule } from "./modules/cabinet-events/cabinet-events.module";
import { DevicesModule } from "./modules/devices/devices.module";
import { GoodsModule } from "./modules/goods/goods.module";
import { InventoryOrdersModule } from "./modules/inventory-orders/inventory-orders.module";
import { OperationLogsModule } from "./modules/operation-logs/operation-logs.module";
import { SpecialAccessPoliciesModule } from "./modules/special-access-policies/special-access-policies.module";
import { UsersModule } from "./modules/users/users.module";

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true
    }),
    StoreModule,
    UsersModule,
    AccessRulesModule,
    DevicesModule,
    GoodsModule,
    AlertsModule,
    OperationLogsModule,
    InventoryOrdersModule,
    CabinetEventsModule,
    AnalyticsModule,
    AuthModule,
    SpecialAccessPoliciesModule
  ],
  controllers: [AppController]
})
export class AppModule {}
