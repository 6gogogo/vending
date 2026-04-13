import { Module } from "@nestjs/common";

import { GuardsModule } from "../../common/guards/guards.module";
import { RegionsController } from "./regions.controller";
import { RegionsService } from "./regions.service";

@Module({
  imports: [GuardsModule],
  controllers: [RegionsController],
  providers: [RegionsService],
  exports: [RegionsService]
})
export class RegionsModule {}
