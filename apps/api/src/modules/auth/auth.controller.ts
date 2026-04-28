import { Body, Controller, Get, Headers, Inject, Patch, Post } from "@nestjs/common";

import type { BackofficeRole, RegistrationApplicationProfile, UserRole } from "@vm/shared-types";

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

  @Post("admin-password-login")
  async adminPasswordLogin(@Body() body: { username: string; password: string }) {
    return ok(await this.authService.adminPasswordLogin(body.username, body.password));
  }

  @Post("backoffice-login")
  async backofficeLogin(@Body() body: { username: string; password: string }) {
    return ok(await this.authService.backofficeLogin(body.username, body.password));
  }

  @Patch("admin-password")
  async changeAdminPassword(
    @Headers("authorization") authorization: string | undefined,
    @Body() body: { currentPassword: string; newPassword: string }
  ) {
    return ok(
      this.authService.changeAdminPassword(
        this.extractBearerToken(authorization),
        body.currentPassword,
        body.newPassword
      ),
      "密码已更新。"
    );
  }

  @Patch("backoffice-password")
  async changeBackofficePassword(
    @Headers("authorization") authorization: string | undefined,
    @Body() body: { currentPassword: string; newPassword: string }
  ) {
    return ok(
      this.authService.changeBackofficePassword(
        this.extractBearerToken(authorization),
        body.currentPassword,
        body.newPassword
      ),
      "密码已更新。"
    );
  }

  @Post("backoffice-credentials")
  createBackofficeCredential(
    @Headers("authorization") authorization: string | undefined,
    @Body()
    body: {
      userId: string;
      username: string;
      password: string;
      role?: BackofficeRole;
    }
  ) {
    return ok(
      this.authService.createBackofficeCredential(this.extractBearerToken(authorization), body),
      "后台账号已保存。"
    );
  }

  @Get("session")
  session(@Headers("authorization") authorization?: string) {
    return ok(this.authService.getAdminSession(this.extractBearerToken(authorization)));
  }

  @Get("backoffice-session")
  backofficeSession(@Headers("authorization") authorization?: string) {
    return ok(this.authService.getBackofficeSession(this.extractBearerToken(authorization)));
  }

  @Get("mobile-session")
  mobileSession(@Headers("authorization") authorization?: string) {
    return ok(this.authService.getMobileSession(this.extractBearerToken(authorization)));
  }

  @Get("app-session")
  appSession(@Headers("authorization") authorization?: string) {
    return ok(this.authService.getAppSession(this.extractBearerToken(authorization)));
  }

  private extractBearerToken(authorization?: string) {
    return authorization?.startsWith("Bearer ")
      ? authorization.slice("Bearer ".length)
      : undefined;
  }
}
