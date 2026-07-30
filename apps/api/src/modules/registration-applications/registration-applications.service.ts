import {
  BadRequestException,
  ConflictException,
  HttpException,
  Inject,
  Injectable,
  NotFoundException,
  UnauthorizedException
} from "@nestjs/common";
import { ConfigService } from "@nestjs/config";

import type {
  RegistrationApplication,
  RegistrationApplicationProfile,
  RegistrationPhoneLookup,
  UserRecord,
  UserRole
} from "@vm/shared-types";

import { isProductionRuntime } from "../../common/config/runtime-environment";
import { InMemoryStoreService } from "../../common/store/in-memory-store.service";
import { VerificationCodeService } from "../auth/verification-code.service";

@Injectable()
export class RegistrationApplicationsService {
  private readonly publicLookupHistory = new Map<string, number[]>();

  constructor(
    @Inject(InMemoryStoreService) private readonly store: InMemoryStoreService,
    @Inject(VerificationCodeService)
    private readonly verificationCodeService: VerificationCodeService,
    @Inject(ConfigService) private readonly configService: ConfigService
  ) {}

  resolvePublicTenantId(requestHostname?: string) {
    const hostname = this.normalizeHostname(requestHostname);
    const matchingTenants = hostname
      ? this.store.platformTenants.filter(
          (tenant) =>
            tenant.status !== "paused" &&
            this.readInstanceHostname(tenant.instanceUrl) === hostname
        )
      : [];

    if (matchingTenants.length === 1) {
      return matchingTenants[0].id;
    }

    if (matchingTenants.length > 1) {
      throw new NotFoundException("当前访问入口未绑定唯一可用的客户实例。");
    }

    const publicBaseHostname = this.readInstanceHostname(
      this.configService.get<string>("PUBLIC_BASE_URL")
    );
    const defaultTenant = this.store.findPlatformTenantById(
      this.store.getDefaultTenantId()
    );

    if (
      hostname &&
      publicBaseHostname === hostname &&
      defaultTenant &&
      defaultTenant.status !== "paused"
    ) {
      return defaultTenant.id;
    }

    if (
      !isProductionRuntime() &&
      !this.store.isLiveDataPlane() &&
      (!hostname || this.isLoopbackHostname(hostname))
    ) {
      return this.store.getDefaultTenantId();
    }

    throw new NotFoundException("当前访问入口未绑定可用的客户实例。");
  }

  list(status?: RegistrationApplication["status"], tenantId?: string) {
    return this.store.registrationApplications
      .filter(
        (entry) =>
          (!tenantId ||
            this.resolveApplicationTenantId(entry) === tenantId) &&
          (status ? entry.status === status : true)
      )
      .slice()
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  }

  detail(id: string, tenantId?: string) {
    const application = this.store.registrationApplications.find((entry) => entry.id === id);

    if (
      !application ||
      (tenantId && this.resolveApplicationTenantId(application) !== tenantId)
    ) {
      throw new NotFoundException("未找到对应审核申请。");
    }

    return application;
  }

  findLatestByPhone(phone: string, tenantId: string) {
    return this.store.registrationApplications
      .filter(
        (entry) =>
          entry.phone === phone &&
          this.resolveApplicationTenantId(entry) === tenantId
      )
      .slice()
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))[0];
  }

  async lookupByPhone(
    phone: string,
    code?: string,
    sourceKey = "anonymous",
    tenantId?: string
  ): Promise<RegistrationPhoneLookup> {
    if (!tenantId) {
      throw new NotFoundException("当前访问入口未绑定可用的客户实例。");
    }
    const normalizedPhone = phone.trim();
    const includePrivateDetails = Boolean(code?.trim());

    if (!includePrivateDetails) {
      this.assertPublicLookupAllowed(sourceKey);
      return {
        phone: normalizedPhone,
        state: "new"
      };
    }

    await this.ensureVerifiedCode(normalizedPhone, code!.trim());

    if (!normalizedPhone) {
      return {
        phone: normalizedPhone,
        state: "new"
      };
    }

    const application = this.findLatestByPhone(normalizedPhone, tenantId);
    const linkedUser = this.findUserByPhoneInTenant(
      normalizedPhone,
      tenantId
    );

    if (linkedUser?.mobileProfileCompleted) {
      return this.toPublicLookup({
        phone: normalizedPhone,
        state: "approved",
        fixedRole: linkedUser.role,
        profile: this.mapUserProfile(linkedUser),
        application,
        linkedUser: this.mapLinkedUser(linkedUser),
        message: "该手机号已通过审核，可直接登录。"
      }, includePrivateDetails);
    }

    if (application?.status === "pending") {
      return this.toPublicLookup({
        phone: normalizedPhone,
        state: "pending",
        fixedRole: linkedUser?.role,
        profile: application.profile,
        application,
        linkedUser: linkedUser ? this.mapLinkedUser(linkedUser) : undefined,
        message: "该手机号已有待审核资料，重新提交将覆盖之前的信息。"
      }, includePrivateDetails);
    }

    if (application?.status === "rejected") {
      return this.toPublicLookup({
        phone: normalizedPhone,
        state: "rejected",
        fixedRole: linkedUser?.role,
        profile: application.profile,
        application,
        linkedUser: linkedUser ? this.mapLinkedUser(linkedUser) : undefined,
        message: application.reviewReason || "该手机号此前审核未通过，可修改资料后重新提交。"
      }, includePrivateDetails);
    }

    if (linkedUser) {
      return this.toPublicLookup({
        phone: normalizedPhone,
        state: "existing_user",
        fixedRole: linkedUser.role,
        profile: this.mapUserProfile(linkedUser),
        linkedUser: this.mapLinkedUser(linkedUser),
        message: "该手机号已在系统预登记，补齐资料后可直接启用。"
      }, includePrivateDetails);
    }

    return {
      phone: normalizedPhone,
      state: "new"
    };
  }

  private toPublicLookup(lookup: RegistrationPhoneLookup, includePrivateDetails: boolean): RegistrationPhoneLookup {
    if (includePrivateDetails) {
      return lookup;
    }

    return {
      phone: lookup.phone,
      state: lookup.state,
      message: lookup.state === "rejected"
        ? "该手机号此前审核未通过，可重新提交资料。"
        : lookup.message
    };
  }

  private assertPublicLookupAllowed(sourceKey: string) {
    const now = Date.now();
    const windowMs = 10 * 60_000;
    const limit = 30;
    const recent = (this.publicLookupHistory.get(sourceKey) ?? []).filter(
      (timestamp) => now - timestamp < windowMs
    );

    if (recent.length >= limit) {
      throw new HttpException("查询过于频繁，请稍后再试。", 429);
    }

    recent.push(now);
    this.publicLookupHistory.set(sourceKey, recent);
  }

  async createOrUpdateByPhone(
    payload: {
      phone: string;
      code: string;
      requestedRole?: UserRole;
      profile: RegistrationApplicationProfile;
    },
    tenantId: string
  ) {
    const phone = payload.phone.trim();
    const normalizedProfile = this.normalizeProfile(payload.profile);
    const existingUser = this.findUserByPhoneInTenant(phone, tenantId);
    const existingApplication = this.findLatestByPhone(phone, tenantId);
    const requestedRole = this.resolvePublicRequestedRole(
      payload.requestedRole ?? existingApplication?.requestedRole
    );
    await this.ensureVerifiedCode(phone, payload.code);
    this.assertNoForeignPhoneOwnership(phone, tenantId);

    if (existingUser?.mobileProfileCompleted || existingApplication?.status === "approved") {
      throw new BadRequestException("该手机号已通过审核，请直接登录。");
    }

    if (existingUser) {
      return this.completeExistingImportedUser(existingUser, normalizedProfile);
    }

    return this.upsertPendingApplication(existingApplication, {
      phone,
      requestedRole,
      profile: normalizedProfile,
      tenantId
    });
  }

  async updatePendingApplication(
    id: string,
    payload: {
      phone: string;
      code: string;
      requestedRole?: UserRole;
      profile: RegistrationApplicationProfile;
    },
    tenantId: string
  ) {
    const application = this.detail(id, tenantId);

    if (!["pending", "rejected"].includes(application.status)) {
      throw new BadRequestException("当前申请已结束，不能继续修改。");
    }

    const phone = payload.phone.trim();

    if (phone !== application.phone) {
      // 公开更新入口只能由原手机号持有人继续填写，不能拿自己的验证码改写其他申请 ID。
      throw new UnauthorizedException("手机号或验证码不正确。");
    }

    const normalizedProfile = this.normalizeProfile(payload.profile);
    const requestedRole = this.resolvePublicRequestedRole(
      payload.requestedRole ?? application.requestedRole
    );
    await this.ensureVerifiedCode(phone, payload.code);
    this.assertNoForeignPhoneOwnership(phone, tenantId);

    const existingUser = this.findUserByPhoneInTenant(phone, tenantId);

    if (existingUser?.mobileProfileCompleted) {
      throw new BadRequestException("该手机号已通过审核，请直接登录。");
    }

    if (existingUser) {
      return this.completeExistingImportedUser(existingUser, normalizedProfile);
    }

    return this.upsertPendingApplication(application, {
      phone,
      requestedRole,
      profile: normalizedProfile,
      tenantId
    });
  }

  upsertFromDraft(
    draftToken: string,
    payload: {
      requestedRole?: UserRole;
      profile: RegistrationApplicationProfile;
    }
  ) {
    const draft = this.store.getDraftSession(draftToken);

    if (!draft) {
      throw new UnauthorizedException("当前资料草稿已失效，请重新获取验证码。");
    }

    if (draft.linkedUserId) {
      throw new BadRequestException("已登记用户无需创建新的审核申请。");
    }

    const tenantId = draft.tenantId;
    if (!tenantId) {
      throw new UnauthorizedException(
        "当前资料草稿缺少实例归属，请重新获取验证码。"
      );
    }
    this.assertNoForeignPhoneOwnership(draft.phone, tenantId);
    const normalizedProfile = this.normalizeProfile(payload.profile);

    const existing =
      (draft.applicationId
        ? this.store.registrationApplications.find(
            (entry) =>
              entry.id === draft.applicationId &&
              this.resolveApplicationTenantId(entry) === tenantId
          )
        : undefined) ?? this.findLatestByPhone(draft.phone, tenantId);

    return this.upsertPendingApplication(existing, {
      phone: draft.phone,
      requestedRole: this.resolvePublicRequestedRole(payload.requestedRole ?? draft.requestedRole),
      profile: normalizedProfile,
      tenantId
    });
  }

  review(
    id: string,
    payload: {
      decision: "approved" | "rejected";
      reason?: string;
    },
    actorUserId?: string,
    actorTenantId?: string
  ) {
    const application = this.detail(id, actorTenantId);
    const applicationTenantId = this.resolveApplicationTenantId(application);

    if (application.status !== "pending") {
      throw new ConflictException("该注册申请已完成审核，不能重复或改写审核结果。");
    }

    const now = new Date().toISOString();

    if (payload.decision === "rejected") {
      application.status = "rejected";
      application.reviewReason = payload.reason?.trim() || "资料需要补充，请修改后重新提交。";
      application.updatedAt = now;
      this.store.logOperation({
        category: "user",
        type: "review-registration-reject",
        status: "warning",
        actor: this.getAdminActor(actorUserId),
        detail: `管理员驳回了手机号 ${application.phone} 的注册申请。`,
        description: `管理员驳回了 ${application.phone} 的注册申请。`,
        metadata: {
          tenantId: applicationTenantId,
          applicationId: application.id,
          phone: application.phone,
          requestedRole: application.requestedRole,
          reviewReason: application.reviewReason,
          undoState: "not_undoable"
        }
      });
      return application;
    }

    const normalizedProfile = this.normalizeProfile(application.profile);
    application.profile = normalizedProfile;
    const linkedUser =
      (application.linkedUserId
        ? this.store.users.find((entry) => entry.id === application.linkedUserId)
        : undefined) ?? this.store.users.find((entry) => entry.phone === application.phone);

    if (
      linkedUser &&
      this.store.getUserTenantId(linkedUser) !== applicationTenantId
    ) {
      throw new ConflictException("注册申请关联账号的实例归属不一致，已拒绝审核。");
    }

    const user = linkedUser ?? this.createUserFromApplication(application);

    this.applyProfileToUser(user, normalizedProfile, application.requestedRole);
    user.status = "active";
    user.mobileProfileCompleted = true;
    application.linkedUserId = user.id;
    application.status = "approved";
    application.reviewReason = undefined;
    application.updatedAt = now;

    this.store.logOperation({
      category: "user",
      type: "review-registration-approve",
      status: "success",
      actor: this.getAdminActor(actorUserId),
      primarySubject: {
        type: "user",
        id: user.id,
        label: user.name
      },
      detail: `管理员通过了 ${user.name} 的移动端注册申请。`,
      description: `管理员通过了 ${user.name} 的注册申请。`,
      metadata: {
        tenantId: applicationTenantId,
        applicationId: application.id,
        phone: application.phone,
        requestedRole: application.requestedRole,
        undoState: "not_undoable"
      }
    });
    return application;
  }

  private async ensureVerifiedCode(phone: string, code: string) {
    if (!(await this.verificationCodeService.verifyCode(phone, code, "register"))) {
      throw new UnauthorizedException("手机号或验证码不正确。");
    }
  }

  private completeExistingImportedUser(user: UserRecord, profile: RegistrationApplicationProfile) {
    // 街道已预登记的人应当能顺畅激活，避免在线下登记和线上补录之间来回折返。
    this.applyProfileToUser(user, profile, user.role);
    user.mobileProfileCompleted = true;
    user.status = "active";

    const now = new Date().toISOString();
    const tenantId = this.store.getUserTenantId(user);
    if (!tenantId) {
      throw new BadRequestException(
        "当前账号缺少明确的实例归属，请联系服务商处理。"
      );
    }
    const existingApplication = this.findLatestByPhone(user.phone, tenantId);
    const application =
      existingApplication ??
      ({
        id: this.store.createId("application"),
        tenantId,
        phone: user.phone,
        requestedRole: user.role,
        profile,
        status: "approved",
        linkedUserId: user.id,
        createdAt: now,
        updatedAt: now
      } satisfies RegistrationApplication);

    application.tenantId = tenantId;
    application.phone = user.phone;
    application.requestedRole = user.role;
    application.profile = profile;
    application.status = "approved";
    application.linkedUserId = user.id;
    application.reviewReason = undefined;
    application.updatedAt = now;

    if (!existingApplication) {
      this.store.registrationApplications.unshift(application);
    }

    this.store.logOperation({
      category: "user",
      type: "complete-imported-user-registration",
      status: "success",
      actor: {
        type: "system",
        name: "移动端注册"
      },
      primarySubject: {
        type: "user",
        id: user.id,
        label: user.name
      },
      detail: `${user.name} 完成了移动端资料补全，账号可直接登录。`,
      description: `${user.name} 完成了移动端资料登记。`,
      metadata: {
        tenantId,
        phone: user.phone,
        requestedRole: user.role,
        applicationId: application.id,
        undoState: "not_undoable"
      }
    });

    return application;
  }

  private upsertPendingApplication(
    existing: RegistrationApplication | undefined,
    payload: {
      phone: string;
      requestedRole: UserRole;
      profile: RegistrationApplicationProfile;
      tenantId: string;
    }
  ) {
    const now = new Date().toISOString();

    if (existing) {
      if (this.resolveApplicationTenantId(existing) !== payload.tenantId) {
        throw new ConflictException("注册申请的实例归属不一致，已拒绝覆盖。");
      }
      // 重提申请时直接覆盖旧草稿，保证后台看到的是申请人当前最真实、最新的情况。
      existing.phone = payload.phone;
      existing.tenantId = existing.tenantId ?? payload.tenantId;
      existing.requestedRole = payload.requestedRole;
      existing.profile = payload.profile;
      existing.status = "pending";
      existing.reviewReason = undefined;
      existing.updatedAt = now;
      return existing;
    }

    const created: RegistrationApplication = {
      id: this.store.createId("application"),
      tenantId: payload.tenantId,
      phone: payload.phone,
      requestedRole: payload.requestedRole,
      profile: payload.profile,
      status: "pending",
      createdAt: now,
      updatedAt: now
    };

    this.store.registrationApplications.unshift(created);
    return created;
  }

  private resolveApplicationTenantId(application: RegistrationApplication) {
    if (application.tenantId) {
      return application.tenantId;
    }

    const linkedUser = application.linkedUserId
      ? this.store.users.find((entry) => entry.id === application.linkedUserId)
      : undefined;

    return linkedUser
      ? this.store.getUserTenantId(linkedUser)
      : this.store.getDefaultTenantId();
  }

  private findUserByPhoneInTenant(phone: string, tenantId: string) {
    return this.store.users.find(
      (entry) =>
        entry.phone === phone &&
        this.store.getUserTenantId(entry) === tenantId
    );
  }

  private assertNoForeignPhoneOwnership(phone: string, tenantId: string) {
    const foreignUser = this.store.users.some(
      (entry) =>
        entry.phone === phone &&
        this.store.getUserTenantId(entry) !== tenantId
    );
    const foreignApplication = this.store.registrationApplications.some(
      (entry) =>
        entry.phone === phone &&
        this.resolveApplicationTenantId(entry) !== tenantId
    );

    if (foreignUser || foreignApplication) {
      throw new BadRequestException(
        "该手机号已归属其他客户实例，请联系实例管理员处理。"
      );
    }
  }

  private normalizeHostname(raw?: string) {
    return raw
      ?.trim()
      .toLowerCase()
      .replace(/^\[|\]$/g, "")
      .replace(/\.$/, "");
  }

  private readInstanceHostname(raw?: string) {
    if (!raw?.trim()) {
      return undefined;
    }

    try {
      return this.normalizeHostname(new URL(raw).hostname);
    } catch {
      return undefined;
    }
  }

  private isLoopbackHostname(hostname: string) {
    return (
      hostname === "localhost" ||
      hostname.endsWith(".localhost") ||
      hostname === "::1" ||
      /^127(?:\.\d{1,3}){3}$/.test(hostname)
    );
  }

  private resolvePublicRequestedRole(role?: UserRole) {
    const resolvedRole = role ?? "special";

    if (resolvedRole === "special" || resolvedRole === "merchant") {
      return resolvedRole;
    }

    if (resolvedRole === "admin") {
      if (this.isPublicAdminRegistrationEnabled()) {
        return resolvedRole;
      }

      throw new BadRequestException("管理员账号请由后台创建或由程序提供商分配。");
    }

    throw new BadRequestException("补货员账号请由实例管理员在后台创建并分配柜机。");
  }

  private isPublicAdminRegistrationEnabled() {
    return ["1", "true", "yes", "on"].includes(
      this.configService
        .get<string>("PUBLIC_ADMIN_REGISTRATION_ENABLED")
        ?.trim()
        .toLowerCase() ?? ""
    );
  }

  private createUserFromApplication(application: RegistrationApplication) {
    const regionName = application.profile.regionName ?? application.profile.neighborhood;
    const created: UserRecord = {
      id: this.store.createId(application.requestedRole),
      tenantId: this.resolveApplicationTenantId(application),
      role: application.requestedRole,
      phone: application.phone,
      name: this.resolveUserName(application.requestedRole, application.profile),
      status: "active",
      neighborhood: application.requestedRole === "special" ? regionName : undefined,
      regionId: application.profile.regionId,
      regionName,
      tags: [],
      mobileProfileCompleted: true,
      profile: this.buildUserProfile(application.profile),
      merchantProfile:
        application.requestedRole === "merchant"
          ? {
              donationWindowDays: 2,
              defaultDeviceCodes: []
            }
          : undefined
    };

    this.store.users.unshift(created);
    return created;
  }

  private applyProfileToUser(
    user: UserRecord,
    profile: RegistrationApplicationProfile,
    role: UserRole
  ) {
    const regionName = profile.regionName ?? profile.neighborhood;
    user.name = this.resolveUserName(role, profile);
    user.neighborhood = role === "special" ? regionName : user.neighborhood;
    user.regionId = profile.regionId;
    user.regionName = regionName;
    user.profile = this.buildUserProfile(profile);

    if (role === "merchant") {
      user.merchantProfile = user.merchantProfile ?? {
        donationWindowDays: 2,
        defaultDeviceCodes: []
      };
    }
  }

  private mapLinkedUser(user: UserRecord) {
    return {
      id: user.id,
      role: user.role,
      name: user.name,
      phone: user.phone,
      mobileProfileCompleted: user.mobileProfileCompleted
    };
  }

  private mapUserProfile(user: UserRecord): RegistrationApplicationProfile {
    return {
      name: user.role === "merchant" ? user.profile?.contactName || user.name : user.name,
      neighborhood: user.neighborhood,
      regionId: user.regionId,
      regionName: user.regionName ?? user.neighborhood,
      note: user.profile?.note,
      merchantName: user.role === "merchant" ? user.name : undefined,
      contactName: user.profile?.contactName,
      address: user.profile?.address,
      organization: user.profile?.organization,
      title: user.profile?.title
    };
  }

  private normalizeProfile(profile: RegistrationApplicationProfile): RegistrationApplicationProfile {
    const normalizedName = this.normalizeRequiredProfileText(profile.name, "姓名", 100);

    const region = this.resolveConfiguredRegion(profile.regionId, profile.regionName ?? profile.neighborhood);

    return {
      ...profile,
      name: normalizedName,
      neighborhood: region.name,
      regionId: region.id,
      regionName: region.name,
      note: this.normalizeOptionalProfileText(profile.note, "备注", 1_000),
      merchantName: this.normalizeOptionalProfileText(profile.merchantName, "商户名称", 100),
      contactName: this.normalizeOptionalProfileText(profile.contactName, "联系人", 100),
      address: this.normalizeOptionalProfileText(profile.address, "地址", 300),
      organization: this.normalizeOptionalProfileText(profile.organization, "所属单位", 150),
      title: this.normalizeOptionalProfileText(profile.title, "职务", 100)
    };
  }

  private normalizeRequiredProfileText(value: string | undefined, label: string, maxLength: number) {
    const normalized = value?.trim();

    if (!normalized) {
      throw new BadRequestException(`${label}不能为空。`);
    }

    if (normalized.length > maxLength) {
      throw new BadRequestException(`${label}不能超过 ${maxLength} 个字符。`);
    }

    return normalized;
  }

  private normalizeOptionalProfileText(
    value: string | undefined,
    label: string,
    maxLength: number
  ) {
    const normalized = value?.trim();

    if (!normalized) {
      return undefined;
    }

    if (normalized.length > maxLength) {
      throw new BadRequestException(`${label}不能超过 ${maxLength} 个字符。`);
    }

    return normalized;
  }

  private resolveConfiguredRegion(regionId?: string, regionName?: string) {
    const activeRegions = this.store.regions.filter((entry) => entry.status === "active");

    if (regionId) {
      const matchedById = activeRegions.find((entry) => entry.id === regionId);

      if (matchedById) {
        return {
          id: matchedById.id,
          name: matchedById.name
        };
      }
    }

    const normalizedName = regionName?.trim();

    if (normalizedName) {
      const matchedByName = activeRegions.find((entry) => entry.name === normalizedName);

      if (matchedByName) {
        return {
          id: matchedByName.id,
          name: matchedByName.name
        };
      }
    }

    throw new BadRequestException("请选择已配置区域。");
  }

  private resolveUserName(role: UserRole, profile: RegistrationApplicationProfile) {
    if (role === "merchant") {
      return profile.merchantName || profile.name || "商家";
    }

    return profile.name || "待审核用户";
  }

  private buildUserProfile(profile: RegistrationApplicationProfile) {
    return {
      note: profile.note,
      contactName: profile.contactName,
      address: profile.address,
      organization: profile.organization,
      title: profile.title
    };
  }

  private getAdminActor(actorUserId?: string) {
    const actor =
      this.store.users.find((entry) => entry.id === actorUserId) ??
      this.store.users.find((entry) => entry.role === "admin");

    if (actor) {
      return {
        type: actor.role === "admin" ? ("admin" as const) : ("system" as const),
        id: actor.id,
        name: actor.name,
        role: actor.role
      };
    }

    return {
      type: "system" as const,
      name: "系统"
    };
  }
}
