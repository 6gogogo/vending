import { Body, Controller, Inject, Post } from "@nestjs/common";

import { ok } from "../../common/dto/api-response";
import { AuthService } from "./auth.service";

@Controller("auth")
export class AuthController {
  constructor(@Inject(AuthService) private readonly authService: AuthService) {}

  @Post("request-code")
  requestCode(@Body() body: { phone: string }) {
    return ok(this.authService.requestCode(body.phone));
  }

  @Post("login")
  login(@Body() body: { phone: string; code: string }) {
    return ok(this.authService.login(body.phone, body.code));
  }
}
