import { Module } from "@nestjs/common";

import { AccessRulesModule } from "../access-rules/access-rules.module";
import { RegistrationApplicationsModule } from "../registration-applications/registration-applications.module";
import { UsersModule } from "../users/users.module";
import { AuthController } from "./auth.controller";
import { AuthService } from "./auth.service";

@Module({
  imports: [UsersModule, AccessRulesModule, RegistrationApplicationsModule],
  controllers: [AuthController],
  providers: [AuthService]
})
export class AuthModule {}
