import { Module } from "@nestjs/common";

import { GuardsModule } from "../../common/guards/guards.module";
import { DevicesModule } from "../devices/devices.module";
import { GoodsController } from "./goods.controller";
import { GoodsService } from "./goods.service";
import { GoodsTaxonomyController } from "./goods-taxonomy.controller";
import { GoodsTaxonomyService } from "./goods-taxonomy.service";

@Module({
  imports: [GuardsModule, DevicesModule],
  controllers: [GoodsController, GoodsTaxonomyController],
  providers: [GoodsService, GoodsTaxonomyService],
  exports: [GoodsService, GoodsTaxonomyService]
})
export class GoodsModule {}
