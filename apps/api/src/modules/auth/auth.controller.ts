import {
  Body,
  Controller,
  Get,
  Headers,
  Inject,
  Param,
  Patch,
  Post,
  Req
} from "@nestjs/common";

import type {
  BackofficePermission,
  BackofficeRole,
  RegistrationApplicationProfile,
  UserRole
} from "@vm/shared-types";

import { ok } from "../../common/dto/api-response";
import { REQUEST_PERSISTENCE_HANDLED } from "../../common/store/persistence.interceptor";
import { AuthService } from "./auth.service";

@Controller("auth")
export class AuthController {
  constructor(@Inject(AuthService) private readonly authService: AuthService) {}

  @Post("request-code")
  async requestCode(
    @Body()
    body: {
      phone: string;
      scene?: "app-login" | "register" | "general" | "password-reset";
    }
  ) {
    return ok(await this.authService.requestCode(body.phone, body.scene));
  }

  @Post("mobile-login")
  async mobileLogin(
    @Body() body: { phone: string; code: string; requestedRole?: UserRole },
    @Req() request?: { hostname?: string }
  ) {
    return ok(
      await this.authService.mobileLogin(
        body.phone,
        body.code,
        body.requestedRole,
        request?.hostname
      )
    );
  }

  @Post("app-login")
  async appLogin(
    @Body() body: { phone: string; code: string },
    @Req() request?: { hostname?: string }
  ) {
    return ok(
      await this.authService.appLogin(
        body.phone,
        body.code,
        request?.hostname
      )
    );
  }

  @Post("mobile-profile")
  mobileProfile(
    @Body()
    body: {
      draftToken: string;
      requestedRole?: UserRole;
      profile: RegistrationApplicationProfile;
    },
    @Req() request?: { hostname?: string }
  ) {
    return ok(
      this.authService.submitMobileProfile(body, request?.hostname)
    );
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
  async adminPasswordLogin(
    @Body() body: { username: string; password: string },
    @Req() request: { ip?: string }
  ) {
    return ok(
      await this.authService.adminPasswordLogin(
        body.username,
        body.password,
        request.ip ?? "unknown"
      )
    );
  }

  @Post("backoffice-login")
  async backofficeLogin(
    @Body() body: { username: string; password: string },
    @Req() request: { ip?: string }
  ) {
    return ok(
      await this.authService.backofficeLogin(
        body.username,
        body.password,
        request.ip ?? "unknown"
      )
    );
  }

  @Post("logout")
  logout(@Headers("authorization") authorization?: string) {
    return ok(
      this.authService.logout(this.extractBearerToken(authorization)),
      "已退出登录。"
    );
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

  @Post("backoffice-password-reset")
  async resetOwnBackofficePassword(
    @Body() body: { username: string; phone: string; code: string; newPassword: string },
    @Req()
    request: {
      [REQUEST_PERSISTENCE_HANDLED]?: boolean;
    }
  ) {
    const result = await this.authService.resetOwnBackofficePassword(body);
    request[REQUEST_PERSISTENCE_HANDLED] = true;
    return ok(result, "密码已重置，请重新登录。");
  }

  @Post("backoffice-credentials")
  createBackofficeCredential(
    @Headers("authorization") authorization: string | undefined,
    @Body()
    body: {
      userId: string;
      username: string;
      password?: string;
      role?: BackofficeRole;
      tenantId?: string;
      permissions?: BackofficePermission[];
    }
  ) {
    return ok(
      this.authService.createBackofficeCredential(this.extractBearerToken(authorization), body),
      "后台账号已保存。"
    );
  }

  @Post("manual-verification-codes")
  issueManualVerificationCode(
    @Headers("authorization") authorization: string | undefined,
    @Body()
    body: {
      userId: string;
      purpose: "app-login" | "password-reset";
      code: string;
      expiresInSeconds?: number;
    }
  ) {
    return ok(
      this.authService.issueManualVerificationCode(
        this.extractBearerToken(authorization),
        body
      ),
      "一次性人工验证码已签发。"
    );
  }

  @Get("manual-verification-codes")
  manualVerificationCodes(
    @Headers("authorization") authorization?: string
  ) {
    return ok(
      this.authService.listManualVerificationCodes(
        this.extractBearerToken(authorization)
      )
    );
  }

  @Post("manual-verification-codes/:grantId/revoke")
  revokeManualVerificationCode(
    @Param("grantId") grantId: string,
    @Headers("authorization") authorization: string | undefined,
    @Body() body: { reason: string }
  ) {
    return ok(
      this.authService.revokeManualVerificationCode(
        this.extractBearerToken(authorization),
        grantId,
        body.reason
      ),
      "人工验证码已撤销。"
    );
  }

  @Post("backoffice-password-reset-as-super-admin")
  resetBackofficePasswordAsSuperAdmin(
    @Headers("authorization") authorization: string | undefined,
    @Body() body: { userId: string; role: BackofficeRole; newPassword: string; reason: string },
    @Req()
    request: {
      [REQUEST_PERSISTENCE_HANDLED]?: boolean;
    }
  ) {
    const result = this.authService.resetBackofficePasswordAsSuperAdmin(
      this.extractBearerToken(authorization),
      body
    );
    request[REQUEST_PERSISTENCE_HANDLED] = true;
    return ok(result, "密码已重置。");
  }

  @Get("backoffice-credentials")
  backofficeCredentials(@Headers("authorization") authorization?: string) {
    return ok(this.authService.listBackofficeCredentials(this.extractBearerToken(authorization)));
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
