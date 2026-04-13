import { Body, Controller, Get, Headers, Inject, Post } from "@nestjs/common";

import type { RegistrationApplicationProfile, UserRole } from "@vm/shared-types";

import { ok } from "../../common/dto/api-response";
import { AuthService } from "./auth.service";

@Controller("auth")
export class AuthController {
  constructor(@Inject(AuthService) private readonly authService: AuthService) {}

  @Post("request-code")
  requestCode(@Body() body: { phone: string }) {
    return ok(this.authService.requestCode(body.phone));
  }

  @Post("mobile-login")
  mobileLogin(@Body() body: { phone: string; code: string; requestedRole?: UserRole }) {
    return ok(this.authService.mobileLogin(body.phone, body.code, body.requestedRole));
  }

  @Post("app-login")
  appLogin(@Body() body: { phone: string; code: string }) {
    return ok(this.authService.appLogin(body.phone, body.code));
  }

  @Post("mobile-profile")
  mobileProfile(
    @Body()
    body: {
      draftToken: string;
      requestedRole?: UserRole;
      profile: RegistrationApplicationProfile;
    }
  ) {
    return ok(this.authService.submitMobileProfile(body));
  }

  @Post("login")
  login(@Body() body: { phone: string; code: string }) {
    return ok(this.authService.login(body.phone, body.code));
  }

  @Post("admin-login")
  adminLogin(@Body() body: { phone: string; code: string }) {
    return ok(this.authService.adminLogin(body.phone, body.code));
  }

  @Get("session")
  session(@Headers("authorization") authorization?: string) {
    const token = authorization?.startsWith("Bearer ")
      ? authorization.slice("Bearer ".length)
      : undefined;
    return ok(this.authService.getAdminSession(token));
  }

  @Get("mobile-session")
  mobileSession(@Headers("authorization") authorization?: string) {
    const token = authorization?.startsWith("Bearer ")
      ? authorization.slice("Bearer ".length)
      : undefined;
    return ok(this.authService.getMobileSession(token));
  }

  @Get("app-session")
  appSession(@Headers("authorization") authorization?: string) {
    const token = authorization?.startsWith("Bearer ")
      ? authorization.slice("Bearer ".length)
      : undefined;
    return ok(this.authService.getAppSession(token));
  }
}
