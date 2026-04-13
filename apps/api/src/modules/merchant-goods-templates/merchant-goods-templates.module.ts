import { Module } from "@nestjs/common";

import { GuardsModule } from "../../common/guards/guards.module";
import { AlertsModule } from "../alerts/alerts.module";
import { MerchantGoodsTemplatesController } from "./merchant-goods-templates.controller";
import { MerchantGoodsTemplatesService } from "./merchant-goods-templates.service";

@Module({
  imports: [GuardsModule, AlertsModule],
  controllers: [MerchantGoodsTemplatesController],
  providers: [MerchantGoodsTemplatesService],
  exports: [MerchantGoodsTemplatesService]
})
export class MerchantGoodsTemplatesModule {}
