import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable
} from "@nestjs/common";

import {
  BACKOFFICE_TENANT_BOOTSTRAP_PERMISSIONS,
  type AlertTask,
  type OperationLogRecord,
  type PlatformOverviewSnapshot,
  type PlatformTenantCreatePayload,
  type PlatformTenantProvisioningResult,
  type PlatformTenantRecord,
  type PlatformTenantUpdatePayload,
  type PlatformTenantUsageSummary,
  type UserRecord
} from "@vm/shared-types";

import { InMemoryStoreService } from "../../common/store/in-memory-store.service";
import type { BackofficeCredentialRecord } from "../../common/store/persistence";
import { hashAdminPassword } from "../auth/admin-password.utils";
import { DeviceOperationCoordinator } from "../devices/device-operation-coordinator";

const MIN_BACKOFFICE_PASSWORD_LENGTH = 12;
const tenantCodePattern = /^[a-z0-9][a-z0-9-]{1,49}$/;
const phonePattern = /^1\d{10}$/;

@Injectable()
export class PlatformService {
  constructor(
    @Inject(InMemoryStoreService) private readonly store: InMemoryStoreService,
    @Inject(DeviceOperationCoordinator) private readonly deviceOperations: DeviceOperationCoordinator
  ) {}

  listTenants() {
    return this.store.listPlatformTenants();
  }

  createTenantWithFirstAdmin(
    payload: PlatformTenantCreatePayload,
    actor?: { id: string; name: string }
  ): PlatformTenantProvisioningResult {
    if (this.store.isLiveDataPlane()) {
      throw new ConflictException("真实数据平面不能在线创建其他客户实例。");
    }

    const code = payload.code?.trim().toLowerCase();
    const name = payload.name?.trim();
    const serviceMode = payload.serviceMode ?? "simulation";
    const status = payload.status ?? "trial";
    const instanceUrl = this.normalizeInstanceUrl(payload.instanceUrl);
    const contactName = payload.contactName?.trim() || undefined;
    const contactPhone = payload.contactPhone?.trim() || undefined;
    const planName = payload.planName?.trim() || undefined;
    const firstAdminName = payload.firstAdmin?.name?.trim();
    const firstAdminPhone = payload.firstAdmin?.phone?.trim();
    const username = payload.firstAdmin?.username?.trim().toLowerCase();
    const password = payload.firstAdmin?.password ?? "";

    if (!tenantCodePattern.test(code)) {
      throw new BadRequestException("客户实例编码需为 2 至 50 位小写字母、数字或连字符。");
    }

    if (!name || [...name].length > 100 || /[\r\n]/.test(name)) {
      throw new BadRequestException("客户实例名称需为 1 至 100 个字符的单行文本。");
    }

    if (serviceMode !== "simulation" && serviceMode !== "production") {
      throw new BadRequestException("请选择模拟服务或正式服务。");
    }

    if (status !== "active" && status !== "trial" && status !== "paused") {
      throw new BadRequestException("请选择有效的客户实例状态。");
    }

    this.assertServiceModeCanUseStatus(serviceMode, status);

    if (contactPhone && !phonePattern.test(contactPhone)) {
      throw new BadRequestException("实例联系人手机号格式不正确。");
    }

    if (!firstAdminName || [...firstAdminName].length > 100 || /[\r\n]/.test(firstAdminName)) {
      throw new BadRequestException("首管理员姓名需为 1 至 100 个字符的单行文本。");
    }

    if (!phonePattern.test(firstAdminPhone)) {
      throw new BadRequestException("首管理员手机号格式不正确。");
    }

    if (!username || username.length > 100 || /[\r\n]/.test(username)) {
      throw new BadRequestException("首管理员后台账号格式不正确。");
    }

    if (password.trim().length < MIN_BACKOFFICE_PASSWORD_LENGTH) {
      throw new BadRequestException(
        `首管理员后台密码至少需要 ${MIN_BACKOFFICE_PASSWORD_LENGTH} 位。`
      );
    }

    if (this.store.platformTenants.some((entry) => entry.code.toLowerCase() === code)) {
      throw new ConflictException("客户实例编码已存在。");
    }

    if (
      instanceUrl &&
      this.store.platformTenants.some(
        (entry) =>
          this.readInstanceHostname(entry.instanceUrl) ===
          this.readInstanceHostname(instanceUrl)
      )
    ) {
      throw new ConflictException("客户实例域名已被占用。");
    }

    if (this.store.users.some((entry) => entry.phone === firstAdminPhone)) {
      throw new ConflictException("首管理员手机号已存在。");
    }

    if (this.store.findBackofficeCredentialByUsername(username)) {
      throw new ConflictException("首管理员后台账号已被占用。");
    }

    const now = new Date().toISOString();
    const tenant: PlatformTenantRecord = {
      id: this.store.createId("tenant"),
      code,
      name,
      serviceMode,
      status,
      instanceUrl,
      contactName,
      contactPhone,
      planName,
      createdAt: now
    };
    const user: UserRecord = {
      id: this.store.createId("admin"),
      tenantId: tenant.id,
      role: "admin",
      phone: firstAdminPhone,
      name: firstAdminName,
      status: "active",
      tags: ["实例管理员"],
      mobileProfileCompleted: true
    };
    const passwordHash = hashAdminPassword(password);
    const credential: BackofficeCredentialRecord = {
      userId: user.id,
      username,
      role: "admin",
      tenantId: tenant.id,
      permissions: [...BACKOFFICE_TENANT_BOOTSTRAP_PERMISSIONS],
      passwordSalt: passwordHash.salt,
      passwordHash: passwordHash.hash,
      usesDefaultPassword: false,
      passwordUpdatedAt: now
    };

    this.store.platformTenants.push(tenant);
    this.store.users.unshift(user);
    this.store.backofficeCredentials.unshift(credential);
    const operationLog = this.store.logOperation({
      category: "admin",
      type: "create-platform-tenant",
      status: "success",
      actor: {
        type: "admin",
        id: actor?.id ?? "system",
        name: actor?.name ?? "服务商",
        role: "admin"
      },
      primarySubject: {
        type: "user",
        id: user.id,
        label: user.name
      },
      metadata: {
        tenantId: tenant.id,
        tenantCode: tenant.code,
        serviceMode: tenant.serviceMode,
        username: credential.username,
        undoState: "not_undoable"
      }
    });

    try {
      this.store.persist();
    } catch (error) {
      this.store.platformTenants.splice(this.store.platformTenants.indexOf(tenant), 1);
      this.store.users.splice(this.store.users.indexOf(user), 1);
      this.store.backofficeCredentials.splice(
        this.store.backofficeCredentials.indexOf(credential),
        1
      );
      this.store.logs.splice(this.store.logs.indexOf(operationLog), 1);
      throw error;
    }

    return {
      tenant,
      firstAdmin: {
        userId: credential.userId,
        username: credential.username,
        role: credential.role,
        tenantId: credential.tenantId,
        tenantName: tenant.name,
        permissions: [...credential.permissions!],
        usesDefaultPassword: credential.usesDefaultPassword,
        passwordUpdatedAt: credential.passwordUpdatedAt
      }
    };
  }

  updateTenant(
    tenantId: string,
    payload: PlatformTenantUpdatePayload,
    actor?: { id: string; name: string }
  ): PlatformTenantRecord {
    if (this.store.isLiveDataPlane()) {
      throw new ConflictException("真实数据平面不能在线修改客户实例资料。");
    }

    const tenant = this.store.findPlatformTenantById(tenantId);

    if (!tenant) {
      throw new BadRequestException("未找到对应客户实例。");
    }

    const name = payload.name?.trim();
    const status = payload.status;
    const instanceUrl = this.normalizeInstanceUrl(payload.instanceUrl);
    const contactName = payload.contactName?.trim() || undefined;
    const contactPhone = payload.contactPhone?.trim() || undefined;
    const planName = payload.planName?.trim() || undefined;

    if (!name || [...name].length > 100 || /[\r\n]/.test(name)) {
      throw new BadRequestException("客户实例名称需为 1 至 100 个字符的单行文本。");
    }

    if (status !== "active" && status !== "trial" && status !== "paused") {
      throw new BadRequestException("请选择有效的客户实例状态。");
    }

    this.assertServiceModeCanUseStatus(tenant.serviceMode, status);

    if (contactPhone && !phonePattern.test(contactPhone)) {
      throw new BadRequestException("实例联系人手机号格式不正确。");
    }

    if (
      instanceUrl &&
      this.store.platformTenants.some(
        (entry) =>
          entry.id !== tenant.id &&
          this.readInstanceHostname(entry.instanceUrl) ===
            this.readInstanceHostname(instanceUrl)
      )
    ) {
      throw new ConflictException("客户实例域名已被占用。");
    }

    const previous = { ...tenant };
    Object.assign(tenant, {
      name,
      status,
      instanceUrl,
      contactName,
      contactPhone,
      planName
    });
    const operationLog = this.store.logOperation({
      category: "admin",
      type: "update-platform-tenant",
      status: "success",
      actor: {
        type: "admin",
        id: actor?.id ?? "system",
        name: actor?.name ?? "服务商",
        role: "admin"
      },
      primarySubject: {
        type: "user",
        id: tenant.id,
        label: tenant.name
      },
      metadata: {
        tenantId: tenant.id,
        tenantCode: tenant.code,
        status: tenant.status,
        undoState: "not_undoable"
      }
    });

    try {
      this.store.persist();
    } catch (error) {
      Object.assign(tenant, previous);
      this.store.logs.splice(this.store.logs.indexOf(operationLog), 1);
      throw error;
    }

    return tenant;
  }

  getOverview(): PlatformOverviewSnapshot {
    const tenants = this.store.listPlatformTenants().map((tenant): PlatformTenantUsageSummary => {
      const users = this.store.users.filter(
        (entry) => this.store.getUserTenantId(entry) === tenant.id
      );
      const devices = this.store.devices.filter(
        (entry) => this.store.getDeviceTenantId(entry) === tenant.id
      );
      const deviceCodes = new Set(devices.map((entry) => entry.deviceCode));
      const inventory = this.store.inventory.filter((entry) =>
        deviceCodes.has(entry.deviceCode)
      );
      const pendingTasks = this.store.alerts.filter(
        (entry) =>
          entry.status === "open" &&
          this.resolveAlertTenantId(entry) === tenant.id
      );
      const logs = this.store.logs.filter(
        (entry) => this.resolveOperationLogTenantId(entry) === tenant.id
      );
      const lastActivityAt = [
        ...inventory.map((entry) => entry.happenedAt),
        ...logs.map((entry) => entry.occurredAt),
        ...devices.map((entry) => entry.lastSeenAt)
      ]
        .filter((value): value is string => Boolean(value))
        .sort()
        .at(-1);

      return {
        tenant,
        metrics: {
          users: users.filter((entry) => entry.role === "special").length,
          merchants: users.filter((entry) => entry.role === "merchant").length,
          devices: devices.length,
          onlineDevices: devices.filter(
            (entry) => this.deviceOperations.getEffectiveStatus(entry.deviceCode) === "online"
          ).length,
          inventoryUnits: this.store.goodsBatches
            .filter((entry) => deviceCodes.has(entry.deviceCode))
            .reduce((sum, entry) => sum + entry.remainingQuantity, 0),
          pickupCount: inventory.filter((entry) => entry.type === "pickup").length,
          donationCount: inventory.filter((entry) => entry.type === "donation" || entry.type === "manual-restock").length,
          pendingTasks: pendingTasks.length,
          operationLogs: logs.length
        },
        lastActivityAt
      };
    });

    return {
      generatedAt: new Date().toISOString(),
      provisioningMode: this.store.isLiveDataPlane() ? "deployment" : "online",
      totals: {
        tenants: tenants.length,
        activeTenants: tenants.filter((entry) => entry.tenant.status === "active").length,
        users: this.sumMetric(tenants, "users"),
        merchants: this.sumMetric(tenants, "merchants"),
        devices: this.sumMetric(tenants, "devices"),
        onlineDevices: this.sumMetric(tenants, "onlineDevices"),
        inventoryUnits: this.sumMetric(tenants, "inventoryUnits"),
        pickupCount: this.sumMetric(tenants, "pickupCount"),
        donationCount: this.sumMetric(tenants, "donationCount"),
        pendingTasks: this.sumMetric(tenants, "pendingTasks"),
        operationLogs: this.sumMetric(tenants, "operationLogs")
      },
      tenants
    };
  }

  private sumMetric(
    tenants: PlatformTenantUsageSummary[],
    key: keyof PlatformTenantUsageSummary["metrics"]
  ) {
    return tenants.reduce((sum, entry) => sum + entry.metrics[key], 0);
  }

  private assertServiceModeCanUseStatus(
    serviceMode: PlatformTenantRecord["serviceMode"],
    status: PlatformTenantRecord["status"]
  ) {
    if (
      serviceMode === "production" &&
      status === "active" &&
      !this.store.isLiveDataPlane()
    ) {
      throw new ConflictException(
        "正式服务需在绑定的真实数据平面通过生产门禁后才能标记为运行中。"
      );
    }
  }

  private resolveAlertTenantId(alert: AlertTask) {
    if (alert.deviceCode) {
      const device = this.store.devices.find(
        (entry) => entry.deviceCode === alert.deviceCode
      );
      if (device) {
        return this.store.getDeviceTenantId(device);
      }
    }

    if (alert.targetUserId) {
      const user = this.store.users.find(
        (entry) => entry.id === alert.targetUserId
      );
      if (user) {
        return this.store.getUserTenantId(user);
      }
    }

    if (alert.relatedEventId) {
      const event = this.store.events.find(
        (entry) => entry.eventId === alert.relatedEventId
      );
      if (event) {
        const device = this.store.devices.find(
          (entry) => entry.deviceCode === event.deviceCode
        );
        if (device) {
          return this.store.getDeviceTenantId(device);
        }
      }
    }

    if (alert.sourceLogId) {
      const sourceLog = this.store.logs.find(
        (entry) => entry.id === alert.sourceLogId
      );
      if (sourceLog) {
        return this.resolveOperationLogTenantId(sourceLog);
      }
    }

    return this.store.getDefaultTenantId();
  }

  private resolveOperationLogTenantId(log: OperationLogRecord) {
    const metadataTenantId =
      typeof log.metadata?.tenantId === "string"
        ? log.metadata.tenantId
        : undefined;
    if (metadataTenantId && this.store.findPlatformTenantById(metadataTenantId)) {
      return metadataTenantId;
    }

    for (const subject of [log.primarySubject, log.secondarySubject]) {
      if (subject?.type === "device") {
        const device = this.store.devices.find(
          (entry) => entry.deviceCode === subject.id
        );
        if (device) {
          return this.store.getDeviceTenantId(device);
        }
      }

      if (subject?.type === "user") {
        const user = this.store.users.find((entry) => entry.id === subject.id);
        if (user) {
          return this.store.getUserTenantId(user);
        }
      }
    }

    if (log.actor.id) {
      const actor = this.store.users.find((entry) => entry.id === log.actor.id);
      if (actor) {
        return this.store.getUserTenantId(actor);
      }
    }

    if (log.relatedEventId) {
      const event = this.store.events.find(
        (entry) => entry.eventId === log.relatedEventId
      );
      const device = event
        ? this.store.devices.find(
            (entry) => entry.deviceCode === event.deviceCode
          )
        : undefined;
      if (device) {
        return this.store.getDeviceTenantId(device);
      }
    }

    return this.store.getDefaultTenantId();
  }

  private normalizeInstanceUrl(raw?: string) {
    const value = raw?.trim();

    if (!value) {
      return undefined;
    }

    let parsed: URL;

    try {
      parsed = new URL(value);
    } catch {
      throw new BadRequestException("客户实例地址必须是有效的完整 URL。");
    }

    if (
      (parsed.protocol !== "https:" && parsed.protocol !== "http:") ||
      parsed.username ||
      parsed.password ||
      parsed.search ||
      parsed.hash
    ) {
      throw new BadRequestException(
        "客户实例地址必须是不含账号、查询参数或片段的 HTTP(S) URL。"
      );
    }

    return value.replace(/\/+$/, "");
  }

  private readInstanceHostname(raw?: string) {
    if (!raw) {
      return undefined;
    }

    try {
      return new URL(raw).hostname.toLowerCase().replace(/\.$/, "");
    } catch {
      return undefined;
    }
  }
}
