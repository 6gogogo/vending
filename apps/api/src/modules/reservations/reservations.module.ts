import { Module } from "@nestjs/common";

import { GuardsModule } from "../../common/guards/guards.module";
import { AccessRulesModule } from "../access-rules/access-rules.module";
import { ReservationsController } from "./reservations.controller";
import { ReservationsService } from "./reservations.service";

@Module({
  imports: [AccessRulesModule, GuardsModule],
  controllers: [ReservationsController],
  providers: [ReservationsService],
  exports: [ReservationsService]
})
export class ReservationsModule {}
