import {
  BadRequestException,
  ForbiddenException,
  HttpException,
  Inject,
  Injectable,
  UnauthorizedException
} from "@nestjs/common";
import { ConfigService } from "@nestjs/config";

import type {
  AppLoginResult,
  BackofficeCredentialSnapshot,
  BackofficePermission,
  BackofficeRole,
  BackofficeSessionSnapshot,
  MobileLoginResult,
  MobileSessionSnapshot,
  RegistrationApplicationProfile,
  UserRecord,
  UserRole
} from "@vm/shared-types";
import {
  BACKOFFICE_ROLE_ALLOWED_PERMISSIONS,
  BACKOFFICE_ROLE_DEFAULT_PERMISSIONS,
  resolveBackofficePermissions
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
const MIN_ADMIN_PASSWORD_LENGTH = 8;

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

  async requestCode(phone: string, scene: "app-login" | "register" | "general" = "general") {
    return this.verificationCodeService.requestCode(phone, scene);
  }

  async appLogin(phone: string, code: string): Promise<AppLoginResult> {
    if (!(await this.verificationCodeService.verifyCode(phone, code, "app-login"))) {
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
    if (!(await this.verificationCodeService.verifyCode(phone, code, "general"))) {
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

    if (!user || !(await this.verificationCodeService.verifyCode(phone, code, "general"))) {
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

    if (!credential) {
      this.recordPasswordLoginFailure(username, sourceKey);
      throw new UnauthorizedException("账号或密码不正确。");
    }

    const user = this.store.users.find(
      (entry) =>
        entry.id === credential.userId &&
        this.store.isUserValidForBackofficeRole(entry, credential.role)
    );

    if (!user || !verifyAdminPassword(password, credential.passwordSalt, credential.passwordHash)) {
      this.recordPasswordLoginFailure(username, sourceKey);
      throw new UnauthorizedException("账号或密码不正确。");
    }

    this.assertDefaultCredentialAllowed(credential.usesDefaultPassword);
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

    if (normalizedPassword.length < MIN_ADMIN_PASSWORD_LENGTH) {
      throw new BadRequestException(`新密码至少需要 ${MIN_ADMIN_PASSWORD_LENGTH} 位。`);
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

    if (normalizedPassword.length < MIN_ADMIN_PASSWORD_LENGTH) {
      throw new BadRequestException(`新密码至少需要 ${MIN_ADMIN_PASSWORD_LENGTH} 位。`);
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
    const role = payload.role ?? (targetUser?.role === "merchant" ? "merchant" : "admin");

    if (!targetUser || !this.store.isUserValidForBackofficeRole(targetUser, role)) {
      throw new BadRequestException("目标用户不能开通该后台角色。");
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

    if (actor.user.backofficeRole !== "super_admin") {
      if (role === "super_admin") {
        throw new ForbiddenException("当前后台账号不能发放服务商账号。");
      }

      const actorTenantId = actor.user.tenantId ?? this.store.getDefaultTenantId();
      const requestedTenantId = payload.tenantId ?? actorTenantId;

      if (requestedTenantId !== actorTenantId) {
        throw new ForbiddenException("当前后台账号不能管理其他实例的后台账号。");
      }

      const actorPermissions = new Set(actor.user.permissions);
      const invalidPermissions = requestedPermissions.filter(
        (permission) => !actorPermissions.has(permission)
      );

      if (existingCredential && !payload.permissions && invalidPermissions.length > 0) {
        throw new ForbiddenException("不能管理权限超过当前账号的后台账号。");
      }

      if (payload.permissions && invalidPermissions.length > 0) {
        throw new ForbiddenException("不能发放当前账号自身没有的权限。");
      }

      grantedPermissions = requestedPermissions.filter((permission) => actorPermissions.has(permission));
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

  listBackofficeCredentials(token: string | undefined): BackofficeCredentialSnapshot[] {
    const actor = this.getBackofficeSession(token);

    if (!actor.user.permissions.includes("backoffice-credentials:manage")) {
      throw new ForbiddenException("当前后台账号不能管理后台登录权限。");
    }

    const actorTenantId = actor.user.tenantId ?? this.store.getDefaultTenantId();

    return this.store.backofficeCredentials
      .filter((credential) => {
        if (actor.user.backofficeRole === "super_admin") {
          return true;
        }

        return credential.role !== "super_admin" && credential.tenantId === actorTenantId;
      })
      .map((credential) => this.createBackofficeCredentialSnapshot(credential));
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
    if (!credential) {
      throw new UnauthorizedException("当前后台账号未配置登录凭证。");
    }

    if ((backofficeRole === "super_admin" || backofficeRole === "admin") && user.role !== "admin") {
      throw new UnauthorizedException("当前账号不是管理员，无法登录后台。");
    }

    if (backofficeRole === "merchant" && user.role !== "merchant") {
      throw new UnauthorizedException("当前账号不是商家，无法登录商家后台。");
    }

    const tenant = this.store.findPlatformTenantById(credential.tenantId);
    const resolvedToken = token ?? this.store.createBackofficeSession(user, backofficeRole, credential.tenantId);

    return {
      token: resolvedToken,
      user: {
        id: user.id,
        role: user.role as Extract<UserRole, "admin" | "merchant">,
        backofficeRole,
        scope: this.store.getBackofficeScope(backofficeRole),
        tenantId: credential.tenantId,
        tenantName: tenant?.name,
        permissions: this.store.getBackofficePermissions(user.id, backofficeRole),
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
      return profile.merchantName || profile.name || "商家";
    }

    return profile.name || "待完善资料用户";
  }

}
