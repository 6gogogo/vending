import { Module } from "@nestjs/common";

import { GuardsModule } from "../../common/guards/guards.module";
import { SpecialAccessPoliciesController } from "./special-access-policies.controller";
import { SpecialAccessPoliciesService } from "./special-access-policies.service";

@Module({
  imports: [GuardsModule],
  controllers: [SpecialAccessPoliciesController],
  providers: [SpecialAccessPoliciesService],
  exports: [SpecialAccessPoliciesService]
})
export class SpecialAccessPoliciesModule {}
