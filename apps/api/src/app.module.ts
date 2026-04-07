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
import { InventoryOrdersModule } from "./modules/inventory-orders/inventory-orders.module";
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
    AlertsModule,
    InventoryOrdersModule,
    CabinetEventsModule,
    AnalyticsModule,
    AuthModule
  ],
  controllers: [AppController]
})
export class AppModule {}
