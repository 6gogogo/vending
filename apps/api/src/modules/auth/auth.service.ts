import { BadRequestException, Inject, Injectable, UnauthorizedException } from "@nestjs/common";

import type {
  AppLoginResult,
  MobileLoginResult,
  MobileSessionSnapshot,
  RegistrationApplicationProfile,
  UserRecord,
  UserRole
} from "@vm/shared-types";

import { InMemoryStoreService } from "../../common/store/in-memory-store.service";
import { AccessRulesService } from "../access-rules/access-rules.service";
import { RegistrationApplicationsService } from "../registration-applications/registration-applications.service";
import { UsersService } from "../users/users.service";
import { VerificationCodeService } from "./verification-code.service";

@Injectable()
export class AuthService {
  constructor(
    @Inject(UsersService) private readonly usersService: UsersService,
    @Inject(AccessRulesService) private readonly accessRulesService: AccessRulesService,
    @Inject(RegistrationApplicationsService)
    private readonly registrationApplicationsService: RegistrationApplicationsService,
    @Inject(InMemoryStoreService) private readonly store: InMemoryStoreService,
    @Inject(VerificationCodeService)
    private readonly verificationCodeService: VerificationCodeService
  ) {}

  async requestCode(phone: string) {
    return this.verificationCodeService.requestCode(phone);
  }

  async appLogin(phone: string, code: string): Promise<AppLoginResult> {
    if (!(await this.verificationCodeService.verifyCode(phone, code))) {
      throw new UnauthorizedException("手机号或验证码不正确。");
    }

    const existingUser = this.store.users.find((entry) => entry.phone === phone && entry.status === "active");

    if (existingUser?.mobileProfileCompleted) {
      return {
        state: "approved",
        ...this.createSessionSnapshot(existingUser)
      };
    }

    const existingApplication = this.registrationApplicationsService.findLatestByPhone(phone);

    if (existingApplication?.status === "pending") {
      return {
        state: "pending_review",
        phone,
        application: existingApplication,
        message: "当前手机号资料正在审核中，审核通过前暂不能登录。"
      };
    }

    if (existingApplication?.status === "rejected") {
      return {
        state: "rejected",
        phone,
        application: existingApplication,
        message: existingApplication.reviewReason || "当前手机号审核未通过，请修改资料后重新提交。"
      };
    }

    return {
      state: "not_registered",
      phone,
      message: "当前手机号尚未登记或尚未通过审核，请先注册。"
    };
  }

  async mobileLogin(
    phone: string,
    code: string,
    requestedRole?: UserRole
  ): Promise<MobileLoginResult> {
    if (!(await this.verificationCodeService.verifyCode(phone, code))) {
      throw new UnauthorizedException("手机号或验证码不正确。");
    }

    const existingUser = this.store.users.find((entry) => entry.phone === phone && entry.status === "active");

    if (existingUser) {
      if (!existingUser.mobileProfileCompleted) {
        const draftToken = this.store.createDraftSession({
          phone,
          linkedUserId: existingUser.id,
          requestedRole: existingUser.role
        });

        return {
          state: "needs_profile",
          draft: {
            token: draftToken,
            phone,
            linkedUserId: existingUser.id,
            requestedRole: existingUser.role
          },
          phone,
          role: existingUser.role,
          profile: this.mapUserProfile(existingUser),
          isExistingUser: true
        };
      }

      return {
        state: "approved",
        ...this.createSessionSnapshot(existingUser)
      };
    }

    const existingApplication = this.registrationApplicationsService.findLatestByPhone(phone);
    const role = requestedRole ?? existingApplication?.requestedRole ?? "special";
    const draftToken = this.store.createDraftSession({
      phone,
      requestedRole: role,
      applicationId: existingApplication?.id
    });

    if (existingApplication?.status === "pending") {
      return {
        state: "pending_review",
        draft: {
          token: draftToken,
          phone,
          requestedRole: role,
          applicationId: existingApplication.id
        },
        application: existingApplication
      };
    }

    if (existingApplication?.status === "rejected") {
      return {
        state: "rejected",
        draft: {
          token: draftToken,
          phone,
          requestedRole: role,
          applicationId: existingApplication.id
        },
        application: existingApplication
      };
    }

    return {
      state: "needs_profile",
      draft: {
        token: draftToken,
        phone,
        requestedRole: role
      },
      phone,
      role,
      isExistingUser: false
    };
  }

  submitMobileProfile(payload: {
    draftToken: string;
    requestedRole?: UserRole;
    profile: RegistrationApplicationProfile;
  }): MobileLoginResult {
    const draft = this.store.getDraftSession(payload.draftToken);

    if (!draft) {
      throw new UnauthorizedException("当前资料草稿已失效，请重新获取验证码。");
    }

    if (draft.linkedUserId) {
      const user = this.store.users.find((entry) => entry.id === draft.linkedUserId);

      if (!user) {
        throw new UnauthorizedException("当前用户资料不存在，请重新登录。");
      }

      this.applyProfileToUser(user, payload.profile, user.role);
      user.mobileProfileCompleted = true;
      const snapshot = this.createSessionSnapshot(user);
      this.store.clearDraftSession(payload.draftToken);
      return {
        state: "approved",
        ...snapshot
      };
    }

    const application = this.registrationApplicationsService.upsertFromDraft(payload.draftToken, {
      requestedRole: payload.requestedRole,
      profile: payload.profile
    });
    const updatedDraft = this.store.getDraftSession(payload.draftToken);

    if (!updatedDraft) {
      throw new BadRequestException("资料草稿写入失败。");
    }

    return {
      state: "pending_review",
      draft: {
        token: updatedDraft.token,
        phone: updatedDraft.phone,
        requestedRole: updatedDraft.requestedRole,
        applicationId: updatedDraft.applicationId
      },
      application
    };
  }

  async login(phone: string, code: string) {
    const user = this.usersService.findByPhone(phone);

    if (!user || !(await this.verificationCodeService.verifyCode(phone, code))) {
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

  async adminLogin(phone: string, code: string) {
    const response = await this.login(phone, code);

    if (response.user.role !== "admin") {
      throw new UnauthorizedException("当前账号不是管理员，无法登录后台。");
    }

    return response;
  }

  getMobileSession(token?: string): MobileSessionSnapshot {
    const user = this.store.getSessionUser(token);

    if (!user) {
      throw new UnauthorizedException("当前登录态已失效，请重新登录。");
    }

    return this.createSessionSnapshot(user, token);
  }

  getAppSession(token?: string): MobileSessionSnapshot {
    return this.getMobileSession(token);
  }

  getAdminSession(token?: string) {
    const user = this.store.getSessionUser(token);

    if (!user || user.role !== "admin") {
      throw new UnauthorizedException("当前登录态已失效，请重新登录。");
    }

    return {
      token,
      user: {
        id: user.id,
        role: user.role,
        name: user.name,
        phone: user.phone,
        tags: user.tags
      }
    };
  }

  private createSessionSnapshot(user: UserRecord, token = this.store.createSession(user)): MobileSessionSnapshot {
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

  private applyProfileToUser(user: UserRecord, profile: RegistrationApplicationProfile, role: UserRole) {
    user.name = this.resolveDisplayName(role, profile);
    user.neighborhood = role === "special" ? profile.neighborhood : user.neighborhood;
    user.profile = {
      note: profile.note,
      contactName: profile.contactName,
      address: profile.address,
      organization: profile.organization,
      title: profile.title
    };

    if (role === "merchant") {
      user.merchantProfile = user.merchantProfile ?? {
        donationWindowDays: 2,
        defaultDeviceCodes: []
      };
    }
  }

  private mapUserProfile(user: UserRecord): RegistrationApplicationProfile {
    return {
      name: user.role === "merchant" ? (user.profile?.contactName || user.name) : user.name,
      neighborhood: user.neighborhood,
      note: user.profile?.note,
      merchantName: user.role === "merchant" ? user.name : undefined,
      contactName: user.profile?.contactName,
      address: user.profile?.address,
      organization: user.profile?.organization,
      title: user.profile?.title
    };
  }

  private resolveDisplayName(role: UserRole, profile: RegistrationApplicationProfile) {
    if (role === "merchant") {
      return profile.merchantName || profile.name || "爱心商户";
    }

    return profile.name || "待完善资料用户";
  }
}
