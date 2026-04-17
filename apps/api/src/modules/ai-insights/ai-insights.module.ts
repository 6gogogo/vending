import { Module } from "@nestjs/common";

import { GuardsModule } from "../../common/guards/guards.module";
import { AlertsModule } from "../alerts/alerts.module";
import { AnalyticsModule } from "../analytics/analytics.module";
import { DevicesModule } from "../devices/devices.module";
import { GoodsModule } from "../goods/goods.module";
import { OperationLogsModule } from "../operation-logs/operation-logs.module";
import { WarehousesModule } from "../warehouses/warehouses.module";
import { AiInsightsController } from "./ai-insights.controller";
import { AiInsightsService } from "./ai-insights.service";
import { OpenAiCompatibleService } from "./openai-compatible.service";

@Module({
  imports: [
    GuardsModule,
    AlertsModule,
    AnalyticsModule,
    DevicesModule,
    GoodsModule,
    OperationLogsModule,
    WarehousesModule
  ],
  controllers: [AiInsightsController],
  providers: [OpenAiCompatibleService, AiInsightsService],
  exports: [AiInsightsService]
})
export class AiInsightsModule {}
