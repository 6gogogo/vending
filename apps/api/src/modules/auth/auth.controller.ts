import { Body, Controller, Get, Headers, Inject, Post } from "@nestjs/common";

import type { RegistrationApplicationProfile, UserRole } from "@vm/shared-types";

import { ok } from "../../common/dto/api-response";
import { AuthService } from "./auth.service";

@Controller("auth")
export class AuthController {
  constructor(@Inject(AuthService) private readonly authService: AuthService) {}

  @Post("request-code")
  async requestCode(
    @Body()
    body: {
      phone: string;
      scene?: "app-login" | "register" | "general";
    }
  ) {
    return ok(await this.authService.requestCode(body.phone, body.scene));
  }

  @Post("mobile-login")
  async mobileLogin(@Body() body: { phone: string; code: string; requestedRole?: UserRole }) {
    return ok(await this.authService.mobileLogin(body.phone, body.code, body.requestedRole));
  }

  @Post("app-login")
  async appLogin(@Body() body: { phone: string; code: string }) {
    return ok(await this.authService.appLogin(body.phone, body.code));
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
  async login(@Body() body: { phone: string; code: string }) {
    return ok(await this.authService.login(body.phone, body.code));
  }

  @Post("admin-login")
  async adminLogin(@Body() body: { phone: string; code: string }) {
    return ok(await this.authService.adminLogin(body.phone, body.code));
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
