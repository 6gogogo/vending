import { Module } from "@nestjs/common";

import { GuardsModule } from "../../common/guards/guards.module";
import { AccessRulesController } from "./access-rules.controller";
import { AccessRulesService } from "./access-rules.service";

@Module({
  imports: [GuardsModule],
  controllers: [AccessRulesController],
  providers: [AccessRulesService],
  exports: [AccessRulesService]
})
export class AccessRulesModule {}
