import { Module } from "@nestjs/common";

import { GuardsModule } from "../../common/guards/guards.module";
import { DevicesModule } from "../devices/devices.module";
import { GoodsController } from "./goods.controller";
import { GoodsService } from "./goods.service";

@Module({
  imports: [GuardsModule, DevicesModule],
  controllers: [GoodsController],
  providers: [GoodsService],
  exports: [GoodsService]
})
export class GoodsModule {}
