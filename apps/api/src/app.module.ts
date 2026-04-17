import { Module } from "@nestjs/common";
import { ConfigModule } from "@nestjs/config";

import { AppController } from "./app.controller";
import { StoreModule } from "./common/store/store.module";
import { AccessRulesModule } from "./modules/access-rules/access-rules.module";
import { AiInsightsModule } from "./modules/ai-insights/ai-insights.module";
import { AlertsModule } from "./modules/alerts/alerts.module";
import { AnalyticsModule } from "./modules/analytics/analytics.module";
import { AuthModule } from "./modules/auth/auth.module";
import { CabinetEventsModule } from "./modules/cabinet-events/cabinet-events.module";
import { DevicesModule } from "./modules/devices/devices.module";
import { GoodsModule } from "./modules/goods/goods.module";
import { InventoryOrdersModule } from "./modules/inventory-orders/inventory-orders.module";
import { MerchantGoodsTemplatesModule } from "./modules/merchant-goods-templates/merchant-goods-templates.module";
import { OperationLogsModule } from "./modules/operation-logs/operation-logs.module";
import { RegistrationApplicationsModule } from "./modules/registration-applications/registration-applications.module";
import { RegionsModule } from "./modules/regions/regions.module";
import { SpecialAccessPoliciesModule } from "./modules/special-access-policies/special-access-policies.module";
import { UploadsModule } from "./modules/uploads/uploads.module";
import { UsersModule } from "./modules/users/users.module";
import { WarehousesModule } from "./modules/warehouses/warehouses.module";

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      envFilePath: [
        ".env.local",
        ".env",
        ".env.example",
        "apps/api/.env.local",
        "apps/api/.env",
        "apps/api/.env.example"
      ]
    }),
    StoreModule,
    AiInsightsModule,
    UsersModule,
    AccessRulesModule,
    DevicesModule,
    GoodsModule,
    MerchantGoodsTemplatesModule,
    AlertsModule,
    OperationLogsModule,
    InventoryOrdersModule,
    CabinetEventsModule,
    AnalyticsModule,
    AuthModule,
    SpecialAccessPoliciesModule,
    RegistrationApplicationsModule,
    RegionsModule,
    UploadsModule,
    WarehousesModule
  ],
  controllers: [AppController]
})
export class AppModule {}
