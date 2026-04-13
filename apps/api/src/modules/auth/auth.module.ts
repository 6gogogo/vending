import { Module } from "@nestjs/common";

import { AccessRulesModule } from "../access-rules/access-rules.module";
import { RegistrationApplicationsModule } from "../registration-applications/registration-applications.module";
import { UsersModule } from "../users/users.module";
import { AuthController } from "./auth.controller";
import { AuthService } from "./auth.service";
import { VerificationCodeModule } from "./verification-code.module";

@Module({
  imports: [UsersModule, AccessRulesModule, RegistrationApplicationsModule, VerificationCodeModule],
  controllers: [AuthController],
  providers: [AuthService]
})
export class AuthModule {}
