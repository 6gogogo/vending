import { Inject, Injectable, UnauthorizedException } from "@nestjs/common";

import { InMemoryStoreService } from "../../common/store/in-memory-store.service";
import { AccessRulesService } from "../access-rules/access-rules.service";
import { UsersService } from "../users/users.service";

@Injectable()
export class AuthService {
  constructor(
    @Inject(UsersService) private readonly usersService: UsersService,
    @Inject(AccessRulesService) private readonly accessRulesService: AccessRulesService,
    @Inject(InMemoryStoreService) private readonly store: InMemoryStoreService
  ) {}

  requestCode(phone: string) {
    const user = this.usersService.findByPhone(phone);

    if (!user) {
      throw new UnauthorizedException("该手机号未登记。");
    }

    const code = this.store.issueVerificationCode(phone);

    return {
      phone,
      expiresInSeconds: 300,
      previewCode: code
    };
  }

  login(phone: string, code: string) {
    const user = this.usersService.findByPhone(phone);

    if (!user || !this.store.verifyCode(phone, code)) {
      throw new UnauthorizedException("手机号或验证码不正确。");
    }

    const token = this.store.createSession(user);

    return {
      token,
      user: {
        id: user.id,
        role: user.role,
        name: user.name,
        phone: user.phone,
        tags: user.tags
      },
      quota: this.accessRulesService.getQuotaSummaryForUser(user)
    };
  }
}
