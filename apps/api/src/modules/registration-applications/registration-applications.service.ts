import { BadRequestException, Inject, Injectable, NotFoundException, UnauthorizedException } from "@nestjs/common";

import type {
  RegistrationApplication,
  RegistrationApplicationProfile,
  RegistrationPhoneLookup,
  UserRecord,
  UserRole
} from "@vm/shared-types";

import { InMemoryStoreService } from "../../common/store/in-memory-store.service";
import { VerificationCodeService } from "../auth/verification-code.service";

@Injectable()
export class RegistrationApplicationsService {
  constructor(
    @Inject(InMemoryStoreService) private readonly store: InMemoryStoreService,
    @Inject(VerificationCodeService)
    private readonly verificationCodeService: VerificationCodeService
  ) {}

  list(status?: RegistrationApplication["status"]) {
    return this.store.registrationApplications
      .filter((entry) => (status ? entry.status === status : true))
      .slice()
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  }

  detail(id: string) {
    const application = this.store.registrationApplications.find((entry) => entry.id === id);

    if (!application) {
      throw new NotFoundException("未找到对应审核申请。");
    }

    return application;
  }

  findLatestByPhone(phone: string) {
    return this.store.registrationApplications
      .filter((entry) => entry.phone === phone)
      .slice()
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))[0];
  }

  lookupByPhone(phone: string): RegistrationPhoneLookup {
    const normalizedPhone = phone.trim();

    if (!normalizedPhone) {
      return {
        phone: normalizedPhone,
        state: "new"
      };
    }

    const application = this.findLatestByPhone(normalizedPhone);
    const linkedUser = this.store.users.find((entry) => entry.phone === normalizedPhone);

    if (linkedUser?.mobileProfileCompleted) {
      return {
        phone: normalizedPhone,
        state: "approved",
        fixedRole: linkedUser.role,
        profile: this.mapUserProfile(linkedUser),
        application,
        linkedUser: this.mapLinkedUser(linkedUser),
        message: "该手机号已通过审核，可直接登录。"
      };
    }

    if (application?.status === "pending") {
      return {
        phone: normalizedPhone,
        state: "pending",
        fixedRole: linkedUser?.role,
        profile: application.profile,
        application,
        linkedUser: linkedUser ? this.mapLinkedUser(linkedUser) : undefined,
        message: "该手机号已有待审核资料，重新提交将覆盖之前的信息。"
      };
    }

    if (application?.status === "rejected") {
      return {
        phone: normalizedPhone,
        state: "rejected",
        fixedRole: linkedUser?.role,
        profile: application.profile,
        application,
        linkedUser: linkedUser ? this.mapLinkedUser(linkedUser) : undefined,
        message: application.reviewReason || "该手机号此前审核未通过，可修改资料后重新提交。"
      };
    }

    if (linkedUser) {
      return {
        phone: normalizedPhone,
        state: "existing_user",
        fixedRole: linkedUser.role,
        profile: this.mapUserProfile(linkedUser),
        linkedUser: this.mapLinkedUser(linkedUser),
        message: "该手机号已在系统预登记，补齐资料后可直接启用。"
      };
    }

    return {
      phone: normalizedPhone,
      state: "new"
    };
  }

  async createOrUpdateByPhone(payload: {
    phone: string;
    code: string;
    requestedRole?: UserRole;
    profile: RegistrationApplicationProfile;
  }) {
    const phone = payload.phone.trim();
    const normalizedProfile = this.normalizeProfile(payload.profile);
    await this.ensureVerifiedCode(phone, payload.code);

    const existingUser = this.store.users.find((entry) => entry.phone === phone);
    const existingApplication = this.findLatestByPhone(phone);

    if (existingUser?.mobileProfileCompleted || existingApplication?.status === "approved") {
      throw new BadRequestException("该手机号已通过审核，请直接登录。");
    }

    if (existingUser) {
      return this.completeExistingImportedUser(existingUser, normalizedProfile);
    }

    return this.upsertPendingApplication(existingApplication, {
      phone,
      requestedRole: payload.requestedRole ?? existingApplication?.requestedRole ?? "special",
      profile: normalizedProfile
    });
  }

  async updatePendingApplication(
    id: string,
    payload: {
      phone: string;
      code: string;
      requestedRole?: UserRole;
      profile: RegistrationApplicationProfile;
    }
  ) {
    const application = this.detail(id);
    const normalizedProfile = this.normalizeProfile(payload.profile);

    if (!["pending", "rejected"].includes(application.status)) {
      throw new BadRequestException("当前申请已结束，不能继续修改。");
    }

    const phone = payload.phone.trim();
    await this.ensureVerifiedCode(phone, payload.code);

    const existingUser = this.store.users.find((entry) => entry.phone === phone);

    if (existingUser?.mobileProfileCompleted) {
      throw new BadRequestException("该手机号已通过审核，请直接登录。");
    }

    if (existingUser) {
      return this.completeExistingImportedUser(existingUser, normalizedProfile);
    }

    return this.upsertPendingApplication(application, {
      phone,
      requestedRole: payload.requestedRole ?? application.requestedRole,
      profile: normalizedProfile
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

    const normalizedProfile = this.normalizeProfile(payload.profile);

    const existing =
      (draft.applicationId ? this.store.registrationApplications.find((entry) => entry.id === draft.applicationId) : undefined) ??
      this.findLatestByPhone(draft.phone);

    return this.upsertPendingApplication(existing, {
      phone: draft.phone,
      requestedRole: payload.requestedRole ?? draft.requestedRole ?? "special",
      profile: normalizedProfile
    });
  }

  review(
    id: string,
    payload: {
      decision: "approved" | "rejected";
      reason?: string;
    },
    actorUserId?: string
  ) {
    const application = this.detail(id);
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
        applicationId: application.id,
        phone: application.phone,
        requestedRole: application.requestedRole,
        undoState: "not_undoable"
      }
    });
    return application;
  }

  private async ensureVerifiedCode(phone: string, code: string) {
    if (!(await this.verificationCodeService.verifyCode(phone, code))) {
      throw new UnauthorizedException("手机号或验证码不正确。");
    }
  }

  private completeExistingImportedUser(user: UserRecord, profile: RegistrationApplicationProfile) {
    // 街道已预登记的人应当能顺畅激活，避免在线下登记和线上补录之间来回折返。
    this.applyProfileToUser(user, profile, user.role);
    user.mobileProfileCompleted = true;
    user.status = "active";

    const now = new Date().toISOString();
    const existingApplication = this.findLatestByPhone(user.phone);
    const application =
      existingApplication ??
      ({
        id: this.store.createId("application"),
        phone: user.phone,
        requestedRole: user.role,
        profile,
        status: "approved",
        linkedUserId: user.id,
        createdAt: now,
        updatedAt: now
      } satisfies RegistrationApplication);

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
    }
  ) {
    const now = new Date().toISOString();

    if (existing) {
      // 重提申请时直接覆盖旧草稿，保证后台看到的是申请人当前最真实、最新的情况。
      existing.phone = payload.phone;
      existing.requestedRole = payload.requestedRole;
      existing.profile = payload.profile;
      existing.status = "pending";
      existing.reviewReason = undefined;
      existing.updatedAt = now;
      return existing;
    }

    const created: RegistrationApplication = {
      id: this.store.createId("application"),
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

  private createUserFromApplication(application: RegistrationApplication) {
    const regionName = application.profile.regionName ?? application.profile.neighborhood;
    const created: UserRecord = {
      id: this.store.createId(application.requestedRole),
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
    const region = this.resolveConfiguredRegion(profile.regionId, profile.regionName ?? profile.neighborhood);

    return {
      ...profile,
      name: profile.name.trim(),
      neighborhood: region.name,
      regionId: region.id,
      regionName: region.name,
      note: profile.note?.trim() || undefined,
      merchantName: profile.merchantName?.trim() || undefined,
      contactName: profile.contactName?.trim() || undefined,
      address: profile.address?.trim() || undefined,
      organization: profile.organization?.trim() || undefined,
      title: profile.title?.trim() || undefined
    };
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
      return profile.merchantName || profile.name || "爱心商户";
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
