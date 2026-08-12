import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  HttpException,
  Inject,
  Injectable,
  NotFoundException,
  UnauthorizedException
} from "@nestjs/common";
import { ConfigService } from "@nestjs/config";

import type {
  AppLoginResult,
  BackofficeCredentialSnapshot,
  BackofficePermission,
  BackofficeRole,
  BackofficeSessionSnapshot,
  ManualVerificationGrantSnapshot,
  ManualVerificationGrantStatus,
  ManualVerificationPurpose,
  MobileLoginResult,
  MobileSessionSnapshot,
  RegistrationApplicationProfile,
  UserRecord,
  UserRole
} from "@vm/shared-types";
import {
  BACKOFFICE_ROLE_ALLOWED_PERMISSIONS,
  BACKOFFICE_ROLE_DEFAULT_PERMISSIONS,
  MANUAL_VERIFICATION_TTL_DEFAULT_SECONDS,
  MANUAL_VERIFICATION_TTL_MAX_SECONDS,
  MANUAL_VERIFICATION_TTL_MIN_SECONDS,
  resolveBackofficePermissions
} from "@vm/shared-types";

import { InMemoryStoreService } from "../../common/store/in-memory-store.service";
import type { ManualVerificationGrantRecord } from "../../common/store/persistence";
import { AccessRulesService } from "../access-rules/access-rules.service";
import { RegistrationApplicationsService } from "../registration-applications/registration-applications.service";
import { UsersService } from "../users/users.service";
import { hashAdminPassword, verifyAdminPassword } from "./admin-password.utils";
import {
  getBackofficePasswordMinimumLength,
  MIN_STANDARD_BACKOFFICE_PASSWORD_LENGTH
} from "./backoffice-password-policy";
import {
  VerificationCodeService,
  type VerificationCodeCheckResult
} from "./verification-code.service";

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
const MIN_ADMIN_PASSWORD_LENGTH = MIN_STANDARD_BACKOFFICE_PASSWORD_LENGTH;
const MAX_MANUAL_VERIFICATION_FAILURES = 5;

@Injectable()
export class AuthService {
  private readonly passwordLoginFailureHistory = new Map<string, number[]>();

  constructor(
    @Inject(UsersService) private readonly usersService: UsersService,
    @Inject(AccessRulesService) private readonly accessRulesService: AccessRulesService,
    @Inject(RegistrationApplicationsService)
    private readonly registrationApplicationsService: RegistrationApplicationsService,
    @Inject(InMemoryStoreService) private readonly store: InMemoryStoreService,
    @Inject(VerificationCodeService)
    private readonly verificationCodeService: VerificationCodeService,
    @Inject(ConfigService) private readonly configService: ConfigService
  ) {}

  async requestCode(
    phone: string,
    scene: "app-login" | "register" | "general" | "password-reset" = "general",
    username?: string
  ) {
    if (scene === "password-reset") {
      const target = this.resolveBackofficePasswordResetTarget(username, phone);
      if (!target) {
        return this.verificationCodeService.describeCodeRequest(phone);
      }
    }

    return this.verificationCodeService.requestCode(phone, scene);
  }

  async appLogin(
    phone: string,
    code: string,
    requestHostname?: string
  ): Promise<AppLoginResult> {
    const tenantId =
      this.registrationApplicationsService.resolvePublicTenantId(
        requestHostname
      );
    const verification = await this.verifyCodeWithContext(
      phone,
      code,
      "app-login"
    );

    if (!verification.verified) {
      throw new UnauthorizedException("验证码不正确或已失效，请重新获取。");
    }

    const normalizedPhone = phone.trim();
    if (verification.tenantId && verification.tenantId !== tenantId) {
      throw new UnauthorizedException("验证码不正确或已失效，请重新获取。");
    }
    const uniqueActiveUser = verification.targetUserId
      ? undefined
      : this.findUniqueActiveUserByPhone(normalizedPhone);
    const existingUser = verification.targetUserId
      ? this.store.users.find(
          (entry) =>
            entry.id === verification.targetUserId &&
            entry.phone === normalizedPhone &&
            entry.status === "active" &&
            this.store.getUserTenantId(entry) === tenantId &&
            (!verification.tenantId ||
              this.store.getUserTenantId(entry) === verification.tenantId)
        )
      : uniqueActiveUser &&
          this.store.getUserTenantId(uniqueActiveUser) === tenantId
        ? uniqueActiveUser
        : undefined;

    if (verification.targetUserId && !existingUser) {
      throw new UnauthorizedException("验证码不正确或已失效，请重新获取。");
    }

    if (existingUser?.mobileProfileCompleted) {
      return {
        state: "approved",
        ...this.createSessionSnapshot(existingUser)
      };
    }

    const existingApplication = verification.targetUserId
      ? undefined
      : this.registrationApplicationsService.findLatestByPhone(
          phone,
          tenantId
        );

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
    requestedRole?: UserRole,
    requestHostname?: string
  ): Promise<MobileLoginResult> {
    const tenantId =
      this.registrationApplicationsService.resolvePublicTenantId(
        requestHostname
      );

    if (!(await this.verificationCodeService.verifyCode(phone, code, "general"))) {
      throw new UnauthorizedException("手机号或验证码不正确。");
    }

    const uniqueActiveUser = this.findUniqueActiveUserByPhone(phone.trim());
    const existingUser =
      uniqueActiveUser &&
      this.store.getUserTenantId(uniqueActiveUser) === tenantId
        ? uniqueActiveUser
        : undefined;

    if (existingUser) {
      if (!existingUser.mobileProfileCompleted) {
        // 已预登记用户优先走续填流程，尽量不让需要帮助的人重复填写整套资料。
        const draftToken = this.store.createDraftSession({
          tenantId,
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

    const existingApplication =
      this.registrationApplicationsService.findLatestByPhone(phone, tenantId);
    const role = requestedRole ?? existingApplication?.requestedRole ?? "special";
    const draftToken = this.store.createDraftSession({
      tenantId,
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
  }, requestHostname?: string): MobileLoginResult {
    const tenantId =
      this.registrationApplicationsService.resolvePublicTenantId(requestHostname);
    const draft = this.store.getDraftSession(payload.draftToken);

    if (!draft) {
      throw new UnauthorizedException("当前资料草稿已失效，请重新获取验证码。");
    }

    if (draft.tenantId !== tenantId) {
      throw new UnauthorizedException(
        "当前资料草稿与访问实例不一致，请重新获取验证码。"
      );
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

    if (!user || !(await this.verificationCodeService.verifyCode(phone, code, "general"))) {
      throw new UnauthorizedException("手机号或验证码不正确。");
    }

    this.assertTenantOperational(this.store.getUserTenantId(user));
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
      this.store.revokeSession(response.token);
      throw new UnauthorizedException("当前账号不是管理员，无法登录后台。");
    }

    try {
      return this.createAdminSessionSnapshot(
        this.usersService.findById(response.user.id),
        response.token
      );
    } catch (error) {
      this.store.revokeSession(response.token);
      throw error;
    }
  }

  async adminPasswordLogin(
    username: string,
    password: string,
    sourceKey = "unknown"
  ): Promise<AdminSessionResult> {
    if (this.store.isLiveDataPlane()) {
      throw new UnauthorizedException("真实数据平面不支持旧管理员密码登录入口。");
    }

    this.assertPasswordLoginAllowed(username, sourceKey);
    const credential = this.store.findAdminCredentialByUsername(username);

    if (!credential) {
      this.recordPasswordLoginFailure(username, sourceKey);
      throw new UnauthorizedException("账号或密码不正确。");
    }

    const user = this.store.users.find(
      (entry) => entry.id === credential.userId && entry.role === "admin" && entry.status === "active"
    );

    if (!user || !verifyAdminPassword(password, credential.passwordSalt, credential.passwordHash)) {
      this.recordPasswordLoginFailure(username, sourceKey);
      throw new UnauthorizedException("账号或密码不正确。");
    }

    this.assertDefaultCredentialAllowed(credential.usesDefaultPassword);
    this.assertTenantOperational(this.store.getUserTenantId(user));
    this.clearPasswordLoginAccountFailures(username);

    return this.createAdminSessionSnapshot(user);
  }

  async backofficeLogin(
    username: string,
    password: string,
    sourceKey = "unknown"
  ): Promise<BackofficeSessionResult> {
    this.assertPasswordLoginAllowed(username, sourceKey);
    const credential = this.store.findBackofficeCredentialByUsername(username);
    const normalizedPassword = password.trim();

    if (!credential) {
      this.recordPasswordLoginFailure(username, sourceKey);
      throw new UnauthorizedException("账号或密码不正确。");
    }

    const user = this.store.users.find(
      (entry) =>
        entry.id === credential.userId &&
        this.store.isBackofficeCredentialValidForUser(entry, credential)
    );

    if (
      !user ||
      !verifyAdminPassword(
        normalizedPassword,
        credential.passwordSalt,
        credential.passwordHash
      )
    ) {
      this.recordPasswordLoginFailure(username, sourceKey);
      throw new UnauthorizedException("账号或密码不正确。");
    }

    this.assertDefaultCredentialAllowed(credential.usesDefaultPassword);
    this.assertTenantOperational(credential.tenantId);
    this.clearPasswordLoginAccountFailures(username);

    return this.createBackofficeSessionSnapshot(user, credential.role, undefined, credential);
  }

  private assertPasswordLoginAllowed(username: string, sourceKey: string) {
    const now = Date.now();
    const windowMs = 15 * 60_000;
    const limits = [
      { key: this.passwordLoginIpKey(sourceKey), limit: 10 },
      { key: this.passwordLoginAccountKey(username), limit: 5 }
    ];

    for (const entry of limits) {
      const recent = (this.passwordLoginFailureHistory.get(entry.key) ?? []).filter(
        (timestamp) => now - timestamp < windowMs
      );
      this.passwordLoginFailureHistory.set(entry.key, recent);

      if (recent.length >= entry.limit) {
        throw new HttpException("登录失败次数过多，请稍后再试。", 429);
      }
    }
  }

  private recordPasswordLoginFailure(username: string, sourceKey: string) {
    const timestamp = Date.now();

    for (const key of [
      this.passwordLoginIpKey(sourceKey),
      this.passwordLoginAccountKey(username)
    ]) {
      const history = this.passwordLoginFailureHistory.get(key) ?? [];
      history.push(timestamp);
      this.passwordLoginFailureHistory.set(key, history);
    }
  }

  private clearPasswordLoginAccountFailures(username: string) {
    this.passwordLoginFailureHistory.delete(this.passwordLoginAccountKey(username));
  }

  private passwordLoginIpKey(sourceKey: string) {
    return `ip:${sourceKey.trim() || "unknown"}`;
  }

  private passwordLoginAccountKey(username: string) {
    return `account:${username.trim().toLowerCase() || "unknown"}`;
  }

  private assertDefaultCredentialAllowed(usesDefaultPassword: boolean) {
    if (!usesDefaultPassword) {
      return;
    }

    const explicit = this.configService.get<string>("ALLOW_DEFAULT_BACKOFFICE_LOGIN")?.trim().toLowerCase();
    const allowed = ["1", "true", "yes", "on"].includes(explicit ?? "");

    if (!allowed) {
      throw new UnauthorizedException("默认后台密码不可用于当前环境，请先修改后台密码。");
    }
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

  logout(token?: string) {
    return {
      revoked: this.store.revokeSession(token)
    };
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

    throw new UnauthorizedException("当前登录态已失效，请重新登录。");
  }

  enterPlatformTenant(token: string | undefined, tenantId: string): BackofficeSessionResult {
    const resolved = this.store.getBackofficeSessionUser(token);

    if (!resolved || resolved.session.backofficeRole !== "super_admin") {
      throw new UnauthorizedException("当前登录态已失效，请重新登录。");
    }

    if (resolved.session.tenantId) {
      throw new BadRequestException("当前已进入客户实例，请先退出后再切换。");
    }

    const tenant = this.store.findPlatformTenantById(tenantId);

    if (!tenant) {
      throw new NotFoundException("未找到对应客户实例。");
    }

    if (tenant.status === "paused") {
      throw new ForbiddenException("目标客户实例已暂停，暂不能进入。");
    }

    if (
      tenant.serviceMode === "production" &&
      (!this.store.isLiveDataPlane() || tenant.status !== "active")
    ) {
      throw new ConflictException(
        "正式服务实例需完成生产开通并在真实数据平面运行后才能进入。"
      );
    }

    const nextToken = this.store.createBackofficeSession(
      resolved.user,
      "super_admin",
      tenant.id
    );
    const snapshot = this.createBackofficeSessionSnapshot(
      resolved.user,
      "super_admin",
      nextToken
    );
    this.store.revokeSession(token);

    return snapshot;
  }

  exitPlatformTenant(token: string | undefined): BackofficeSessionResult {
    const resolved = this.store.getBackofficeSessionUser(token);

    if (
      !resolved ||
      resolved.session.backofficeRole !== "super_admin" ||
      !resolved.session.tenantId
    ) {
      throw new UnauthorizedException("当前未进入客户实例。");
    }

    const nextToken = this.store.createBackofficeSession(
      resolved.user,
      "super_admin",
      undefined
    );
    const snapshot = this.createBackofficeSessionSnapshot(
      resolved.user,
      "super_admin",
      nextToken
    );
    this.store.revokeSession(token);

    return snapshot;
  }

  changeAdminPassword(token: string | undefined, currentPassword: string, newPassword: string): AdminSessionResult {
    if (this.store.isLiveDataPlane()) {
      throw new UnauthorizedException("真实数据平面不支持旧管理员密码入口。");
    }

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

    const minimumPasswordLength = getBackofficePasswordMinimumLength({
      username: credential.username,
      role: user.role
    });

    if (normalizedPassword.length < minimumPasswordLength) {
      throw new BadRequestException(`新密码至少需要 ${minimumPasswordLength} 位。`);
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

    this.store.revokeSessionsForUser(user.id);
    return this.createAdminSessionSnapshot(user, this.store.createSession(user), updatedCredential);
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

    const minimumPasswordLength = getBackofficePasswordMinimumLength(credential);

    if (normalizedPassword.length < minimumPasswordLength) {
      throw new BadRequestException(`新密码至少需要 ${minimumPasswordLength} 位。`);
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

    this.store.revokeSessionsForUser(resolved.user.id);
    const refreshedToken = this.store.createBackofficeSession(
      resolved.user,
      backofficeRole,
      updatedCredential.tenantId
    );

    return this.createBackofficeSessionSnapshot(
      resolved.user,
      backofficeRole,
      refreshedToken,
      updatedCredential
    );
  }

  issueManualVerificationCode(
    token: string | undefined,
    payload: {
      userId: string;
      purpose: ManualVerificationPurpose;
      code: string;
      expiresInSeconds?: number;
    }
  ): ManualVerificationGrantSnapshot {
    const actor = this.getBackofficeSession(token);
    this.assertCanManageManualVerificationCodes(actor.user);
    const tenantId =
      actor.user.tenantId ?? this.store.getDefaultTenantId();
    const targetUser = this.store.users.find(
      (entry) =>
        entry.id === payload.userId &&
        entry.status === "active" &&
        this.store.getUserTenantId(entry) === tenantId
    );

    if (!targetUser) {
      throw new NotFoundException("未找到当前实例中的有效目标账号。");
    }

    if (
      payload.purpose !== "app-login" &&
      payload.purpose !== "password-reset"
    ) {
      throw new BadRequestException("人工验证码用途不受支持。");
    }

    if (payload.purpose === "app-login" && !targetUser.mobileProfileCompleted) {
      throw new BadRequestException(
        "目标账号尚未完成资料审核，不能签发 APP 登录人工验证码。"
      );
    }

    const code = String(payload.code ?? "").trim();

    if (!/^\d{6}$/u.test(code)) {
      throw new BadRequestException("人工验证码必须是 6 位数字。");
    }

    const expiresInSeconds =
      payload.expiresInSeconds ?? MANUAL_VERIFICATION_TTL_DEFAULT_SECONDS;

    if (
      !Number.isInteger(expiresInSeconds) ||
      expiresInSeconds < MANUAL_VERIFICATION_TTL_MIN_SECONDS ||
      expiresInSeconds > MANUAL_VERIFICATION_TTL_MAX_SECONDS
    ) {
      throw new BadRequestException("人工验证码有效期必须在 1 分钟至 30 天之间。");
    }

    const record = this.store.issueManualVerificationGrant({
      phone: targetUser.phone,
      purpose: payload.purpose,
      code,
      issuerUserId: actor.user.id,
      targetUserId: targetUser.id,
      tenantId,
      expiresInSeconds
    });

    this.store.logOperation({
      category: "admin",
      type: "issue-manual-verification-code",
      status: "success",
      actor: {
        type: actor.user.role,
        id: actor.user.id,
        name: actor.user.name,
        role: actor.user.role
      },
      primarySubject: {
        type: "user",
        id: targetUser.id,
        label: targetUser.name
      },
      metadata: {
        manualGrantId: record.manualGrantId,
        tenantId,
        purpose: record.purpose,
        phoneHash: record.phoneHash,
        expiresAt: record.expiresAt,
        undoState: "not_undoable"
      }
    });
    this.store.persist();

    return this.createManualVerificationGrantSnapshot(record);
  }

  listManualVerificationCodes(
    token: string | undefined
  ): ManualVerificationGrantSnapshot[] {
    const actor = this.getBackofficeSession(token);
    this.assertCanManageManualVerificationCodes(actor.user);
    const tenantId =
      actor.user.tenantId ?? this.store.getDefaultTenantId();

    return this.store
      .listManualVerificationGrants(tenantId)
      .map((record) => this.createManualVerificationGrantSnapshot(record));
  }

  revokeManualVerificationCode(
    token: string | undefined,
    grantId: string,
    reason: string
  ): ManualVerificationGrantSnapshot {
    const actor = this.getBackofficeSession(token);
    this.assertCanManageManualVerificationCodes(actor.user);
    const normalizedReason = String(reason ?? "").trim();

    if (!normalizedReason || [...normalizedReason].length > 500) {
      throw new BadRequestException("撤销原因不能为空且不能超过 500 个字符。");
    }

    const tenantId =
      actor.user.tenantId ?? this.store.getDefaultTenantId();
    const record = this.store.revokeManualVerificationGrant(
      grantId,
      tenantId
    );

    if (!record) {
      throw new NotFoundException("未找到可撤销的人工验证码。");
    }

    const targetUser = record.targetUserId
      ? this.store.users.find((entry) => entry.id === record.targetUserId)
      : undefined;
    this.store.logOperation({
      category: "admin",
      type: "revoke-manual-verification-code",
      status: "success",
      actor: {
        type: actor.user.role,
        id: actor.user.id,
        name: actor.user.name,
        role: actor.user.role
      },
      primarySubject: targetUser
        ? {
            type: "user",
            id: targetUser.id,
            label: targetUser.name
          }
        : undefined,
      metadata: {
        manualGrantId: record.manualGrantId,
        tenantId,
        purpose: record.purpose,
        reason: normalizedReason,
        undoState: "not_undoable"
      }
    });
    this.store.persist();

    return this.createManualVerificationGrantSnapshot(record);
  }

  clearManualVerificationCode(
    token: string | undefined,
    grantId: string
  ): ManualVerificationGrantSnapshot {
    const actor = this.getBackofficeSession(token);
    this.assertCanManageManualVerificationCodes(actor.user);
    const tenantId =
      actor.user.tenantId ?? this.store.getDefaultTenantId();
    const result = this.store.clearTerminalManualVerificationGrant(
      grantId,
      tenantId
    );

    if (result.state === "missing") {
      throw new NotFoundException("未找到可清除的人工验证码记录。");
    }
    if (result.state === "active") {
      throw new ConflictException("验证码仍可使用，请先撤销后再清除记录。");
    }

    const targetUser = result.record.targetUserId
      ? this.store.users.find((entry) => entry.id === result.record.targetUserId)
      : undefined;
    const snapshot = this.createManualVerificationGrantSnapshot(result.record);
    this.store.logOperation({
      category: "admin",
      type: "clear-manual-verification-code-record",
      status: "success",
      actor: {
        type: actor.user.role,
        id: actor.user.id,
        name: actor.user.name,
        role: actor.user.role
      },
      primarySubject: targetUser
        ? {
            type: "user",
            id: targetUser.id,
            label: targetUser.name
          }
        : undefined,
      metadata: {
        manualGrantId: result.record.manualGrantId,
        tenantId,
        purpose: result.record.purpose,
        terminalStatus: snapshot.status,
        undoState: "not_undoable"
      }
    });
    this.store.persist();

    return snapshot;
  }

  clearManualVerificationCodes(
    token: string | undefined,
    payload: { grantIds: string[]; confirmedCount: number }
  ) {
    const actor = this.getBackofficeSession(token);
    this.assertCanManageManualVerificationCodes(actor.user);
    if (!Array.isArray(payload?.grantIds) || payload.grantIds.length < 1 || payload.grantIds.length > 200) {
      throw new BadRequestException("批量清除记录必须选择 1 至 200 项。");
    }
    const grantIds = payload.grantIds.map((grantId) => String(grantId ?? "").trim());
    if (grantIds.some((grantId) => !grantId) || new Set(grantIds).size !== grantIds.length) {
      throw new BadRequestException("批量清除记录中存在空编号或重复编号。");
    }
    if (!Number.isInteger(payload.confirmedCount) || payload.confirmedCount !== grantIds.length) {
      throw new BadRequestException("批量清除确认数量必须与所选记录数一致。");
    }

    const tenantId = actor.user.tenantId ?? this.store.getDefaultTenantId();
    const result = this.store.clearTerminalManualVerificationGrants(grantIds, tenantId);
    if (result.state === "missing") {
      throw new NotFoundException("部分人工验证码记录不存在或不属于当前实例。");
    }
    if (result.state === "active") {
      throw new ConflictException("所选记录中包含仍可使用的验证码，请先撤销后再批量清除。");
    }

    const cleared = result.records.map((record) => this.createManualVerificationGrantSnapshot(record));
    this.store.logOperation({
      category: "admin",
      type: "batch-clear-manual-verification-code-records",
      status: "success",
      actor: {
        type: actor.user.role,
        id: actor.user.id,
        name: actor.user.name,
        role: actor.user.role
      },
      metadata: {
        tenantId,
        count: cleared.length,
        manualGrantIds: cleared.map((entry) => entry.id),
        terminalStatuses: cleared.map((entry) => entry.status),
        undoState: "not_undoable"
      }
    });
    this.store.persist();
    return { count: cleared.length, cleared };
  }

  async resetOwnBackofficePassword(payload: {
    username: string;
    phone: string;
    code: string;
    newPassword: string;
  }) {
    const normalizedUsername = payload.username.trim().toLowerCase();
    const normalizedPassword = payload.newPassword.trim();
    const target = this.resolveBackofficePasswordResetTarget(
      normalizedUsername,
      payload.phone
    );
    const minimumPasswordLength = target
      ? getBackofficePasswordMinimumLength(target.credential)
      : MIN_STANDARD_BACKOFFICE_PASSWORD_LENGTH;

    if (!normalizedUsername || normalizedPassword.length < minimumPasswordLength) {
      throw new BadRequestException(
        `新密码至少需要 ${minimumPasswordLength} 位。`
      );
    }

    if (!target) {
      throw new UnauthorizedException("账号、手机号或验证码不正确。");
    }

    const { credential, user } = target;

    const verification = await this.checkCodeWithContext(
      payload.phone,
      payload.code,
      "password-reset"
    );

    if (
      !verification.verified ||
      (verification.targetUserId !== undefined &&
        verification.targetUserId !== user.id) ||
      (verification.tenantId !== undefined &&
        (credential.tenantId !== verification.tenantId ||
          this.store.getUserTenantId(user) !== verification.tenantId))
    ) {
      throw new UnauthorizedException("账号、手机号或验证码不正确。");
    }

    if (verifyAdminPassword(normalizedPassword, credential.passwordSalt, credential.passwordHash)) {
      throw new BadRequestException("新密码不能与当前密码相同。");
    }

    const passwordHash = hashAdminPassword(normalizedPassword);
    this.store.runBackofficePasswordResetTransaction(() => {
      if (
        !this.consumeCheckedCode(
          payload.phone,
          "password-reset",
          verification,
          { persist: false }
        )
      ) {
        throw new UnauthorizedException("账号、手机号或验证码不正确。");
      }

      const updatedCredential = this.store.upsertBackofficeCredential({
        ...credential,
        passwordSalt: passwordHash.salt,
        passwordHash: passwordHash.hash,
        usesDefaultPassword: false,
        passwordUpdatedAt: new Date().toISOString()
      });

      this.store.logOperation({
        category: "admin",
        type: "reset-backoffice-password-by-owner",
        status: "success",
        actor: {
          type: user.role,
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
          backofficeRole: updatedCredential.role,
          resetMethod: "phone-verification",
          undoState: "not_undoable"
        }
      });

      this.store.revokeSessionsForUser(user.id);
    });
    this.clearPasswordLoginAccountFailures(normalizedUsername);

    return { reset: true };
  }

  private resolveBackofficePasswordResetTarget(
    username: string | undefined,
    phone: string
  ) {
    const normalizedUsername = username?.trim().toLowerCase() ?? "";
    const normalizedPhone = phone.trim();
    if (!normalizedUsername || !normalizedPhone) {
      return undefined;
    }

    const matches = this.store.backofficeCredentials.flatMap((credential) => {
      if (credential.username.trim().toLowerCase() !== normalizedUsername) {
        return [];
      }

      const user = this.store.users.find((entry) => entry.id === credential.userId);
      if (
        !user ||
        !this.store.isBackofficeCredentialValidForUser(user, credential)
      ) {
        return [];
      }

      return [{ credential, user }];
    });

    if (matches.length !== 1) {
      return undefined;
    }

    const [target] = matches;
    if (
      target.credential.role === "super_admin" ||
      target.user.status !== "active" ||
      target.user.phone !== normalizedPhone
    ) {
      return undefined;
    }

    return target;
  }

  createBackofficeCredential(
    token: string | undefined,
    payload: {
      userId: string;
      username: string;
      password?: string;
      role?: BackofficeRole;
      tenantId?: string;
      permissions?: BackofficePermission[];
    }
  ) {
    const actor = this.getBackofficeSession(token);

    if (!actor.user.permissions.includes("backoffice-credentials:manage")) {
      throw new ForbiddenException("当前后台账号不能管理后台登录权限。");
    }

    const targetUser = this.store.users.find((entry) => entry.id === payload.userId);
    const role =
      payload.role ??
      (targetUser?.role === "merchant"
        ? "merchant"
        : targetUser?.role === "restocker"
          ? "restocker"
          : "admin");

    if (!targetUser || !this.store.isUserValidForBackofficeRole(targetUser, role)) {
      throw new BadRequestException("目标用户不能开通该后台角色。");
    }

    const actorTenantId = actor.user.tenantId;

    if (
      actorTenantId &&
      this.store.getUserTenantId(targetUser) !== actorTenantId
    ) {
      throw new ForbiddenException("当前后台账号不能管理其他实例的后台账号。");
    }

    const existingCredential = this.store.findBackofficeCredentialByUserId(targetUser.id, role);
    const existingPermissions = existingCredential
      ? this.store.getBackofficePermissions(targetUser.id, role)
      : undefined;
    const roleAllowedPermissions = new Set(BACKOFFICE_ROLE_ALLOWED_PERMISSIONS[role]);
    const roleInvalidPermissions = (payload.permissions ?? []).filter(
      (permission) => !roleAllowedPermissions.has(permission)
    );

    if (roleInvalidPermissions.length > 0) {
      throw new ForbiddenException("不能发放目标后台身份不允许的权限。");
    }

    const requestedPermissions = resolveBackofficePermissions(
      role,
      payload.permissions ?? existingPermissions ?? BACKOFFICE_ROLE_DEFAULT_PERMISSIONS[role]
    );
    let grantedPermissions = requestedPermissions;

    if (actor.user.backofficeRole !== "super_admin" || actorTenantId) {
      if (role === "super_admin") {
        throw new ForbiddenException("当前后台账号不能发放服务商账号。");
      }

      const scopedActorTenantId =
        actorTenantId ?? this.store.getDefaultTenantId();
      const requestedTenantId = payload.tenantId ?? scopedActorTenantId;

      if (requestedTenantId !== scopedActorTenantId) {
        throw new ForbiddenException("当前后台账号不能管理其他实例的后台账号。");
      }

      const actorPermissions = new Set(actor.user.permissions);
      const canProvisionRestocker =
        role === "restocker" &&
        [
          "users:manage",
          "devices:manage",
          "backoffice-credentials:manage"
        ].every((permission) =>
          actorPermissions.has(permission as BackofficePermission)
        );
      const delegablePermissions = new Set<BackofficePermission>(
        canProvisionRestocker
          ? BACKOFFICE_ROLE_ALLOWED_PERMISSIONS.restocker
          : []
      );
      const invalidPermissions = requestedPermissions.filter(
        (permission) =>
          !actorPermissions.has(permission) &&
          !delegablePermissions.has(permission)
      );

      if (existingCredential && !payload.permissions && invalidPermissions.length > 0) {
        throw new ForbiddenException("不能管理权限超过当前账号的后台账号。");
      }

      if (payload.permissions && invalidPermissions.length > 0) {
        throw new ForbiddenException("不能发放当前账号自身没有的权限。");
      }

      grantedPermissions = requestedPermissions.filter(
        (permission) =>
          actorPermissions.has(permission) ||
          delegablePermissions.has(permission)
      );
    }

    const tenantId =
      role === "super_admin"
        ? undefined
        : (payload.tenantId ?? actor.user.tenantId ?? this.store.getDefaultTenantId());

    if (tenantId && !this.store.findPlatformTenantById(tenantId)) {
      throw new BadRequestException("目标客户实例不存在。");
    }

    const normalizedUsername = payload.username.trim().toLowerCase();
    const normalizedPassword = payload.password?.trim() ?? "";

    if (!normalizedUsername) {
      throw new BadRequestException("后台账号不能为空。");
    }

    if (!existingCredential && normalizedPassword.length < MIN_ADMIN_PASSWORD_LENGTH) {
      throw new BadRequestException(`后台密码至少需要 ${MIN_ADMIN_PASSWORD_LENGTH} 位。`);
    }

    if (
      existingCredential &&
      normalizedPassword &&
      normalizedPassword.length < MIN_ADMIN_PASSWORD_LENGTH
    ) {
      throw new BadRequestException(`后台密码至少需要 ${MIN_ADMIN_PASSWORD_LENGTH} 位。`);
    }

    if (existingCredential && normalizedPassword) {
      throw new BadRequestException(
        "已有后台账号不能通过通用账号配置接口重置密码；请使用专用重置接口。"
      );
    }

    const sameUsername = this.store.findBackofficeCredentialByUsername(normalizedUsername);

    if (sameUsername && (sameUsername.userId !== targetUser.id || sameUsername.role !== role)) {
      throw new BadRequestException("后台账号已被占用。");
    }

    const hashedPassword = normalizedPassword
      ? hashAdminPassword(normalizedPassword)
      : {
          salt: existingCredential!.passwordSalt,
          hash: existingCredential!.passwordHash
        };
    const credential = this.store.upsertBackofficeCredential({
      userId: targetUser.id,
      username: normalizedUsername,
      role,
      tenantId,
      permissions: grantedPermissions,
      passwordSalt: hashedPassword.salt,
      passwordHash: hashedPassword.hash,
      usesDefaultPassword: normalizedPassword ? false : existingCredential!.usesDefaultPassword,
      passwordUpdatedAt: normalizedPassword
        ? new Date().toISOString()
        : existingCredential!.passwordUpdatedAt
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

    if (normalizedPassword) {
      this.store.revokeSessionsForUser(targetUser.id);
    }

    return this.createBackofficeCredentialSnapshot(credential);
  }

  resetBackofficePasswordAsSuperAdmin(
    token: string | undefined,
    payload: {
      userId: string;
      role: BackofficeRole;
      newPassword: string;
      reason: string;
    }
  ) {
    const actor = this.getBackofficeSession(token);

    if (actor.user.backofficeRole !== "super_admin") {
      throw new ForbiddenException("只有超级管理员可以重置后台账号密码。");
    }

    const actorTenantId = actor.user.tenantId;

    if (!actorTenantId) {
      throw new ForbiddenException("请先进入目标客户实例后再重置账号密码。");
    }

    if (!actor.user.permissions.includes("backoffice-credentials:manage")) {
      throw new ForbiddenException("当前后台账号不能管理后台登录权限。");
    }

    const targetUser = this.store.users.find((entry) => entry.id === payload.userId);
    const credential = targetUser
      ? this.store.findBackofficeCredentialByUserId(targetUser.id, payload.role)
      : undefined;
    const normalizedPassword = payload.newPassword.trim();
    const normalizedReason = payload.reason.trim();

    if (!targetUser || !credential || targetUser.status !== "active") {
      throw new BadRequestException("目标后台账号不存在或已停用。");
    }

    if (!this.store.isBackofficeCredentialValidForUser(targetUser, credential)) {
      throw new BadRequestException("目标后台账号与当前人员身份不匹配。");
    }

    if (
      payload.role === "super_admin" ||
      credential.tenantId !== actorTenantId ||
      this.store.getUserTenantId(targetUser) !== actorTenantId
    ) {
      throw new ForbiddenException("当前后台账号不能重置其他实例的账号密码。");
    }

    const minimumPasswordLength = getBackofficePasswordMinimumLength(credential);
    if (normalizedPassword.length < minimumPasswordLength) {
      throw new BadRequestException(`后台密码至少需要 ${minimumPasswordLength} 位。`);
    }

    if (!normalizedReason || [...normalizedReason].length > 500) {
      throw new BadRequestException("重置原因不能为空且不能超过 500 个字符。");
    }

    if (verifyAdminPassword(normalizedPassword, credential.passwordSalt, credential.passwordHash)) {
      throw new BadRequestException("新密码不能与当前密码相同。");
    }

    const passwordHash = hashAdminPassword(normalizedPassword);
    const updatedCredential =
      this.store.runBackofficePasswordResetTransaction(() => {
        const updated = this.store.upsertBackofficeCredential({
          ...credential,
          passwordSalt: passwordHash.salt,
          passwordHash: passwordHash.hash,
          usesDefaultPassword: false,
          passwordUpdatedAt: new Date().toISOString()
        });

        this.store.logOperation({
          category: "admin",
          type: "reset-backoffice-password-by-super-admin",
          status: "success",
          actor: {
            type: actor.user.role,
            id: actor.user.id,
            name: actor.user.name,
            role: actor.user.role
          },
          primarySubject: {
            type: "user",
            id: targetUser.id,
            label: targetUser.name
          },
          metadata: {
            username: updated.username,
            backofficeRole: updated.role,
            reason: normalizedReason,
            resetMethod: "super-admin",
            undoState: "not_undoable"
          }
        });

        this.store.revokeSessionsForUser(targetUser.id);
        return updated;
      });
    this.clearPasswordLoginAccountFailures(updatedCredential.username);
    return this.createBackofficeCredentialSnapshot(updatedCredential);
  }

  listBackofficeCredentials(token: string | undefined): BackofficeCredentialSnapshot[] {
    const actor = this.getBackofficeSession(token);

    if (!actor.user.permissions.includes("backoffice-credentials:manage")) {
      throw new ForbiddenException("当前后台账号不能管理后台登录权限。");
    }

    const actorTenantId = actor.user.tenantId;

    return this.store.backofficeCredentials
      .filter((credential) => {
        if (
          actor.user.backofficeRole === "super_admin" &&
          actorTenantId === undefined
        ) {
          return true;
        }

        return (
          credential.role !== "super_admin" &&
          credential.tenantId ===
            (actorTenantId ?? this.store.getDefaultTenantId())
        );
      })
      .map((credential) => this.createBackofficeCredentialSnapshot(credential));
  }

  private assertCanManageManualVerificationCodes(user: {
    role: UserRole;
    permissions: BackofficePermission[];
  }) {
    if (
      user.role !== "admin" ||
      !user.permissions.includes("verification-codes:manage")
    ) {
      throw new ForbiddenException("当前后台账号不能签发人工验证码。");
    }
  }

  private findUniqueActiveUserByPhone(phone: string) {
    const matches = this.store.users.filter(
      (entry) => entry.phone === phone && entry.status === "active"
    );

    if (matches.length > 1) {
      throw new UnauthorizedException(
        "当前手机号对应的账号身份异常，请联系管理员处理。"
      );
    }

    return matches[0];
  }

  private async verifyCodeWithContext(
    phone: string,
    code: string,
    purpose: "app-login" | "password-reset"
  ) {
    const contextualService = this.verificationCodeService as unknown as {
      verifyCodeWithContext?: (
        targetPhone: string,
        targetCode: string,
        targetPurpose: "app-login" | "password-reset"
      ) => Promise<{
        verified: boolean;
        tenantId?: string;
        targetUserId?: string;
        manualGrantId?: string;
      }>;
    };

    if (typeof contextualService.verifyCodeWithContext === "function") {
      return contextualService.verifyCodeWithContext(
        phone,
        code,
        purpose
      );
    }

    return {
      verified: await this.verificationCodeService.verifyCode(
        phone,
        code,
        purpose
      )
    };
  }

  private async checkCodeWithContext(
    phone: string,
    code: string,
    purpose: "app-login" | "password-reset"
  ): Promise<VerificationCodeCheckResult> {
    const contextualService = this.verificationCodeService as unknown as {
      checkCodeWithContext?: (
        targetPhone: string,
        targetCode: string,
        targetPurpose: "app-login" | "password-reset"
      ) => Promise<VerificationCodeCheckResult>;
    };

    if (typeof contextualService.checkCodeWithContext === "function") {
      return contextualService.checkCodeWithContext(phone, code, purpose);
    }

    return this.verifyCodeWithContext(phone, code, purpose);
  }

  private consumeCheckedCode(
    phone: string,
    purpose: "app-login" | "password-reset",
    checked: VerificationCodeCheckResult,
    options: { persist?: boolean } = {}
  ) {
    const contextualService = this.verificationCodeService as unknown as {
      consumeCheckedCode?: (
        targetPhone: string,
        targetPurpose: "app-login" | "password-reset",
        targetChecked: VerificationCodeCheckResult,
        targetOptions?: { persist?: boolean }
      ) => boolean;
    };

    if (typeof contextualService.consumeCheckedCode === "function") {
      return contextualService.consumeCheckedCode(
        phone,
        purpose,
        checked,
        options
      );
    }

    return checked.verified;
  }

  private createManualVerificationGrantSnapshot(
    record: ManualVerificationGrantRecord
  ): ManualVerificationGrantSnapshot {
    const targetUser = record.targetUserId
      ? this.store.users.find((entry) => entry.id === record.targetUserId)
      : undefined;
    const status: ManualVerificationGrantStatus = record.supersededAt
      ? "superseded"
      : record.revokedAt
        ? "revoked"
        : record.consumedAt
          ? "consumed"
          : record.expiredAt ||
              new Date(record.expiresAt).getTime() <= Date.now()
            ? "expired"
            : record.lockedAt ||
                record.failedAttempts >= MAX_MANUAL_VERIFICATION_FAILURES
              ? "locked"
              : "active";

    return {
      id: record.manualGrantId!,
      userId: record.targetUserId!,
      userName: targetUser?.name ?? "已删除账号",
      tenantId: record.tenantId!,
      purpose: record.purpose as ManualVerificationPurpose,
      status,
      createdAt: record.requestedAt!,
      expiresAt: record.expiresAt,
      issuedByUserId: record.issuerUserId!,
      failedAttempts: record.failedAttempts,
      consumedAt: record.consumedAt,
      revokedAt: record.revokedAt,
      lockedAt: record.lockedAt,
      expiredAt: record.expiredAt,
      supersededAt: record.supersededAt,
      supersededByGrantId: record.supersededByGrantId,
      codeLength: 6
    };
  }

  private createBackofficeCredentialSnapshot(credential: {
    userId: string;
    username: string;
    role: BackofficeRole;
    tenantId?: string;
    usesDefaultPassword: boolean;
    passwordUpdatedAt: string;
  }): BackofficeCredentialSnapshot {
    const tenant = this.store.findPlatformTenantById(credential.tenantId);

    return {
      userId: credential.userId,
      username: credential.username,
      role: credential.role,
      tenantId: credential.tenantId,
      tenantName: tenant?.name,
      permissions: this.store.getBackofficePermissions(credential.userId, credential.role),
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
    token?: string,
    credential = this.store.findBackofficeCredentialByUserId(user.id, backofficeRole)
  ): BackofficeSessionResult {
    if (
      !credential ||
      !this.store.isBackofficeCredentialValidForUser(user, credential)
    ) {
      throw new UnauthorizedException("当前后台账号未配置登录凭证。");
    }

    if ((backofficeRole === "super_admin" || backofficeRole === "admin") && user.role !== "admin") {
      throw new UnauthorizedException("当前账号不是管理员，无法登录后台。");
    }

    if (backofficeRole === "merchant" && user.role !== "merchant") {
      throw new UnauthorizedException("当前账号不是商家，无法登录商家后台。");
    }

    if (backofficeRole === "restocker" && user.role !== "restocker") {
      throw new UnauthorizedException("当前账号不是补货员，无法登录补货后台。");
    }

    const resolvedToken = token ?? this.store.createBackofficeSession(user, backofficeRole, credential.tenantId);
    const session = this.store.getSession(resolvedToken);

    if (!session) {
      throw new UnauthorizedException("当前登录态已失效，请重新登录。");
    }

    try {
      this.assertTenantOperational(session.tenantId);
    } catch (error) {
      this.store.revokeSession(resolvedToken);
      throw error;
    }

    const tenant = this.store.findPlatformTenantById(session.tenantId);

    return {
      token: resolvedToken,
      user: {
        id: user.id,
        role: user.role as Extract<UserRole, "admin" | "merchant" | "restocker">,
        backofficeRole,
        scope: this.store.getBackofficeScope(backofficeRole, session.tenantId),
        tenantId: session.tenantId,
        tenantName: tenant?.name,
        tenantServiceMode: tenant?.serviceMode,
        permissions: this.store.getBackofficeSessionPermissions(session),
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

  private createSessionSnapshot(user: UserRecord, token?: string): MobileSessionSnapshot {
    this.assertTenantOperational(this.store.getUserTenantId(user));
    const resolvedToken = token ?? this.store.createSession(user);

    return {
      token: resolvedToken,
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

  private assertTenantOperational(tenantId?: string) {
    if (!tenantId) {
      return;
    }

    const tenant = this.store.findPlatformTenantById(tenantId);

    if (!tenant) {
      throw new UnauthorizedException("当前账号所属实例无效，请联系服务提供商。");
    }

    if (tenant.status === "paused") {
      throw new ForbiddenException("目标客户实例已暂停，暂不能登录。");
    }

    if (!this.store.isPlatformTenantOperationalInCurrentDataPlane(tenant.id)) {
      throw new ConflictException("当前客户实例尚未在匹配的运行环境完成开通。");
    }
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
      return profile.merchantName || profile.name || "商家";
    }

    return profile.name || "待完善资料用户";
  }

}
