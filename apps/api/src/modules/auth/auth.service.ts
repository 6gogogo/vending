import { BadRequestException, Inject, Injectable, UnauthorizedException } from "@nestjs/common";

import type {
  AppLoginResult,
  BackofficeRole,
  BackofficeSessionSnapshot,
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
import { hashAdminPassword, verifyAdminPassword } from "./admin-password.utils";
import { VerificationCodeService } from "./verification-code.service";

interface AdminSessionResult {
  token: string;
  user: {
    id: string;
    role: "admin";
    name: string;
    phone: string;
    tags: string[];
  };
  auth: {
    username: string;
    usesDefaultPassword: boolean;
    passwordUpdatedAt: string;
  };
}

type BackofficeSessionResult = BackofficeSessionSnapshot;

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

  async requestCode(phone: string, scene: "app-login" | "register" | "general" = "general") {
    if (scene === "app-login") {
      this.assertCanRequestAppLoginCode(phone);
    }

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
        // 已预登记用户优先走续填流程，尽量不让需要帮助的人重复填写整套资料。
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

      // 对已在库的人群，补齐资料后直接开通，减少再次等待人工审核带来的使用门槛。
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

    return this.createAdminSessionSnapshot(
      this.usersService.findById(response.user.id),
      response.token
    );
  }

  async adminPasswordLogin(username: string, password: string): Promise<AdminSessionResult> {
    const credential = this.store.findAdminCredentialByUsername(username);

    if (!credential) {
      throw new UnauthorizedException("账号或密码不正确。");
    }

    const user = this.store.users.find(
      (entry) => entry.id === credential.userId && entry.role === "admin" && entry.status === "active"
    );

    if (!user || !verifyAdminPassword(password, credential.passwordSalt, credential.passwordHash)) {
      throw new UnauthorizedException("账号或密码不正确。");
    }

    return this.createAdminSessionSnapshot(user);
  }

  async backofficeLogin(username: string, password: string): Promise<BackofficeSessionResult> {
    const credential = this.store.findBackofficeCredentialByUsername(username);

    if (!credential) {
      throw new UnauthorizedException("账号或密码不正确。");
    }

    const user = this.store.users.find(
      (entry) =>
        entry.id === credential.userId &&
        this.store.isUserValidForBackofficeRole(entry, credential.role)
    );

    if (!user || !verifyAdminPassword(password, credential.passwordSalt, credential.passwordHash)) {
      throw new UnauthorizedException("账号或密码不正确。");
    }

    return this.createBackofficeSessionSnapshot(user, credential.role);
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

  getAdminSession(token?: string): AdminSessionResult {
    const user = this.store.getSessionUser(token);

    if (!user || user.role !== "admin") {
      throw new UnauthorizedException("当前登录态已失效，请重新登录。");
    }

    return this.createAdminSessionSnapshot(user, token);
  }

  getBackofficeSession(token?: string): BackofficeSessionResult {
    const resolved = this.store.getBackofficeSessionUser(token);

    if (resolved) {
      const backofficeRole = resolved.session.backofficeRole;

      if (!backofficeRole) {
        throw new UnauthorizedException("当前登录态已失效，请重新登录。");
      }

      return this.createBackofficeSessionSnapshot(
        resolved.user,
        backofficeRole,
        token
      );
    }

    const user = this.store.getSessionUser(token);

    if (user?.role === "admin") {
      return this.createBackofficeSessionSnapshot(user, "super_admin", token);
    }

    throw new UnauthorizedException("当前登录态已失效，请重新登录。");
  }

  changeAdminPassword(token: string | undefined, currentPassword: string, newPassword: string): AdminSessionResult {
    const user = this.store.getSessionUser(token);

    if (!user || user.role !== "admin") {
      throw new UnauthorizedException("当前登录态已失效，请重新登录。");
    }

    const credential = this.store.findAdminCredentialByUserId(user.id);

    if (!credential) {
      throw new UnauthorizedException("当前管理员账号未配置登录凭证。");
    }

    if (!verifyAdminPassword(currentPassword, credential.passwordSalt, credential.passwordHash)) {
      throw new UnauthorizedException("当前密码不正确。");
    }

    const normalizedPassword = newPassword.trim();

    if (normalizedPassword.length < 6) {
      throw new BadRequestException("新密码至少需要 6 位。");
    }

    if (normalizedPassword === currentPassword.trim()) {
      throw new BadRequestException("新密码不能与当前密码相同。");
    }

    const hashedPassword = hashAdminPassword(normalizedPassword);
    const updatedCredential = this.store.upsertAdminCredential({
      ...credential,
      passwordSalt: hashedPassword.salt,
      passwordHash: hashedPassword.hash,
      usesDefaultPassword: false,
      passwordUpdatedAt: new Date().toISOString()
    });

    this.store.logOperation({
      category: "admin",
      type: "change-admin-password",
      status: "success",
      actor: {
        type: "admin",
        id: user.id,
        name: user.name,
        role: user.role
      },
      primarySubject: {
        type: "user",
        id: user.id,
        label: user.name
      },
      metadata: {
        username: updatedCredential.username,
        undoState: "not_undoable"
      }
    });

    return this.createAdminSessionSnapshot(user, token, updatedCredential);
  }

  changeBackofficePassword(
    token: string | undefined,
    currentPassword: string,
    newPassword: string
  ): BackofficeSessionResult {
    const resolved = this.store.getBackofficeSessionUser(token);

    if (!resolved) {
      throw new UnauthorizedException("当前登录态已失效，请重新登录。");
    }

    const backofficeRole = resolved.session.backofficeRole;

    if (!backofficeRole) {
      throw new UnauthorizedException("当前登录态已失效，请重新登录。");
    }

    const credential = this.store.findBackofficeCredentialByUserId(
      resolved.user.id,
      backofficeRole
    );

    if (!credential) {
      throw new UnauthorizedException("当前后台账号未配置登录凭证。");
    }

    if (!verifyAdminPassword(currentPassword, credential.passwordSalt, credential.passwordHash)) {
      throw new UnauthorizedException("当前密码不正确。");
    }

    const normalizedPassword = newPassword.trim();

    if (normalizedPassword.length < 6) {
      throw new BadRequestException("新密码至少需要 6 位。");
    }

    if (normalizedPassword === currentPassword.trim()) {
      throw new BadRequestException("新密码不能与当前密码相同。");
    }

    const hashedPassword = hashAdminPassword(normalizedPassword);
    const updatedCredential = this.store.upsertBackofficeCredential({
      ...credential,
      passwordSalt: hashedPassword.salt,
      passwordHash: hashedPassword.hash,
      usesDefaultPassword: false,
      passwordUpdatedAt: new Date().toISOString()
    });

    this.store.logOperation({
      category: "admin",
      type: "change-backoffice-password",
      status: "success",
      actor: {
        type: resolved.user.role,
        id: resolved.user.id,
        name: resolved.user.name,
        role: resolved.user.role
      },
      primarySubject: {
        type: "user",
        id: resolved.user.id,
        label: resolved.user.name
      },
      metadata: {
        username: updatedCredential.username,
        backofficeRole: updatedCredential.role,
        undoState: "not_undoable"
      }
    });

    return this.createBackofficeSessionSnapshot(
      resolved.user,
      backofficeRole,
      token,
      updatedCredential
    );
  }

  createBackofficeCredential(
    token: string | undefined,
    payload: {
      userId: string;
      username: string;
      password: string;
      role?: BackofficeRole;
    }
  ) {
    const actor = this.getBackofficeSession(token);

    if (actor.user.backofficeRole !== "super_admin") {
      throw new UnauthorizedException("只有超级管理员可以发放后台账号。");
    }

    const targetUser = this.store.users.find((entry) => entry.id === payload.userId);
    const role = payload.role ?? (targetUser?.role === "merchant" ? "merchant" : "super_admin");

    if (!targetUser || !this.store.isUserValidForBackofficeRole(targetUser, role)) {
      throw new BadRequestException("目标用户不能开通该后台角色。");
    }

    const normalizedUsername = payload.username.trim().toLowerCase();
    const normalizedPassword = payload.password.trim();

    if (!normalizedUsername) {
      throw new BadRequestException("后台账号不能为空。");
    }

    if (normalizedPassword.length < 6) {
      throw new BadRequestException("后台密码至少需要 6 位。");
    }

    const sameUsername = this.store.findBackofficeCredentialByUsername(normalizedUsername);

    if (sameUsername && sameUsername.userId !== targetUser.id) {
      throw new BadRequestException("后台账号已被占用。");
    }

    const hashedPassword = hashAdminPassword(normalizedPassword);
    const credential = this.store.upsertBackofficeCredential({
      userId: targetUser.id,
      username: normalizedUsername,
      role,
      passwordSalt: hashedPassword.salt,
      passwordHash: hashedPassword.hash,
      usesDefaultPassword: false,
      passwordUpdatedAt: new Date().toISOString()
    });

    this.store.logOperation({
      category: "admin",
      type: "upsert-backoffice-credential",
      status: "success",
      actor: {
        type: "admin",
        id: actor.user.id,
        name: actor.user.name,
        role: "admin"
      },
      primarySubject: {
        type: "user",
        id: targetUser.id,
        label: targetUser.name
      },
      metadata: {
        username: credential.username,
        backofficeRole: credential.role,
        undoState: "not_undoable"
      }
    });

    return {
      userId: credential.userId,
      username: credential.username,
      role: credential.role,
      usesDefaultPassword: credential.usesDefaultPassword,
      passwordUpdatedAt: credential.passwordUpdatedAt
    };
  }

  private createAdminSessionSnapshot(
    user: UserRecord,
    token = this.store.createSession(user),
    credential = this.store.findAdminCredentialByUserId(user.id)
  ): AdminSessionResult {
    if (!credential) {
      throw new UnauthorizedException("当前管理员账号未配置登录凭证。");
    }

    return {
      token,
      user: {
        id: user.id,
        role: "admin",
        name: user.name,
        phone: user.phone,
        tags: user.tags
      },
      auth: {
        username: credential.username,
        usesDefaultPassword: credential.usesDefaultPassword,
        passwordUpdatedAt: credential.passwordUpdatedAt
      }
    };
  }

  private createBackofficeSessionSnapshot(
    user: UserRecord,
    backofficeRole: BackofficeRole,
    token = this.store.createBackofficeSession(user, backofficeRole),
    credential = this.store.findBackofficeCredentialByUserId(user.id, backofficeRole)
  ): BackofficeSessionResult {
    if (!credential) {
      throw new UnauthorizedException("当前后台账号未配置登录凭证。");
    }

    if (backofficeRole === "super_admin" && user.role !== "admin") {
      throw new UnauthorizedException("当前账号不是超级管理员，无法登录后台。");
    }

    if (backofficeRole === "merchant" && user.role !== "merchant") {
      throw new UnauthorizedException("当前账号不是商家，无法登录商家后台。");
    }

    return {
      token,
      user: {
        id: user.id,
        role: user.role as Extract<UserRole, "admin" | "merchant">,
        backofficeRole,
        name: user.name,
        phone: user.phone,
        tags: user.tags
      },
      auth: {
        username: credential.username,
        usesDefaultPassword: credential.usesDefaultPassword,
        passwordUpdatedAt: credential.passwordUpdatedAt
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

  private assertCanRequestAppLoginCode(phone: string) {
    const existingUser = this.store.users.find((entry) => entry.phone === phone && entry.status === "active");

    if (existingUser?.mobileProfileCompleted) {
      return;
    }

    const existingApplication = this.registrationApplicationsService.findLatestByPhone(phone);

    if (existingApplication?.status === "pending") {
      throw new BadRequestException("请等待审核");
    }

    throw new BadRequestException("请注册");
  }
}
