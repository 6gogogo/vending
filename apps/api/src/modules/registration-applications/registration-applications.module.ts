import { Module } from "@nestjs/common";

import { GuardsModule } from "../../common/guards/guards.module";
import { RegistrationApplicationsController } from "./registration-applications.controller";
import { RegistrationApplicationsService } from "./registration-applications.service";

@Module({
  imports: [GuardsModule],
  controllers: [RegistrationApplicationsController],
  providers: [RegistrationApplicationsService],
  exports: [RegistrationApplicationsService]
})
export class RegistrationApplicationsModule {}
