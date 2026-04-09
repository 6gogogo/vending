import { Module } from "@nestjs/common";

import { GuardsModule } from "../../common/guards/guards.module";
import { AlertsModule } from "../alerts/alerts.module";
import { GoodsModule } from "../goods/goods.module";
import { AnalyticsController } from "./analytics.controller";
import { AnalyticsService } from "./analytics.service";

@Module({
  imports: [AlertsModule, GoodsModule, GuardsModule],
  controllers: [AnalyticsController],
  providers: [AnalyticsService],
  exports: [AnalyticsService]
})
export class AnalyticsModule {}
