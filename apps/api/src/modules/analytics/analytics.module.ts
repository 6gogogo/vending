import { Module } from "@nestjs/common";

import { GuardsModule } from "../../common/guards/guards.module";
import { AlertsModule } from "../alerts/alerts.module";
import { AnalyticsController } from "./analytics.controller";
import { AnalyticsService } from "./analytics.service";

@Module({
  imports: [AlertsModule, GuardsModule],
  controllers: [AnalyticsController],
  providers: [AnalyticsService],
  exports: [AnalyticsService]
})
export class AnalyticsModule {}
