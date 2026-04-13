import { Module } from "@nestjs/common";

import { GuardsModule } from "../../common/guards/guards.module";
import { VerificationCodeModule } from "../auth/verification-code.module";
import { RegistrationApplicationsController } from "./registration-applications.controller";
import { RegistrationApplicationsService } from "./registration-applications.service";

@Module({
  imports: [GuardsModule, VerificationCodeModule],
  controllers: [RegistrationApplicationsController],
  providers: [RegistrationApplicationsService],
  exports: [RegistrationApplicationsService]
})
export class RegistrationApplicationsModule {}
