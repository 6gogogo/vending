import { BadRequestException, Injectable } from "@nestjs/common";
import {
  createHash,
  randomBytes,
  randomInt,
  scryptSync,
  timingSafeEqual
} from "node:crypto";

import {
  BACKOFFICE_PROVIDER_PERMISSIONS,
  BACKOFFICE_ROLE_ALLOWED_PERMISSIONS,
  BACKOFFICE_TENANT_BOOTSTRAP_PERMISSIONS,
  BACKOFFICE_TENANT_PERMISSIONS,
  cloneSeedState,
  resolveBackofficePermissions,
  type BatchConsumptionTrace,
  type AlertTask,
  type BackofficePermission,
  type BackofficeRole,
  type CabinetAccessRule,
  type CabinetEventRecord,
  type CabinetReservationRecord,
  type CallbackLogRecord,
  type DeviceGoods,
  type DeviceGoodsSetting,
  type DeviceRuntimeState,
  type DeviceRecord,
  type ExpiredBatchDispositionRecord,
  type GoodsBatchSource,
  type GoodsAlertPolicy,
  type GoodsBatchRecord,
  type GoodsCatalogItem,
  type GoodsCategory,
  type GoodsCategoryRecord,
  type InventoryTransferRecord,
  type InventoryMovement,
  type MerchantGoodsTemplate,
  type OperationLogRecord,
  type PaymentOrderRecord,
  type PaymentRefundRecord,
  type PlatformTenantRecord,
  type RegionRecord,
  type RegistrationApplication,
  type ReservationSettings,
  type SpecialAccessPolicy,
  type StocktakeRecord,
  type UserRecord,
  type UserRole,
  type WarehouseRecord
} from "@vm/shared-types";

import {
  hashAdminPassword,
  verifyAdminPassword
} from "../../modules/auth/admin-password.utils";
import {
  createCallbackReplayFingerprint,
  summarizeCallbackPayload
} from "../logging/callback-log-sanitizer";
import { formatOperationLog } from "../logging/operation-log-template";
import {
  createSeededPersistedState,
  readPersistedStateWithMetadata,
  type AdminCredentialRecord,
  type BackofficeCredentialRecord,
  type DraftSessionRecord,
  type ExternalVerificationProvider,
  isControlledLiveBootstrapProcess,
  type ManualVerificationGrantRecord,
  type PersistedStoreState,
  PersistedStateWriteError,
  type SessionRecord,
  type VerificationPurpose,
  type VerificationRecord,
  writePersistedState
} from "./persistence";
import { validatePersistedState } from "./persisted-state-integrity";
import { isProductionRuntime } from "../config/runtime-environment";
import {
  assertFullSimulationIsolation,
  isFullSimulationProfile,
  resolveFullSimulationExternalMode
} from "../config/full-simulation-mode";
import {
  assertLivePlatformTenantConfiguration,
  createSimulationPlatformTenant,
  resolveLivePlatformTenantConfiguration,
  resolveRuntimeDataPlane,
  resolveRuntimeDataPlaneInstanceId,
  type RuntimeDataPlane
} from "../config/runtime-data-plane";

interface BatchConsumptionEntry {
  batchId: string;
  quantity: number;
  expiresAt?: string;
  sourceUserId?: string;
  sourceUserName?: string;
  selectionReason?: "specified" | "earliest_expiry" | "negative_balance";
}

const MAX_CALLBACK_LOGS = 1000;
const MAX_VERIFICATION_FAILURES = 5;
const SESSION_TTL_MS = 24 * 60 * 60_000;
const DRAFT_SESSION_TTL_MS = 30 * 60_000;
const NEGATIVE_STOCK_BALANCE_NOTE = "库存透支调整";
export const HIDDEN_BACKOFFICE_USER_TAG = "hidden-backoffice";
export const SUPER_ADMIN_TAG = "super-admin";
export const RESERVED_BACKOFFICE_USER_TAGS = new Set([
  HIDDEN_BACKOFFICE_USER_TAG,
  SUPER_ADMIN_TAG
]);
const DEFAULT_SUPER_ADMIN_USER_ID = "backoffice-super-admin";
const LEGACY_SUPER_ADMIN_USER_ID = "admin-root";
const DEFAULT_SUPER_ADMIN_USERNAME = "super";
const DEFAULT_SUPER_ADMIN_PASSWORD = "super123";
const DEFAULT_SUPER_ADMIN_PHONE = "13900000000";
const DEFAULT_SUPER_ADMIN_NAME = "服务商平台账号";
const DEFAULT_ADMIN_USERNAME = "admin";
const DEFAULT_ADMIN_PASSWORD = "admin";
const DEFAULT_ADMIN_PHONE = "13800000001";
const DEFAULT_ADMIN_NAME = "街道管理员";
const DEFAULT_MERCHANT_USERNAME = "merchant";
const DEFAULT_MERCHANT_PASSWORD = "merchant123";
const DEFAULT_MERCHANT_PHONE = "13800000004";
const DEFAULT_MERCHANT_NAME = "鲜食商家";
const DEFAULT_SUPER_ADMIN_REGION_NAME = "系统管理";
const MANUAL_APP_ACCEPTANCE_FIXTURE_DEVICE_CODE = "SIM-APP-ACCEPTANCE-001";
const MANUAL_APP_ACCEPTANCE_FIXTURE_GOODS: Omit<DeviceGoods, "stock" | "expiresAt"> = {
  goodsCode: "SIM-APP-RESERVE-PACK",
  goodsId: "goods-sim-app-reserve-pack",
  name: "公益食品体验包",
  fullName: "公益食品体验包",
  category: "food",
  categoryName: "食品",
  price: 0,
  imageUrl: "",
  packageForm: "体验装",
  specification: "1 份",
  manufacturer: "公益智助柜模拟服务",
  status: "active"
};

type OperationLogDraft = Omit<OperationLogRecord, "id" | "occurredAt" | "description" | "detail"> &
  Partial<Pick<OperationLogRecord, "id" | "occurredAt" | "description" | "detail">>;

type PersistedStateIntegrityStatus = "unverified" | "checking" | "ready" | "failed";

@Injectable()
export class InMemoryStoreService {
  private readonly seed = cloneSeedState();
  private readonly runtimeDataPlane: RuntimeDataPlane = resolveRuntimeDataPlane();
  private dataPlaneInstanceId: string = resolveRuntimeDataPlaneInstanceId();
  private initializationSource: PersistedStoreState["initializationSource"] =
    this.runtimeDataPlane === "live" ? "live-bootstrap-pending" : "simulation-seed";
  private persistenceFlags: PersistedStoreState["flags"];
  private bootstrapPersistencePending = false;
  private persistedStateIntegrityStatus: PersistedStateIntegrityStatus = "unverified";

  readonly users: UserRecord[] = this.seed.users;
  readonly rules: CabinetAccessRule[] = this.seed.rules;
  readonly devices: DeviceRecord[] = this.seed.devices;
  readonly goodsCatalog: GoodsCatalogItem[] = this.seed.goodsCatalog;
  readonly goodsCategories: GoodsCategoryRecord[] = this.seed.goodsCategories;
  readonly regions: RegionRecord[] = this.seed.regions;
  readonly warehouses: WarehouseRecord[] = this.seed.warehouses;
  readonly specialAccessPolicies: SpecialAccessPolicy[] = this.seed.specialAccessPolicies;
  readonly goodsAlertPolicies: GoodsAlertPolicy[] = this.seed.goodsAlertPolicies;
  readonly registrationApplications: RegistrationApplication[] = this.seed.registrationApplications;
  readonly merchantGoodsTemplates: MerchantGoodsTemplate[] = this.seed.merchantGoodsTemplates;
  readonly deviceGoodsSettings: DeviceGoodsSetting[] = this.seed.deviceGoodsSettings;
  readonly goodsBatches: GoodsBatchRecord[] = this.seed.goodsBatches;
  readonly batchConsumptionTraces: BatchConsumptionTrace[] = this.seed.batchConsumptionTraces;
  readonly inventoryTransfers: InventoryTransferRecord[] = this.seed.inventoryTransfers;
  readonly stocktakes: StocktakeRecord[] = this.seed.stocktakes;
  readonly expiredBatchDispositions: ExpiredBatchDispositionRecord[] = [];
  readonly events: CabinetEventRecord[] = this.seed.events;
  readonly inventory: InventoryMovement[] = this.seed.inventory;
  readonly paymentOrders: PaymentOrderRecord[] = [];
  readonly paymentRefunds: PaymentRefundRecord[] = [];
  readonly reservations: CabinetReservationRecord[] = [];
  readonly reservationSettings: ReservationSettings = {
    enabled: true,
    holdMinutes: 60,
    maxTimeouts: 3
  };
  readonly alerts: AlertTask[] = this.seed.alerts;
  readonly logs: OperationLogRecord[] = this.seed.logs.map((entry) => this.decorateStoredLog(entry));
  readonly platformTenants: PlatformTenantRecord[] =
    this.runtimeDataPlane === "simulation" ? [createSimulationPlatformTenant()] : [];

  readonly verificationCodes = new Map<string, VerificationRecord>();
  readonly manualVerificationGrants: ManualVerificationGrantRecord[] = [];
  private readonly activeManualVerificationGrantIds = new Map<string, string>();
  readonly sessions = new Map<string, SessionRecord>();
  readonly draftSessions = new Map<string, DraftSessionRecord>();
  readonly adminCredentials: AdminCredentialRecord[] = [];
  readonly backofficeCredentials: BackofficeCredentialRecord[] = [];
  readonly callbackLog: CallbackLogRecord[] = [];
  readonly deviceRuntime = new Map<string, DeviceRuntimeState>(
    this.seed.devices.map((device) => [
      device.deviceCode,
      {
        deviceCode: device.deviceCode,
        doorState: "closed",
        lastOpenedAt: this.seed.events
          .filter((event) => event.deviceCode === device.deviceCode)
          .map((event) => event.updatedAt)
          .sort()
          .at(-1),
        lastClosedAt: this.seed.events
          .filter((event) => event.deviceCode === device.deviceCode)
          .map((event) => event.updatedAt)
          .sort()
          .at(-1),
        lastRefreshAt: device.lastSeenAt,
        openedAfterLastCommand: true
      }
    ])
  );

  constructor() {
    const persistedResult = readPersistedStateWithMetadata();
    const persisted = persistedResult?.state;

    if (!persisted && this.runtimeDataPlane === "live") {
      throw new Error(
        "真实数据平面尚未初始化；请先使用受控的真实初始化命令创建空库和首个超级管理员。"
      );
    }

    this.persistenceFlags = persisted?.flags;
    let shouldPersist = false;

    if (persisted) {
      this.hydrate(persisted);
      if (
        this.isLiveDataPlane() &&
        this.initializationSource !== "live-bootstrap" &&
        !isControlledLiveBootstrapProcess()
      ) {
        throw new Error(
          "真实数据平面初始化尚未完成；常规 API 进程不能加载待初始化的真实库。"
        );
      }
      // 只恢复不含手机号和验证码原文的短期挑战；旧版明文认证状态仍会被清除。
      shouldPersist =
        Boolean(persistedResult?.requiresPrivacyRewrite) ||
        Boolean(persistedResult?.requiresDataPlaneRewrite) ||
        persisted.verificationCodes.length !== this.verificationCodes.size ||
        persisted.manualVerificationGrants.length !==
          this.manualVerificationGrants.length ||
        persisted.sessions.length > 0 ||
        persisted.draftSessions.length > 0;
    } else {
      shouldPersist = true;
    }

    shouldPersist = this.normalizeRegionsState() || shouldPersist;
    shouldPersist = this.ensureBootstrapAdmin() || shouldPersist;
    shouldPersist = this.normalizeLegacyUserTenantOwnership() || shouldPersist;

    const testDeviceBootstrapRequested = ["1", "true", "yes", "on"].includes(
      (process.env.ENABLE_TEST_DEVICE_BOOTSTRAP ?? "").trim().toLowerCase()
    );

    if (this.isLiveDataPlane() && testDeviceBootstrapRequested) {
      throw new Error("真实数据平面禁止启用 ENABLE_TEST_DEVICE_BOOTSTRAP。");
    }

    const allowTestDeviceBootstrap =
      !isProductionRuntime() && !this.isLiveDataPlane() && testDeviceBootstrapRequested;

    if (allowTestDeviceBootstrap && !persisted?.flags?.skipCompetitionTestDevice) {
      this.ensureCompetitionTestDevice();
    }
    shouldPersist = this.ensureManualAppAcceptanceFixture() || shouldPersist;
    this.syncDeviceStocksFromBatches();
    this.refreshAlertPresentation();
    this.refreshPersistedStateIntegrityStatus();

    // Nest 构造依赖图时保持只读；由 main 在取得进程级金融租约后统一落盘。
    this.bootstrapPersistencePending = shouldPersist;
  }

  flushBootstrapPersistence() {
    if (!this.bootstrapPersistencePending) {
      return false;
    }

    this.persist();
    this.bootstrapPersistencePending = false;
    return true;
  }

  getRuntimeDataPlaneIdentity() {
    return {
      dataPlane: this.runtimeDataPlane,
      instanceId: this.dataPlaneInstanceId,
      initializationSource: this.initializationSource
    };
  }

  isLiveDataPlane() {
    return this.runtimeDataPlane === "live";
  }

  /**
   * 仅由受控真实初始化脚本调用。待初始化快照保持完全空白，避免把错误历史数据当作新库；
   * 首个管理员写入前才将部署绑定的唯一当前租户加入同一次持久化快照。
   */
  initializeLivePlatformTenant() {
    if (!this.isLiveDataPlane()) {
      throw new BadRequestException("只有真实数据平面可以创建真实客户实例。");
    }

    if (!isControlledLiveBootstrapProcess()) {
      throw new BadRequestException("真实客户实例只能由受控初始化命令创建。");
    }

    if (this.initializationSource !== "live-bootstrap-pending") {
      throw new BadRequestException("真实数据平面不处于可创建客户实例的待初始化状态。");
    }

    if (this.platformTenants.length !== 0) {
      throw new BadRequestException("待初始化真实数据平面已含有客户实例，已拒绝覆盖。");
    }

    const tenant = resolveLivePlatformTenantConfiguration();

    if (tenant.id !== this.dataPlaneInstanceId) {
      throw new BadRequestException("真实客户实例 ID 与受控数据平面不一致。");
    }

    this.platformTenants.push({
      id: tenant.id,
      code: "current",
      name: tenant.name,
      serviceMode: "production",
      status: "active",
      instanceUrl: tenant.instanceUrl,
      contactName: "实例管理员",
      planName: "正式版",
      createdAt: new Date().toISOString()
    });
  }

  /**
   * 仅由受控真实库初始化脚本在写入首个非默认超级管理员后调用。
   * 该标记会随状态落盘，并作为生产启动门禁的一部分，防止空库或中断初始化被误当成可上线数据。
   */
  completeLiveDataPlaneBootstrap() {
    if (!this.isLiveDataPlane()) {
      throw new BadRequestException("只有真实数据平面可以完成真实库初始化。");
    }

    if (this.initializationSource !== "live-bootstrap-pending") {
      throw new BadRequestException("真实数据平面初始化状态不允许重复完成。");
    }

    assertLivePlatformTenantConfiguration(this.platformTenants);

    if (this.adminCredentials.length > 0) {
      throw new BadRequestException("真实数据平面不能在初始化时写入旧管理员密码凭据。");
    }

    const hasActiveNonDefaultSuperAdmin = this.backofficeCredentials.some((credential) => {
      if (credential.role !== "super_admin" || credential.usesDefaultPassword !== false) {
        return false;
      }

      const user = this.users.find((entry) => entry.id === credential.userId);
      return user?.role === "admin" && user.status === "active";
    });

    if (!hasActiveNonDefaultSuperAdmin) {
      throw new BadRequestException("真实数据平面初始化必须先创建有效的超级管理员账号。");
    }

    this.initializationSource = "live-bootstrap";
  }

  createId(prefix: string) {
    return `${this.normalizePrefix(prefix)}-${this.createCompactSuffix()}`;
  }

  private normalizeRegionsState() {
    let changed = false;
    const seedRegionMap = new Map(this.seed.regions.map((entry) => [entry.id, entry]));
    const nextRegions: RegionRecord[] = [];

    for (const region of this.regions) {
      if (region.id === "region-other" || region.name.trim() === "其他") {
        changed = true;
        continue;
      }

      const seededRegion = seedRegionMap.get(region.id);

      if (seededRegion?.longitude !== undefined && region.longitude === undefined) {
        region.longitude = seededRegion.longitude;
        changed = true;
      }

      if (seededRegion?.latitude !== undefined && region.latitude === undefined) {
        region.latitude = seededRegion.latitude;
        changed = true;
      }

      nextRegions.push(region);
    }

    if (nextRegions.length !== this.regions.length) {
      this.regions.splice(0, this.regions.length, ...nextRegions);
    }

    return changed;
  }

  createReference(prefix: string) {
    return `${this.normalizePrefix(prefix)}-${this.createCompactSuffix(4)}`;
  }

  issueVerificationCode(phone: string, purpose: VerificationPurpose = "general") {
    const code = randomInt(100_000, 1_000_000).toString();
    const now = Date.now();
    const expiresAt = new Date(now + 5 * 60_000).toISOString();
    const requestedAt = new Date(now).toISOString();
    const resendAvailableAt = new Date(now + 60_000).toISOString();
    this.verificationCodes.set(this.getVerificationCodeKey(phone, purpose), {
      code,
      purpose,
      challengeId: this.createSecureToken("challenge"),
      expiresAt,
      requestedAt,
      resendAvailableAt,
      failedAttempts: 0
    });
    return code;
  }

  rememberVerificationRequest(
    phone: string,
    purpose: VerificationPurpose,
    externalProvider: ExternalVerificationProvider
  ) {
    const now = Date.now();
    const key = this.getVerificationCodeKey(phone, purpose);
    const challengeId = this.createSecureToken("challenge");

    this.verificationCodes.set(key, {
      code: "",
      purpose,
      challengeId,
      externalChallenge: true,
      externalProvider,
      externalChallengeId: challengeId,
      expiresAt: new Date(now + 5 * 60_000).toISOString(),
      requestedAt: new Date(now).toISOString(),
      resendAvailableAt: new Date(now + 60_000).toISOString(),
      failedAttempts: 0
    });
    this.persist();
  }

  issueManualVerificationGrant(payload: {
    phone: string;
    purpose: Extract<VerificationPurpose, "app-login" | "password-reset">;
    code: string;
    issuerUserId: string;
    targetUserId: string;
    tenantId: string;
    expiresInSeconds: number;
  }) {
    const now = Date.now();
    const nowIso = new Date(now).toISOString();
    const challengeKey = this.getVerificationCodeKey(
      payload.phone,
      payload.purpose
    );
    const manualGrantId = this.createSecureToken("manual-code");
    const previousGrant = this.findActiveManualVerificationGrant(challengeKey);

    if (previousGrant) {
      if (!this.expireManualVerificationGrant(previousGrant, now)) {
        previousGrant.supersededAt = nowIso;
        previousGrant.supersededByGrantId = manualGrantId;
        this.clearManualVerificationSecret(previousGrant);
        this.activeManualVerificationGrantIds.delete(challengeKey);
        this.logManualVerificationTransition(
          previousGrant,
          "supersede-manual-verification-code",
          { supersededByGrantId: manualGrantId }
        );
      }
    }

    const codeSalt = randomBytes(16).toString("base64url");
    const codeHash = this.hashManualVerificationCode(payload.code, codeSalt);
    const record: ManualVerificationGrantRecord = {
      manualGrantId,
      challengeKey,
      purpose: payload.purpose,
      issuerUserId: payload.issuerUserId,
      targetUserId: payload.targetUserId,
      tenantId: payload.tenantId,
      phoneHash: createHash("sha256")
        .update(
          `${this.dataPlaneInstanceId}\0${payload.tenantId}\0${payload.phone}`,
          "utf8"
        )
        .digest("hex"),
      codeSalt,
      codeHash,
      expiresAt: new Date(now + payload.expiresInSeconds * 1_000).toISOString(),
      requestedAt: nowIso,
      failedAttempts: 0
    };

    this.manualVerificationGrants.unshift(record);
    this.activeManualVerificationGrantIds.set(challengeKey, manualGrantId);
    this.persist();
    return structuredClone(record);
  }

  checkManualVerificationGrant(
    phone: string,
    code: string,
    purpose: VerificationPurpose
  ): {
    handled: boolean;
    verified: boolean;
    tenantId?: string;
    targetUserId?: string;
    grantId?: string;
  } {
    const challengeKey = this.getVerificationCodeKey(phone, purpose);
    const record = this.findActiveManualVerificationGrant(challengeKey);

    if (!record) {
      return { handled: false, verified: false };
    }

    const result = {
      handled: true,
      verified: false,
      tenantId: record.tenantId,
      targetUserId: record.targetUserId,
      grantId: record.manualGrantId
    };

    if (this.expireManualVerificationGrant(record)) {
      this.persist();
      return result;
    }

    if (!record.codeSalt || !record.codeHash) {
      record.lockedAt = new Date().toISOString();
      this.activeManualVerificationGrantIds.delete(challengeKey);
      this.clearManualVerificationSecret(record);
      this.logManualVerificationTransition(
        record,
        "lock-manual-verification-code"
      );
      this.persist();
      return result;
    }

    const expected = Buffer.from(record.codeHash, "base64url");
    const received = Buffer.from(
      this.hashManualVerificationCode(code, record.codeSalt),
      "base64url"
    );

    if (
      expected.length !== received.length ||
      !timingSafeEqual(expected, received)
    ) {
      record.failedAttempts += 1;

      if (record.failedAttempts >= MAX_VERIFICATION_FAILURES) {
        record.lockedAt = new Date().toISOString();
        this.activeManualVerificationGrantIds.delete(challengeKey);
        this.clearManualVerificationSecret(record);
        this.logManualVerificationTransition(
          record,
          "lock-manual-verification-code"
        );
      } else {
        this.logManualVerificationTransition(
          record,
          "fail-manual-verification-code"
        );
      }
      this.persist();
      return result;
    }

    return {
      ...result,
      verified: true
    };
  }

  consumeManualVerificationGrant(
    phone: string,
    purpose: VerificationPurpose,
    grantId: string,
    shouldPersist = true
  ) {
    const challengeKey = this.getVerificationCodeKey(phone, purpose);
    const record = this.findActiveManualVerificationGrant(challengeKey);

    if (
      !record ||
      record.manualGrantId !== grantId ||
      this.isManualVerificationGrantTerminal(record)
    ) {
      return false;
    }

    if (this.expireManualVerificationGrant(record)) {
      if (shouldPersist) {
        this.persist();
      }
      return false;
    }

    record.consumedAt = new Date().toISOString();
    this.activeManualVerificationGrantIds.delete(challengeKey);
    this.clearManualVerificationSecret(record);
    this.logManualVerificationTransition(
      record,
      "consume-manual-verification-code"
    );
    if (shouldPersist) {
      this.persist();
    }
    return true;
  }

  tryVerifyManualVerificationGrant(
    phone: string,
    code: string,
    purpose: VerificationPurpose
  ) {
    const checked = this.checkManualVerificationGrant(phone, code, purpose);

    if (!checked.handled || !checked.verified || !checked.grantId) {
      return checked;
    }

    return {
      ...checked,
      verified: this.consumeManualVerificationGrant(
        phone,
        purpose,
        checked.grantId
      )
    };
  }

  listManualVerificationGrants(tenantId: string) {
    const changed = this.expireManualVerificationGrants();
    if (changed) {
      this.persist();
    }

    return this.manualVerificationGrants
      .filter(
        (record) => record.tenantId === tenantId
      )
      .map((record) => structuredClone(record))
      .sort((left, right) => right.requestedAt.localeCompare(left.requestedAt));
  }

  revokeManualVerificationGrant(grantId: string, tenantId: string) {
    const record = this.manualVerificationGrants.find(
      (entry) =>
        entry.manualGrantId === grantId &&
        entry.tenantId === tenantId
    );

    if (!record) {
      return undefined;
    }

    if (this.expireManualVerificationGrant(record)) {
      this.persist();
      return undefined;
    }

    if (this.isManualVerificationGrantTerminal(record)) {
      return undefined;
    }

    record.revokedAt = new Date().toISOString();
    if (
      this.activeManualVerificationGrantIds.get(record.challengeKey) ===
      record.manualGrantId
    ) {
      this.activeManualVerificationGrantIds.delete(record.challengeKey);
    }
    this.clearManualVerificationSecret(record);
    this.persist();
    return structuredClone(record);
  }

  getVerificationRecord(phone: string, purpose: VerificationPurpose = "general") {
    return this.verificationCodes.get(this.getVerificationCodeKey(phone, purpose));
  }

  getVerificationChallengeId(
    phone: string,
    purpose: VerificationPurpose = "general"
  ) {
    const record = this.getVerificationRecord(phone, purpose);
    return record?.challengeId ?? record?.externalChallengeId;
  }

  getExternalVerificationChallengeId(
    phone: string,
    purpose: VerificationPurpose,
    externalProvider: ExternalVerificationProvider
  ) {
    const record = this.getVerificationRecord(phone, purpose);

    if (
      record?.externalChallenge !== true ||
      !record?.externalChallengeId ||
      !this.canAttemptVerification(phone, purpose, externalProvider)
    ) {
      return undefined;
    }

    return record.externalChallengeId;
  }

  checkCode(phone: string, code: string, purpose: VerificationPurpose = "general") {
    const record = this.getVerificationRecord(phone, purpose);

    if (!record || !this.canAttemptVerification(phone, purpose)) {
      return false;
    }

    if (record.code !== code) {
      this.recordVerificationFailure(phone, purpose);
      return false;
    }

    return true;
  }

  verifyCode(phone: string, code: string, purpose: VerificationPurpose = "general") {
    const challengeId = this.getVerificationChallengeId(phone, purpose);
    return (
      this.checkCode(phone, code, purpose) &&
      this.consumeVerificationRequest(phone, purpose, challengeId)
    );
  }

  canAttemptVerification(
    phone: string,
    purpose: VerificationPurpose = "general",
    externalProvider?: ExternalVerificationProvider
  ) {
    const record = this.getVerificationRecord(phone, purpose);

    return Boolean(
      record &&
      !record.consumedAt &&
      !record.revokedAt &&
      this.isFutureExpiration(record.expiresAt) &&
      (record.failedAttempts ?? 0) < MAX_VERIFICATION_FAILURES &&
      (!externalProvider || record.externalProvider === externalProvider)
    );
  }

  recordVerificationFailure(
    phone: string,
    purpose: VerificationPurpose = "general",
    externalChallengeId?: string
  ) {
    const record = this.getVerificationRecord(phone, purpose);

    if (
      !record ||
      (externalChallengeId && record.externalChallengeId !== externalChallengeId) ||
      record.consumedAt ||
      record.revokedAt ||
      !this.isFutureExpiration(record.expiresAt)
    ) {
      return false;
    }

    record.failedAttempts = Math.min(
      MAX_VERIFICATION_FAILURES,
      (record.failedAttempts ?? 0) + 1
    );
    if (record.externalChallenge) {
      this.persist();
    }
    return true;
  }

  consumeVerificationRequest(
    phone: string,
    purpose: VerificationPurpose = "general",
    challengeId?: string,
    shouldPersist = true
  ) {
    const record = this.getVerificationRecord(phone, purpose);
    const currentChallengeId =
      record?.challengeId ?? record?.externalChallengeId;

    if (
      !record ||
      (challengeId !== undefined && currentChallengeId !== challengeId) ||
      !this.canAttemptVerification(phone, purpose)
    ) {
      return false;
    }

    record.code = "";
    record.consumedAt = new Date().toISOString();
    if (record.externalChallenge && shouldPersist) {
      this.persist();
    }
    return true;
  }

  runBackofficePasswordResetTransaction<T>(mutation: () => T): T {
    const checkpoint = {
      verificationCodes: Array.from(this.verificationCodes.entries()).map(
        ([key, record]) =>
          [key, structuredClone(record)] as [string, VerificationRecord]
      ),
      manualVerificationGrants: structuredClone(
        this.manualVerificationGrants
      ),
      activeManualVerificationGrantIds: Array.from(
        this.activeManualVerificationGrantIds.entries()
      ),
      adminCredentials: structuredClone(this.adminCredentials),
      backofficeCredentials: structuredClone(this.backofficeCredentials),
      logs: structuredClone(this.logs),
      sessions: Array.from(this.sessions.entries()).map(
        ([token, session]) =>
          [token, structuredClone(session)] as [string, SessionRecord]
      ),
      draftSessions: Array.from(this.draftSessions.entries()).map(
        ([token, session]) =>
          [token, structuredClone(session)] as [string, DraftSessionRecord]
      )
    };

    try {
      const result = mutation();
      this.persist();
      return result;
    } catch (error) {
      if (error instanceof PersistedStateWriteError && error.committed) {
        throw error;
      }

      this.verificationCodes.clear();
      for (const [key, record] of checkpoint.verificationCodes) {
        this.verificationCodes.set(key, record);
      }
      this.replaceArray(
        this.manualVerificationGrants,
        checkpoint.manualVerificationGrants
      );
      this.activeManualVerificationGrantIds.clear();
      for (const [key, grantId] of checkpoint.activeManualVerificationGrantIds) {
        this.activeManualVerificationGrantIds.set(key, grantId);
      }
      this.replaceArray(this.adminCredentials, checkpoint.adminCredentials);
      this.replaceArray(
        this.backofficeCredentials,
        checkpoint.backofficeCredentials
      );
      this.replaceArray(this.logs, checkpoint.logs);
      this.sessions.clear();
      for (const [token, session] of checkpoint.sessions) {
        this.sessions.set(token, session);
      }
      this.draftSessions.clear();
      for (const [token, session] of checkpoint.draftSessions) {
        this.draftSessions.set(token, session);
      }
      throw error;
    }
  }

  createSession(user: UserRecord) {
    const token = this.createSecureToken("session");
    const now = Date.now();
    const mobileAdminCredential =
      user.role === "admin" ? this.findAdminCredentialByUserId(user.id) : undefined;
    const mobileAdminTenantCredential =
      user.role === "admin" ? this.findBackofficeCredentialByUserId(user.id, "admin") : undefined;
    this.sessions.set(token, {
      token,
      userId: user.id,
      role: user.role,
      tenantId:
        mobileAdminTenantCredential?.tenantId ?? this.getUserTenantId(user),
      mobileAdminCredentialUpdatedAt: mobileAdminCredential?.passwordUpdatedAt,
      mobileAdminTenantCredentialUpdatedAt: mobileAdminTenantCredential?.passwordUpdatedAt,
      createdAt: new Date(now).toISOString(),
      expiresAt: new Date(now + SESSION_TTL_MS).toISOString()
    });
    return token;
  }

  createBackofficeSession(user: UserRecord, backofficeRole: BackofficeRole, tenantId?: string) {
    const token = this.createSecureToken("session");
    const now = Date.now();
    this.sessions.set(token, {
      token,
      userId: user.id,
      role: user.role,
      backofficeRole,
      tenantId,
      createdAt: new Date(now).toISOString(),
      expiresAt: new Date(now + SESSION_TTL_MS).toISOString()
    });
    return token;
  }

  listPlatformTenants() {
    return this.platformTenants;
  }

  findPlatformTenantById(tenantId?: string) {
    return tenantId ? this.platformTenants.find((entry) => entry.id === tenantId) : undefined;
  }

  isPlatformTenantOperationalInCurrentDataPlane(tenantId?: string) {
    const tenant = this.findPlatformTenantById(tenantId);

    if (!tenant || tenant.status === "paused") {
      return false;
    }

    if (this.isLiveDataPlane()) {
      return tenant.serviceMode === "production" && tenant.status === "active";
    }

    return tenant.serviceMode === "simulation";
  }

  getUserTenantId(user: UserRecord) {
    // 构造阶段会迁移明确的旧单实例记录。运行期仍无 tenantId 的人员属于歧义
    // 隔离记录：调用方只能得到 undefined，不能把凭据或默认实例当作归属证明。
    return user.tenantId;
  }

  getDeviceTenantId(device: DeviceRecord) {
    return device.tenantId ?? this.getDefaultTenantId();
  }

  getDefaultTenantId() {
    const currentTenant = this.platformTenants[0];

    if (!currentTenant) {
      throw new Error("当前数据平面缺少受控平台租户，已拒绝继续处理后台会话。");
    }

    return currentTenant.id;
  }

  createDraftSession(payload: {
    tenantId: string;
    phone: string;
    requestedRole?: UserRole;
    linkedUserId?: string;
    applicationId?: string;
  }) {
    const token = this.createSecureToken("draft");
    const now = Date.now();
    this.draftSessions.set(token, {
      token,
      tenantId: payload.tenantId,
      phone: payload.phone,
      requestedRole: payload.requestedRole,
      linkedUserId: payload.linkedUserId,
      applicationId: payload.applicationId,
      createdAt: new Date(now).toISOString(),
      expiresAt: new Date(now + DRAFT_SESSION_TTL_MS).toISOString()
    });
    return token;
  }

  getSession(token?: string) {
    if (!token) {
      return undefined;
    }

    const session = this.sessions.get(token);

    if (!session || !this.isFutureExpiration(session.expiresAt)) {
      this.sessions.delete(token);
      return undefined;
    }

    return session;
  }

  getSessionUser(token?: string) {
    const session = this.getSession(token);

    if (!session) {
      return undefined;
    }

    const user = this.users.find((entry) => entry.id === session.userId);

    if (
      session.tenantId &&
      !this.isPlatformTenantOperationalInCurrentDataPlane(session.tenantId)
    ) {
      this.sessions.delete(session.token);
      return undefined;
    }

    if (!session.backofficeRole && session.role === "admin") {
      const mobileAdminCredential = this.findAdminCredentialByUserId(session.userId);
      const mobileAdminTenantCredential = this.findBackofficeCredentialByUserId(
        session.userId,
        "admin"
      );
      const mobileAdminBindingIsValid = Boolean(
        mobileAdminCredential &&
          mobileAdminTenantCredential &&
          session.tenantId === this.getDefaultTenantId() &&
          mobileAdminTenantCredential.tenantId === session.tenantId &&
          session.mobileAdminCredentialUpdatedAt === mobileAdminCredential.passwordUpdatedAt &&
          session.mobileAdminTenantCredentialUpdatedAt ===
            mobileAdminTenantCredential.passwordUpdatedAt
      );

      if (!mobileAdminBindingIsValid) {
        this.sessions.delete(session.token);
        return undefined;
      }
    }

    // 非默认实例目前只开放人员、柜机与后台凭证的安全启动域。会话必须同时满足：
    // 实例仍存在、凭证仍绑定该实例、权限没有越过启动域；任一条件失效都立即撤销。
    if (
      session.backofficeRole &&
      session.backofficeRole !== "super_admin" &&
      session.tenantId !== this.getDefaultTenantId()
    ) {
      const credential = this.findBackofficeCredentialByUserId(
        session.userId,
        session.backofficeRole
      );
      const safeTenantPermissions = new Set<BackofficePermission>(
        session.backofficeRole === "restocker"
          ? BACKOFFICE_ROLE_ALLOWED_PERMISSIONS.restocker
          : BACKOFFICE_TENANT_BOOTSTRAP_PERMISSIONS
      );
      const bindingIsValid = Boolean(
        session.tenantId &&
          this.findPlatformTenantById(session.tenantId) &&
          credential?.tenantId === session.tenantId &&
          this.getBackofficeSessionPermissions(session).every((permission) =>
            safeTenantPermissions.has(permission)
          )
      );

      if (!bindingIsValid) {
        this.sessions.delete(session.token);
        return undefined;
      }
    }

    if (!user || user.status !== "active" || user.role !== session.role) {
      this.sessions.delete(session.token);
      return undefined;
    }

    return user;
  }

  revokeSession(token?: string) {
    if (!token) {
      return false;
    }

    return this.sessions.delete(token);
  }

  revokeSessionsForUser(userId: string, exceptToken?: string) {
    let revokedCount = 0;

    for (const [token, session] of this.sessions.entries()) {
      if (session.userId !== userId || token === exceptToken) {
        continue;
      }

      this.sessions.delete(token);
      revokedCount += 1;
    }

    for (const [token, draft] of this.draftSessions.entries()) {
      if (draft.linkedUserId !== userId) {
        continue;
      }

      this.draftSessions.delete(token);
      revokedCount += 1;
    }

    return revokedCount;
  }

  getBackofficeSessionUser(token?: string) {
    const session = this.getSession(token);

    if (!session?.backofficeRole) {
      return undefined;
    }

    const user = this.getSessionUser(token);
    const credential = this.findBackofficeCredentialByUserId(
      session.userId,
      session.backofficeRole
    );

    if (
      !user ||
      !credential ||
      !this.isBackofficeCredentialValidForUser(user, credential) ||
      (session.backofficeRole === "super_admin"
        ? credential.tenantId !== undefined
        : credential.tenantId !== session.tenantId)
    ) {
      this.sessions.delete(session.token);
      return undefined;
    }

    return {
      session,
      user
    };
  }

  getDraftSession(token?: string) {
    if (!token) {
      return undefined;
    }

    const draft = this.draftSessions.get(token);

    const linkedUser = draft?.linkedUserId
      ? this.users.find((entry) => entry.id === draft.linkedUserId)
      : undefined;
    const linkedApplication = draft?.applicationId
      ? this.registrationApplications.find(
          (entry) => entry.id === draft.applicationId
        )
      : undefined;
    const linkedUserInvalid = Boolean(
      draft?.linkedUserId &&
      (!linkedUser ||
        linkedUser.status !== "active" ||
        this.getUserTenantId(linkedUser) !== draft.tenantId ||
        (draft.requestedRole !== undefined && draft.requestedRole !== linkedUser.role))
    );
    const linkedApplicationInvalid = Boolean(
      draft?.applicationId &&
      (!linkedApplication ||
        (linkedApplication.tenantId ?? this.getDefaultTenantId()) !==
          draft.tenantId)
    );
    const tenantInvalid = Boolean(
      draft &&
        !this.isPlatformTenantOperationalInCurrentDataPlane(draft.tenantId)
    );

    if (
      !draft ||
      !this.isFutureExpiration(draft.expiresAt) ||
      linkedUserInvalid ||
      linkedApplicationInvalid ||
      tenantInvalid
    ) {
      this.draftSessions.delete(token);
      return undefined;
    }

    return draft;
  }

  findAdminCredentialByUsername(username: string) {
    const normalizedUsername = username.trim().toLowerCase();

    if (!normalizedUsername) {
      return undefined;
    }

    return this.adminCredentials.find((entry) => {
      if (entry.username.trim().toLowerCase() !== normalizedUsername) {
        return false;
      }

      return this.users.some(
        (user) => user.id === entry.userId && user.role === "admin" && user.status === "active"
      );
    });
  }

  findAdminCredentialByUserId(userId: string) {
    return this.adminCredentials.find((entry) => entry.userId === userId);
  }

  upsertAdminCredential(record: AdminCredentialRecord) {
    const existing = this.findAdminCredentialByUserId(record.userId);

    if (existing) {
      Object.assign(existing, record);
      this.synchronizeLinkedAdminCredentials(record.userId, "legacy");
      return existing;
    }

    this.adminCredentials.unshift(record);
    this.synchronizeLinkedAdminCredentials(record.userId, "legacy");
    return record;
  }

  findBackofficeCredentialByUsername(username: string) {
    const normalizedUsername = username.trim().toLowerCase();

    if (!normalizedUsername) {
      return undefined;
    }

    return this.backofficeCredentials.find((entry) => {
      if (entry.username.trim().toLowerCase() !== normalizedUsername) {
        return false;
      }

      return this.users.some(
        (user) => user.id === entry.userId && this.isUserValidForBackofficeRole(user, entry.role)
      );
    });
  }

  findBackofficeCredentialByUserId(userId: string, role?: BackofficeRole) {
    return this.backofficeCredentials.find(
      (entry) => entry.userId === userId && (!role || entry.role === role)
    );
  }

  /**
   * 仅供受控 VNC 本机首次改密维护识别模拟平面中的内建服务商账号。
   * 不暴露默认口令，也不允许调用方指定用户名、用户、租户或角色。
   */
  isDefaultSuperAdminBootstrapCredential(credential: BackofficeCredentialRecord) {
    const user = this.users.find((entry) => entry.id === credential.userId);

    return Boolean(
      (credential.userId === DEFAULT_SUPER_ADMIN_USER_ID ||
        credential.userId === LEGACY_SUPER_ADMIN_USER_ID) &&
        credential.username === DEFAULT_SUPER_ADMIN_USERNAME &&
        credential.role === "super_admin" &&
        credential.tenantId === undefined &&
        credential.usesDefaultPassword &&
        user &&
        user.role === "admin" &&
        user.status === "active" &&
        user.tags.includes(SUPER_ADMIN_TAG) &&
        user.tags.includes(HIDDEN_BACKOFFICE_USER_TAG) &&
        verifyAdminPassword(
          DEFAULT_SUPER_ADMIN_PASSWORD,
          credential.passwordSalt,
          credential.passwordHash
        )
    );
  }

  upsertBackofficeCredential(record: BackofficeCredentialRecord) {
    const existing = this.findBackofficeCredentialByUserId(record.userId, record.role);
    const normalizedRecord = {
      ...record,
      permissions: record.permissions
        ? resolveBackofficePermissions(record.role, record.permissions)
        : undefined
    };

    if (existing) {
      Object.assign(existing, normalizedRecord);
      if (normalizedRecord.role === "admin") {
        this.synchronizeLinkedAdminCredentials(normalizedRecord.userId, "backoffice");
      }
      return existing;
    }

    this.backofficeCredentials.unshift(normalizedRecord);
    if (normalizedRecord.role === "admin") {
      this.synchronizeLinkedAdminCredentials(normalizedRecord.userId, "backoffice");
    }
    return normalizedRecord;
  }

  getBackofficePermissions(userId: string, role: BackofficeRole): BackofficePermission[] {
    const credential = this.findBackofficeCredentialByUserId(userId, role);
    return resolveBackofficePermissions(role, credential?.permissions);
  }

  getBackofficeSessionPermissions(session?: SessionRecord): BackofficePermission[] {
    if (!session?.backofficeRole) {
      return [];
    }

    if (session.backofficeRole === "super_admin") {
      if (!session.tenantId) {
        return [...BACKOFFICE_PROVIDER_PERMISSIONS];
      }

      return session.tenantId === this.getDefaultTenantId()
        ? [...BACKOFFICE_TENANT_PERMISSIONS]
        : [...BACKOFFICE_TENANT_BOOTSTRAP_PERMISSIONS];
    }

    return this.getBackofficePermissions(session.userId, session.backofficeRole);
  }

  getBackofficeScope(role: BackofficeRole, tenantId?: string) {
    return role === "super_admin" && !tenantId ? "provider" : "tenant";
  }

  isUserValidForBackofficeRole(user: UserRecord, role: BackofficeRole) {
    if (user.status !== "active") {
      return false;
    }

    if (role === "super_admin") {
      return (
        this.isControlledProviderUser(user) &&
        user.role === "admin" &&
        user.tenantId === undefined &&
        user.tags.includes(SUPER_ADMIN_TAG) &&
        user.tags.includes(HIDDEN_BACKOFFICE_USER_TAG)
      );
    }

    if (role === "admin") {
      return user.role === "admin";
    }

    if (role === "merchant") {
      return user.role === "merchant";
    }

    return user.role === "restocker";
  }

  isControlledProviderUser(user: UserRecord) {
    return (
      user.id === DEFAULT_SUPER_ADMIN_USER_ID ||
      user.id === LEGACY_SUPER_ADMIN_USER_ID ||
      user.id.startsWith("live-super-admin") ||
      user.id.startsWith("live-provider-")
    );
  }

  isBackofficeCredentialValidForUser(
    user: UserRecord,
    credential: BackofficeCredentialRecord
  ) {
    if (!this.isUserValidForBackofficeRole(user, credential.role)) {
      return false;
    }

    if (credential.role === "super_admin") {
      return credential.tenantId === undefined;
    }

    return Boolean(user.tenantId) && credential.tenantId === user.tenantId;
  }

  isHiddenBackofficeUser(user?: UserRecord) {
    if (!user) {
      return false;
    }

    return (
      user.tags.includes(HIDDEN_BACKOFFICE_USER_TAG) ||
      this.backofficeCredentials.some(
        (entry) => entry.userId === user.id && entry.role === "super_admin"
      )
    );
  }

  updateDraftSession(
    token: string,
    patch: Partial<Pick<DraftSessionRecord, "requestedRole" | "linkedUserId" | "applicationId">>
  ) {
    const draft = this.draftSessions.get(token);

    if (!draft) {
      return undefined;
    }

    Object.assign(draft, patch);
    return draft;
  }

  clearDraftSession(token?: string) {
    if (!token) {
      return;
    }

    this.draftSessions.delete(token);
  }

  logCallback(type: string, payload: unknown) {
    const record = {
      id: this.createId("callback"),
      type,
      receivedAt: new Date().toISOString(),
      payload: summarizeCallbackPayload(payload),
      replay: createCallbackReplayFingerprint(type, payload)
    };

    this.callbackLog.unshift(record);

    if (this.callbackLog.length > MAX_CALLBACK_LOGS) {
      this.callbackLog.splice(MAX_CALLBACK_LOGS);
    }

    return record;
  }

  private ensureCompetitionTestDevice() {
    const competitionDeviceCode = "91120149";

    const existingCompetitionDevice = this.devices.find(
      (entry) => entry.deviceCode === competitionDeviceCode
    );

    if (existingCompetitionDevice) {
      if (existingCompetitionDevice.name === "测试平台柜机 91120149") {
        existingCompetitionDevice.isMock = true;
      }
      if (!this.deviceRuntime.has(competitionDeviceCode)) {
        this.deviceRuntime.set(competitionDeviceCode, {
          deviceCode: competitionDeviceCode,
          doorState: "closed",
          openedAfterLastCommand: false
        });
      }
      return;
    }

    const referenceDevice = this.devices.find((entry) => entry.deviceCode === "CAB-1001") ?? this.devices[0];
    const now = new Date().toISOString();
    const clonedGoods =
      referenceDevice?.doors[0]?.goods.map((goods) => ({
        ...goods
      })) ?? [];

    this.devices.unshift({
      deviceCode: competitionDeviceCode,
      isMock: true,
      name: "测试平台柜机 91120149",
      location: "比赛测试平台指定柜机",
      address: "测试平台设备编号 91120149",
      longitude: referenceDevice?.longitude,
      latitude: referenceDevice?.latitude,
      status: "online",
      lastSeenAt: now,
      doors: [
        {
          doorNum: "1",
          label: "右门",
          goods: clonedGoods
        }
      ]
    });

    this.deviceRuntime.set(competitionDeviceCode, {
      deviceCode: competitionDeviceCode,
      doorState: "closed",
      lastRefreshAt: now,
      openedAfterLastCommand: false
    });

    if (!this.getGoodsBatches(competitionDeviceCode).length) {
      for (const goods of clonedGoods) {
        const quantity = Math.max(0, goods.stock ?? 0);

        if (quantity <= 0) {
          continue;
        }

        this.createGoodsBatch({
          goodsId: goods.goodsId,
          deviceCode: competitionDeviceCode,
          quantity,
          expiresAt: goods.expiresAt,
          sourceType: "system",
          sourceUserName: "测试平台预置",
          note: "比赛测试柜机默认库存",
          createdAt: now
        });
      }
    }
  }

  /**
   * 全真模拟的人工码验收需要一条可预约的业务路径，但不能依赖开发种子或开放通用 mock 写入口。
   * 仅在隔离 simulation 平面、柜机与支付均为 mock、验证码为 manual 时补齐固定体验柜；
   * 其他可预约库存存在时完全不触碰，真实平面也绝不会进入这里。
   */
  private ensureManualAppAcceptanceFixture() {
    if (
      !this.shouldEnsureManualAppAcceptanceFixture() ||
      this.hasReservableSimulationInventory()
    ) {
      return false;
    }

    const tenantId = this.getDefaultTenantId();
    const fixture = this.devices.find(
      (entry) => entry.deviceCode === MANUAL_APP_ACCEPTANCE_FIXTURE_DEVICE_CODE
    );

    // 固定编号若被非模拟设备或其他实例占用，绝不覆盖用户数据；运行器会保持失败关闭。
    if (
      fixture &&
      (fixture.isMock !== true || this.getDeviceTenantId(fixture) !== tenantId)
    ) {
      return false;
    }

    const now = new Date().toISOString();
    let targetDevice = fixture;
    let changed = false;

    if (!targetDevice) {
      targetDevice = {
        deviceCode: MANUAL_APP_ACCEPTANCE_FIXTURE_DEVICE_CODE,
        tenantId,
        isMock: true,
        name: "模拟预约体验柜",
        location: "模拟服务中心",
        address: "隔离全模拟环境",
        status: "online",
        lastSeenAt: now,
        doors: [
          {
            doorNum: "1",
            label: "体验柜门",
            goods: []
          }
        ]
      };
      this.devices.unshift(targetDevice);
      changed = true;
    } else {
      if (targetDevice.tenantId !== tenantId) {
        targetDevice.tenantId = tenantId;
        changed = true;
      }
      if (targetDevice.status !== "online") {
        targetDevice.status = "online";
        changed = true;
      }
      targetDevice.lastSeenAt = now;
      changed = true;
    }

    const targetDoor =
      targetDevice.doors.find((entry) => entry.doorNum === "1") ??
      (() => {
        const created = { doorNum: "1", label: "体验柜门", goods: [] as DeviceGoods[] };
        targetDevice.doors.unshift(created);
        changed = true;
        return created;
      })();
    const targetGoods = targetDoor.goods.find(
      (entry) => entry.goodsId === MANUAL_APP_ACCEPTANCE_FIXTURE_GOODS.goodsId
    );

    this.ensureGoodsCatalogItem(MANUAL_APP_ACCEPTANCE_FIXTURE_GOODS);

    if (targetGoods) {
      Object.assign(targetGoods, MANUAL_APP_ACCEPTANCE_FIXTURE_GOODS);
    } else {
      targetDoor.goods.push({ ...MANUAL_APP_ACCEPTANCE_FIXTURE_GOODS, stock: 0 });
      changed = true;
    }

    const runtime = this.getDeviceRuntime(targetDevice.deviceCode);
    if (
      runtime.doorState !== "closed" ||
      runtime.openedAfterLastCommand !== true ||
      runtime.lastRefreshAt !== now
    ) {
      this.updateDeviceRuntime(targetDevice.deviceCode, {
        deviceCode: targetDevice.deviceCode,
        doorState: "closed",
        lastClosedAt: now,
        lastRefreshAt: now,
        openedAfterLastCommand: true
      });
      changed = true;
    }

    const replenishmentQuantity = Math.max(
      0,
      1 -
        this.getReservableStock(
          targetDevice.deviceCode,
          MANUAL_APP_ACCEPTANCE_FIXTURE_GOODS.goodsId
        )
    );

    if (replenishmentQuantity > 0) {
      this.createGoodsBatch({
        goodsId: MANUAL_APP_ACCEPTANCE_FIXTURE_GOODS.goodsId,
        deviceCode: targetDevice.deviceCode,
        quantity: Math.max(3, replenishmentQuantity),
        sourceType: "system",
        sourceUserName: "全模拟基线",
        note: "App 预约体验库存",
        createdAt: now
      });
      changed = true;
    }

    return changed;
  }

  /**
   * 这是受控全真模拟人工码验收的唯一运行组合。设备列表也用它将候选库存
   * 收敛到预约实际可锁定的数量，避免运行器先看到过期或已被预约的物品。
   */
  isManualAppAcceptanceFixtureMode() {
    return this.shouldEnsureManualAppAcceptanceFixture();
  }

  /**
   * 固定体验柜没有真实柜机回调；在受控人工码演练组合中，由本地模拟进程持续
   * 提供在线心跳。其余模拟柜、实机和非人工码组合仍必须遵循真实心跳时限。
   */
  isManualAppAcceptanceFixtureDevice(device: DeviceRecord) {
    return (
      this.shouldEnsureManualAppAcceptanceFixture() &&
      device.deviceCode === MANUAL_APP_ACCEPTANCE_FIXTURE_DEVICE_CODE &&
      device.isMock === true &&
      this.getDeviceTenantId(device) === this.getDefaultTenantId()
    );
  }

  private shouldEnsureManualAppAcceptanceFixture() {
    if (this.isLiveDataPlane() || !isFullSimulationProfile()) {
      return false;
    }

    assertFullSimulationIsolation();
    return (
      resolveFullSimulationExternalMode("smartvm") === "mock" &&
      resolveFullSimulationExternalMode("payment") === "mock" &&
      resolveFullSimulationExternalMode("verification") === "manual"
    );
  }

  private hasReservableSimulationInventory() {
    const tenantId = this.getDefaultTenantId();

    return this.devices.some((device) =>
      this.getDeviceTenantId(device) === tenantId &&
      device.status === "online" &&
      device.doors.some((door) =>
        door.goods.some((goods) => {
          if (!["food", "drink", "daily"].includes(goods.category)) {
            return false;
          }

          return this.getReservableStock(device.deviceCode, goods.goodsId) > 0;
        })
      )
    );
  }

  getReservableStock(deviceCode: string, goodsId: string, now = Date.now()) {
    const reservedQuantity = this.reservations
      .filter(
        (reservation) =>
          reservation.status === "active" &&
          reservation.deviceCode === deviceCode &&
          Date.parse(reservation.expiresAt) > now
      )
      .flatMap((reservation) => reservation.items)
      .filter((item) => item.goodsId === goodsId)
      .reduce((sum, item) => sum + item.quantity, 0);

    return Math.max(0, this.getAvailableStock(deviceCode, goodsId) - reservedQuantity);
  }

  private normalizePrefix(prefix: string) {
    const normalized = prefix.replace(/[^a-zA-Z0-9]/g, "").slice(0, 12);
    return normalized || "id";
  }

  private createCompactSuffix(randomLength = 5) {
    const timePart = Date.now().toString(36);
    const randomPart = Math.random().toString(36).slice(2, 2 + randomLength);
    return `${timePart}${randomPart}`;
  }

  private createSecureToken(
    prefix: "session" | "draft" | "challenge" | "manual-code"
  ) {
    return `${prefix}_${randomBytes(32).toString("base64url")}`;
  }

  private hashManualVerificationCode(code: string, salt: string) {
    return scryptSync(code, salt, 32).toString("base64url");
  }

  private findActiveManualVerificationGrant(challengeKey: string) {
    const grantId = this.activeManualVerificationGrantIds.get(challengeKey);
    if (!grantId) {
      return undefined;
    }

    const record = this.manualVerificationGrants.find(
      (entry) => entry.manualGrantId === grantId
    );
    if (!record || this.isManualVerificationGrantTerminal(record)) {
      this.activeManualVerificationGrantIds.delete(challengeKey);
      return undefined;
    }

    return record;
  }

  private isManualVerificationGrantTerminal(
    record: ManualVerificationGrantRecord
  ) {
    return Boolean(
      record.consumedAt ||
        record.revokedAt ||
        record.lockedAt ||
        record.expiredAt ||
        record.supersededAt
    );
  }

  private expireManualVerificationGrant(
    record: ManualVerificationGrantRecord,
    now = Date.now()
  ) {
    if (
      this.isManualVerificationGrantTerminal(record) ||
      new Date(record.expiresAt).getTime() > now
    ) {
      return false;
    }

    record.expiredAt = new Date(now).toISOString();
    if (
      this.activeManualVerificationGrantIds.get(record.challengeKey) ===
      record.manualGrantId
    ) {
      this.activeManualVerificationGrantIds.delete(record.challengeKey);
    }
    this.clearManualVerificationSecret(record);
    this.logManualVerificationTransition(
      record,
      "expire-manual-verification-code"
    );
    return true;
  }

  private expireManualVerificationGrants() {
    const now = Date.now();
    return this.manualVerificationGrants.reduce(
      (changed, record) =>
        this.expireManualVerificationGrant(record, now) || changed,
      false
    );
  }

  private clearManualVerificationSecret(
    record: ManualVerificationGrantRecord
  ) {
    record.codeSalt = undefined;
    record.codeHash = undefined;
  }

  private logManualVerificationTransition(
    record: ManualVerificationGrantRecord,
    type: string,
    metadata?: Record<string, unknown>
  ) {
    const targetUser = this.users.find(
      (entry) => entry.id === record.targetUserId
    );
    this.logOperation({
      category: "admin",
      type,
      status:
        type === "fail-manual-verification-code" ? "warning" : "success",
      actor: {
        type: "system",
        name: "验证码授权服务"
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
        tenantId: record.tenantId,
        purpose: record.purpose,
        phoneHash: record.phoneHash,
        failedAttempts: record.failedAttempts,
        ...metadata,
        undoState: "not_undoable"
      }
    });
  }

  private getVerificationCodeKey(phone: string, purpose: VerificationPurpose) {
    const digest = createHash("sha256")
      .update(`${this.dataPlaneInstanceId}\0${purpose}\0${phone}`, "utf8")
      .digest("hex");
    return `challenge:v1:${digest}`;
  }

  private isPersistableVerificationChallenge(key: string, record: VerificationRecord) {
    return (
      /^challenge:v1:[a-f0-9]{64}$/.test(key) &&
      record.externalChallenge === true &&
      record.externalProvider === "aliyun_pnvs" &&
      typeof record.externalChallengeId === "string" &&
      /^challenge_[A-Za-z0-9_-]{43}$/.test(record.externalChallengeId) &&
      record.code === "" &&
      record.manualGrant !== true &&
      this.isFutureExpiration(record.expiresAt)
    );
  }

  private isFutureExpiration(expiresAt?: string) {
    if (!expiresAt) {
      return false;
    }

    const expirationTime = new Date(expiresAt).getTime();
    return Number.isFinite(expirationTime) && expirationTime > Date.now();
  }

  getDeviceRuntime(deviceCode: string) {
    const existing = this.deviceRuntime.get(deviceCode);

    if (existing) {
      return existing;
    }

    const created: DeviceRuntimeState = {
      deviceCode,
      doorState: "unknown",
      openedAfterLastCommand: false
    };
    this.deviceRuntime.set(deviceCode, created);
    return created;
  }

  updateDeviceRuntime(deviceCode: string, patch: Partial<DeviceRuntimeState>) {
    const runtime = this.getDeviceRuntime(deviceCode);
    Object.assign(runtime, patch);
    return runtime;
  }

  getDeviceGoodsSetting(deviceCode: string, goodsId: string) {
    return this.deviceGoodsSettings.find(
      (entry) => entry.deviceCode === deviceCode && entry.goodsId === goodsId
    );
  }

  getRegion(regionId?: string) {
    if (!regionId) {
      return undefined;
    }

    return this.regions.find((entry) => entry.id === regionId);
  }

  getWarehouse(code?: string) {
    if (!code) {
      return undefined;
    }

    return this.warehouses.find((entry) => entry.code === code);
  }

  isWarehouseCode(code?: string) {
    return Boolean(code && this.getWarehouse(code));
  }

  getLocationName(locationCode: string) {
    return (
      this.devices.find((entry) => entry.deviceCode === locationCode)?.name ??
      this.getWarehouse(locationCode)?.name ??
      locationCode
    );
  }

  upsertDeviceGoodsSetting(setting: DeviceGoodsSetting) {
    const existing = this.getDeviceGoodsSetting(setting.deviceCode, setting.goodsId);

    if (existing) {
      Object.assign(existing, setting);
      return existing;
    }

    this.deviceGoodsSettings.unshift(setting);
    return setting;
  }

  getGoodsBatches(deviceCode?: string, goodsId?: string) {
    return this.goodsBatches.filter((entry) => {
      if (deviceCode && entry.deviceCode !== deviceCode) {
        return false;
      }

      if (goodsId && entry.goodsId !== goodsId) {
        return false;
      }

      return true;
    });
  }

  getCurrentStock(deviceCode: string, goodsId: string) {
    return this.getGoodsBatches(deviceCode, goodsId).reduce(
      (sum, entry) => sum + entry.remainingQuantity,
      0
    );
  }

  isGoodsBatchAvailable(batch: GoodsBatchRecord, now = Date.now()) {
    if (batch.remainingQuantity <= 0) {
      return false;
    }

    if (!batch.expiresAt) {
      return true;
    }

    const expirationTime = Date.parse(batch.expiresAt);
    return Number.isFinite(expirationTime) && expirationTime > now;
  }

  getAvailableGoodsBatches(deviceCode?: string, goodsId?: string, now = Date.now()) {
    return this.getGoodsBatches(deviceCode, goodsId).filter((entry) =>
      this.isGoodsBatchAvailable(entry, now)
    );
  }

  getAvailableStock(deviceCode: string, goodsId: string, now = Date.now()) {
    const availableStock = this.getAvailableGoodsBatches(deviceCode, goodsId, now).reduce(
      (sum, entry) => sum + entry.remainingQuantity,
      0
    );
    const negativeBalance = this.getGoodsBatches(deviceCode, goodsId)
      .filter((entry) => this.isNegativeStockBalanceBatch(entry))
      .reduce((sum, entry) => sum + entry.remainingQuantity, 0);

    return Math.max(0, availableStock + negativeBalance);
  }

  getGoodsCategoryRecord(categoryId?: string) {
    if (!categoryId) {
      return undefined;
    }

    return this.goodsCategories.find((entry) => entry.id === categoryId);
  }

  getNearestExpiryAt(deviceCode: string, goodsId: string) {
    return this.getGoodsBatches(deviceCode, goodsId)
      .filter((entry) => entry.remainingQuantity > 0 && entry.expiresAt)
      .map((entry) => entry.expiresAt as string)
      .sort((left, right) => this.compareExpiryValues(left, right))
      .at(0);
  }

  getNearestAvailableExpiryAt(deviceCode: string, goodsId: string, now = Date.now()) {
    return this.getAvailableGoodsBatches(deviceCode, goodsId, now)
      .filter((entry) => entry.expiresAt)
      .map((entry) => entry.expiresAt as string)
      .sort((left, right) => this.compareExpiryValues(left, right))
      .at(0);
  }

  ensureGoodsCatalogItem(item: GoodsCatalogItem) {
    const existing = this.goodsCatalog.find((entry) => entry.goodsId === item.goodsId);

    if (existing) {
      Object.assign(existing, {
        ...item,
        fullName: item.fullName ?? existing.fullName ?? item.name,
        categoryName: item.categoryName ?? existing.categoryName,
        packageForm: item.packageForm ?? existing.packageForm,
        specification: item.specification ?? existing.specification,
        manufacturer: item.manufacturer ?? existing.manufacturer,
        updatedAt: new Date().toISOString()
      });
      return existing;
    }

    const created: GoodsCatalogItem = {
      ...item,
      fullName: item.fullName ?? item.name,
      status: item.status ?? "active",
      createdAt: item.createdAt ?? new Date().toISOString(),
      updatedAt: item.updatedAt ?? new Date().toISOString()
    };
    this.goodsCatalog.unshift(created);
    return created;
  }

  upsertGoodsCategory(
    category: Omit<GoodsCategoryRecord, "id" | "createdAt" | "updatedAt"> & {
      id?: string;
      createdAt?: string;
      updatedAt?: string;
    }
  ) {
    const existing = category.id
      ? this.goodsCategories.find((entry) => entry.id === category.id)
      : undefined;

    if (existing) {
      Object.assign(existing, {
        ...category,
        updatedAt: category.updatedAt ?? new Date().toISOString()
      });
      return existing;
    }

    const created: GoodsCategoryRecord = {
      id: category.id ?? this.createId("goods-category"),
      name: category.name,
      category: category.category,
      status: category.status,
      sortOrder: category.sortOrder,
      createdAt: category.createdAt ?? new Date().toISOString(),
      updatedAt: category.updatedAt ?? new Date().toISOString()
    };

    this.goodsCategories.unshift(created);
    return created;
  }

  recordBatchConsumption(trace: BatchConsumptionTrace) {
    this.batchConsumptionTraces.unshift(trace);
    return trace;
  }

  ensureDeviceGoodsEntry(deviceCode: string, goods: Omit<DeviceGoods, "stock"> & { stock?: number }) {
    const device = this.devices.find((entry) => entry.deviceCode === deviceCode);

    if (!device) {
      return undefined;
    }

    const targetDoor = device.doors[0] ?? {
      doorNum: "1",
      label: "右门",
      goods: []
    };

    if (!device.doors.length) {
      device.doors.push(targetDoor);
    }

    const existing = targetDoor.goods.find((entry) => entry.goodsId === goods.goodsId);

    if (existing) {
      Object.assign(existing, goods);
      existing.stock = this.getCurrentStock(deviceCode, goods.goodsId);
      existing.expiresAt = this.getNearestExpiryAt(deviceCode, goods.goodsId);
      return existing;
    }

    const created: DeviceGoods = {
      ...goods,
      stock: this.getCurrentStock(deviceCode, goods.goodsId),
      expiresAt: this.getNearestExpiryAt(deviceCode, goods.goodsId)
    };
    targetDoor.goods.push(created);
    return created;
  }

  removeDeviceGoodsEntry(deviceCode: string, goodsId: string, doorNum?: string) {
    const device = this.devices.find((entry) => entry.deviceCode === deviceCode);

    if (!device) {
      return false;
    }

    const targetDoor =
      (doorNum ? device.doors.find((door) => door.doorNum === doorNum) : undefined) ??
      device.doors.find((door) => door.goods.some((goods) => goods.goodsId === goodsId));

    if (!targetDoor) {
      return false;
    }

    const targetIndex = targetDoor.goods.findIndex((goods) => goods.goodsId === goodsId);

    if (targetIndex < 0) {
      return false;
    }

    targetDoor.goods.splice(targetIndex, 1);

    for (let index = this.deviceGoodsSettings.length - 1; index >= 0; index -= 1) {
      const setting = this.deviceGoodsSettings[index];

      if (setting.deviceCode === deviceCode && setting.goodsId === goodsId) {
        this.deviceGoodsSettings.splice(index, 1);
      }
    }

    return true;
  }

  removeActiveDeviceState(deviceCode: string) {
    const targetIndex = this.devices.findIndex((entry) => entry.deviceCode === deviceCode);

    if (targetIndex < 0) {
      return undefined;
    }

    const [removed] = this.devices.splice(targetIndex, 1);

    this.deviceRuntime.delete(deviceCode);
    this.removeMatching(this.deviceGoodsSettings, (entry) => entry.deviceCode === deviceCode);
    this.removeMatching(this.goodsBatches, (entry) => entry.deviceCode === deviceCode);
    this.removeMatching(this.alerts, (entry) => entry.deviceCode === deviceCode);

    this.goodsAlertPolicies.forEach((policy) => {
      policy.applicableDeviceCodes = policy.applicableDeviceCodes.filter((code) => code !== deviceCode);
    });

    this.users.forEach((user) => {
      if (!user.merchantProfile) {
        user.assignedDeviceCodes = user.assignedDeviceCodes?.filter(
          (code) => code !== deviceCode
        );
        return;
      }

      user.merchantProfile.defaultDeviceCodes = user.merchantProfile.defaultDeviceCodes.filter(
        (code) => code !== deviceCode
      );
      user.assignedDeviceCodes = user.assignedDeviceCodes?.filter(
        (code) => code !== deviceCode
      );
    });

    return removed;
  }

  createGoodsBatch(payload: {
    goodsId: string;
    deviceCode: string;
    quantity: number;
    expiresAt?: string;
    sourceType: GoodsBatchSource;
    sourceUserId?: string;
    sourceUserName?: string;
    sourcePolicyId?: string;
    note?: string;
    createdAt?: string;
    batchId?: string;
  }) {
    const locationType = this.isWarehouseCode(payload.deviceCode) ? "warehouse" : "device";
    const batch: GoodsBatchRecord = {
      batchId: payload.batchId ?? this.createId("batch"),
      goodsId: payload.goodsId,
      deviceCode: payload.deviceCode,
      locationType,
      locationName: this.getLocationName(payload.deviceCode),
      quantity: payload.quantity,
      remainingQuantity: payload.quantity,
      expiresAt: payload.expiresAt,
      createdAt: payload.createdAt ?? new Date().toISOString(),
      sourceType: payload.sourceType,
      sourceUserId: payload.sourceUserId,
      sourceUserName: payload.sourceUserName,
      sourcePolicyId: payload.sourcePolicyId,
      note: payload.note
    };

    this.goodsBatches.unshift(batch);
    this.syncDeviceStocksFromBatches(payload.deviceCode);
    return batch;
  }

  consumeGoodsBatches(
    deviceCode: string,
    goodsId: string,
    quantity: number,
    requestedBatches?: Array<{ batchId: string; quantity: number }>,
    options?: { allowExpired?: boolean; now?: number }
  ) {
    let remaining = Math.max(0, quantity);
    const consumed: BatchConsumptionEntry[] = [];
    const now = options?.now ?? Date.now();
    const allowExpired = options?.allowExpired === true;

    if (!allowExpired) {
      for (const request of requestedBatches ?? []) {
        const requestedQuantity = Math.max(0, Math.floor(Number(request.quantity)));

        if (!request.batchId || requestedQuantity <= 0) {
          continue;
        }

        const requestedBatch = this.goodsBatches.find(
          (entry) =>
            entry.batchId === request.batchId &&
            entry.deviceCode === deviceCode &&
            entry.goodsId === goodsId
        );

        if (requestedBatch?.expiresAt && !this.isGoodsBatchAvailable(requestedBatch, now)) {
          throw new BadRequestException("指定批次已到期，不能用于领取或正常调拨。");
        }
      }
    }

    for (const request of requestedBatches ?? []) {
      if (remaining <= 0) {
        break;
      }

      const requestedQuantity = Math.max(0, Math.floor(Number(request.quantity)));

      if (!request.batchId || requestedQuantity <= 0) {
        continue;
      }

      const batch = this.goodsBatches.find(
        (entry) =>
          entry.batchId === request.batchId &&
          entry.deviceCode === deviceCode &&
          entry.goodsId === goodsId &&
          entry.remainingQuantity > 0 &&
          (allowExpired || this.isGoodsBatchAvailable(entry, now))
      );

      if (!batch) {
        continue;
      }

      const used = Math.min(batch.remainingQuantity, requestedQuantity, remaining);

      if (used <= 0) {
        continue;
      }

      batch.remainingQuantity -= used;
      remaining -= used;
      consumed.push(this.buildBatchConsumptionEntry(batch, used, "specified"));
    }

    const ordered = this.getGoodsBatches(deviceCode, goodsId)
      .filter(
        (entry) =>
          entry.remainingQuantity > 0 &&
          (allowExpired || this.isGoodsBatchAvailable(entry, now))
      )
      .sort((left, right) => {
        const expiryOrder = this.compareExpiryValues(left.expiresAt, right.expiresAt);

        if (expiryOrder !== 0) {
          return expiryOrder;
        }

        return left.createdAt.localeCompare(right.createdAt);
      });

    for (const batch of ordered) {
      if (remaining <= 0) {
        break;
      }

      const used = Math.min(batch.remainingQuantity, remaining);

      if (used <= 0) {
        continue;
      }

      batch.remainingQuantity -= used;
      remaining -= used;
      consumed.push(this.buildBatchConsumptionEntry(batch, used, "earliest_expiry"));
    }

    if (remaining > 0) {
      const negativeBalanceBatch = this.recordNegativeStockBalance(deviceCode, goodsId, remaining);
      consumed.push(this.buildBatchConsumptionEntry(negativeBalanceBatch, remaining, "negative_balance"));
      remaining = 0;
    }

    this.syncDeviceStocksFromBatches(deviceCode);

    return {
      actualQuantity: quantity,
      consumed,
      shortage: remaining
    };
  }

  private buildBatchConsumptionEntry(
    batch: GoodsBatchRecord,
    quantity: number,
    selectionReason: BatchConsumptionEntry["selectionReason"]
  ): BatchConsumptionEntry {
    return {
      batchId: batch.batchId,
      quantity,
      expiresAt: batch.expiresAt,
      sourceUserId: batch.sourceUserId,
      sourceUserName: batch.sourceUserName,
      selectionReason
    };
  }

  restoreGoodsBatchConsumption(deviceCode: string, consumed: BatchConsumptionEntry[]) {
    for (const item of consumed) {
      const batch = this.goodsBatches.find((entry) => entry.batchId === item.batchId);

      if (batch) {
        if (this.isNegativeStockBalanceBatch(batch)) {
          batch.remainingQuantity = Math.min(0, batch.remainingQuantity + item.quantity);
          continue;
        }

        batch.remainingQuantity = Math.min(batch.quantity, batch.remainingQuantity + item.quantity);
      }
    }

    this.cleanupNegativeStockBalanceBatches(deviceCode);
    this.syncDeviceStocksFromBatches(deviceCode);
  }

  removeBatchQuantity(batchId: string, quantity: number) {
    const batch = this.goodsBatches.find((entry) => entry.batchId === batchId);

    if (!batch) {
      return undefined;
    }

    const actualQuantity = Math.min(batch.remainingQuantity, Math.max(0, quantity));
    batch.remainingQuantity -= actualQuantity;
    this.syncDeviceStocksFromBatches(batch.deviceCode);
    return {
      batch,
      actualQuantity
    };
  }

  restoreBatchQuantity(batchId: string, quantity: number) {
    const batch = this.goodsBatches.find((entry) => entry.batchId === batchId);

    if (!batch) {
      return undefined;
    }

    batch.remainingQuantity = Math.min(batch.quantity, batch.remainingQuantity + Math.max(0, quantity));
    this.syncDeviceStocksFromBatches(batch.deviceCode);
    return batch;
  }

  syncDeviceStocksFromBatches(deviceCode?: string) {
    const devices = deviceCode
      ? this.devices.filter((entry) => entry.deviceCode === deviceCode)
      : this.devices;

    for (const device of devices) {
      for (const door of device.doors) {
        for (const goods of door.goods) {
          goods.stock = this.getCurrentStock(device.deviceCode, goods.goodsId);
          goods.expiresAt = this.getNearestExpiryAt(device.deviceCode, goods.goodsId);
        }
      }
    }
  }

  private isNegativeStockBalanceBatch(batch: GoodsBatchRecord) {
    return batch.sourceType === "system" && batch.quantity === 0 && batch.note === NEGATIVE_STOCK_BALANCE_NOTE;
  }

  private compareExpiryValues(left?: string, right?: string) {
    const leftTime = left ? Date.parse(left) : Number.POSITIVE_INFINITY;
    const rightTime = right ? Date.parse(right) : Number.POSITIVE_INFINITY;
    const normalizedLeft = Number.isFinite(leftTime) ? leftTime : Number.POSITIVE_INFINITY;
    const normalizedRight = Number.isFinite(rightTime) ? rightTime : Number.POSITIVE_INFINITY;

    return normalizedLeft - normalizedRight || (left ?? "").localeCompare(right ?? "");
  }

  private recordNegativeStockBalance(deviceCode: string, goodsId: string, quantity: number) {
    const existing = this.goodsBatches.find(
      (entry) =>
        entry.deviceCode === deviceCode &&
        entry.goodsId === goodsId &&
        this.isNegativeStockBalanceBatch(entry)
    );

    if (existing) {
      existing.remainingQuantity -= quantity;
      return existing;
    }

    const created = this.createGoodsBatch({
      goodsId,
      deviceCode,
      quantity: 0,
      sourceType: "system",
      sourceUserName: "系统平衡",
      note: NEGATIVE_STOCK_BALANCE_NOTE
    });

    created.remainingQuantity -= quantity;
    return created;
  }

  private cleanupNegativeStockBalanceBatches(deviceCode: string) {
    for (let index = this.goodsBatches.length - 1; index >= 0; index -= 1) {
      const batch = this.goodsBatches[index];

      if (
        batch.deviceCode === deviceCode &&
        this.isNegativeStockBalanceBatch(batch) &&
        batch.remainingQuantity === 0
      ) {
        this.goodsBatches.splice(index, 1);
      }
    }
  }

  calculateGoodsCategory(goodsId: string, fallback: GoodsCategory = "daily") {
    return this.goodsCatalog.find((entry) => entry.goodsId === goodsId)?.category ?? fallback;
  }

  normalizeUserRegion(user: UserRecord) {
    const regionName = user.regionName ?? user.neighborhood;

    return {
      regionId: user.regionId,
      regionName
    };
  }

  refreshAlertPresentation() {
    this.alerts.forEach((entry) => this.decorateAlert(entry));
  }

  decorateAlert(alert: AlertTask) {
    const relatedEvent = this.findEventByReference(alert.relatedEventId);
    const sourceLog = alert.sourceLogId
      ? this.logs.find((entry) => entry.id === alert.sourceLogId)
      : undefined;
    const sourceMetadata = this.readMetadata(sourceLog?.metadata);
    const targetUserId =
      alert.targetUserId ??
      this.readString(sourceMetadata.targetUserId) ??
      relatedEvent?.userId;
    const targetUserName =
      this.getUserDisplayName(targetUserId) ??
      this.readString(sourceMetadata.targetUserName);
    const deviceCode =
      alert.deviceCode ??
      this.readString(sourceMetadata.deviceCode) ??
      relatedEvent?.deviceCode;
    const deviceName = deviceCode ? this.getDeviceDisplayName(deviceCode) : undefined;
    const goodsSummary =
      alert.goodsSummary ??
      this.buildEventGoodsSummary(relatedEvent) ??
      this.readString(sourceMetadata.goodsSummary) ??
      alert.goodsName;
    const previewParts = [
      targetUserName ? `用户 ${targetUserName}` : undefined,
      goodsSummary ? `商品 ${goodsSummary}` : undefined,
      deviceName ? `柜机 ${deviceName}` : undefined
    ].filter((entry): entry is string => Boolean(entry));
    const previewLooksMachineLike =
      !alert.previewDetail ||
      /事件|订单|evt-|ord-|^log-/.test(alert.previewDetail);

    if (!alert.targetUserId && targetUserId) {
      alert.targetUserId = targetUserId;
    }

    if (!alert.deviceCode && deviceCode) {
      alert.deviceCode = deviceCode;
    }

    alert.deviceName = deviceName;
    alert.targetUserName = targetUserName;
    alert.goodsSummary = goodsSummary;

    if (previewLooksMachineLike && previewParts.length) {
      alert.previewDetail = previewParts.join(" · ");
    }

    if (previewParts.length) {
      const prefix = previewParts.join("；");

      if (!alert.detail.startsWith(prefix) && !previewParts.some((entry) => alert.detail.includes(entry))) {
        alert.detail = `${prefix}；${alert.detail}`;
      }
    }

    return alert;
  }

  private readMetadata(metadata?: Record<string, unknown>) {
    return (metadata ?? {}) as Record<string, unknown>;
  }

  private readString(value: unknown) {
    return typeof value === "string" && value.trim() ? value.trim() : undefined;
  }

  private getUserDisplayName(userId?: string) {
    if (!userId) {
      return undefined;
    }

    return this.users.find((entry) => entry.id === userId)?.name;
  }

  private getDeviceDisplayName(deviceCode?: string) {
    if (!deviceCode) {
      return undefined;
    }

    return this.devices.find((entry) => entry.deviceCode === deviceCode)?.name ?? deviceCode;
  }

  private findEventByReference(eventId?: string, orderNo?: string) {
    if (eventId) {
      const matchedByEventId = this.events.find((entry) => entry.eventId === eventId);

      if (matchedByEventId) {
        return matchedByEventId;
      }
    }

    if (!orderNo) {
      return undefined;
    }

    return this.events.find(
      (entry) =>
        entry.orderNo === orderNo ||
        entry.adjustmentOrderNo === orderNo ||
        entry.adjustments?.some((adjustment) => adjustment.orderNo === orderNo)
    );
  }

  private summarizeGoodsItems(items: Array<{ goodsName?: string; name?: string; quantity?: number }>) {
    const summary = new Map<string, number>();

    for (const item of items) {
      const label = (item.goodsName ?? item.name ?? "").trim();

      if (!label) {
        continue;
      }

      summary.set(label, (summary.get(label) ?? 0) + (item.quantity ?? 0));
    }

    return Array.from(summary.entries())
      .map(([label, quantity]) => `${label}${quantity > 0 ? ` x${quantity}` : ""}`)
      .join("、");
  }

  private buildGoodsSummaryFromUnknown(value: unknown) {
    if (!Array.isArray(value)) {
      return undefined;
    }

    const normalizedItems = value
      .filter((entry): entry is Record<string, unknown> => typeof entry === "object" && entry !== null)
      .map((entry) => ({
        goodsName: this.readString(entry.goodsName) ?? this.readString(entry.name),
        quantity: typeof entry.quantity === "number" ? entry.quantity : 0
      }));

    const summary = this.summarizeGoodsItems(normalizedItems);
    return summary || undefined;
  }

  private buildEventGoodsSummary(event?: CabinetEventRecord) {
    if (!event) {
      return undefined;
    }

    const settledSummary = this.summarizeGoodsItems(event.goods);

    if (settledSummary) {
      return settledSummary;
    }

    const intentSummary = this.summarizeGoodsItems(event.intentItems ?? []);

    if (intentSummary) {
      return intentSummary;
    }

    const latestAdjustment = event.adjustments?.[0];
    const adjustmentSummary = this.summarizeGoodsItems(latestAdjustment?.goods ?? []);
    return adjustmentSummary || undefined;
  }

  private enrichOperationLogMetadata(
    entry: OperationLogRecord | (OperationLogDraft & { id: string; occurredAt: string })
  ) {
    const metadata = {
      ...this.readMetadata(entry.metadata)
    };
    const relatedEvent = this.findEventByReference(
      entry.relatedEventId ?? (entry.secondarySubject?.type === "event" ? entry.secondarySubject.id : undefined),
      entry.relatedOrderNo
    );
    const deviceCode =
      this.readString(metadata.deviceCode) ??
      (entry.primarySubject?.type === "device"
        ? entry.primarySubject.id
        : entry.secondarySubject?.type === "device"
          ? entry.secondarySubject.id
          : undefined) ??
      relatedEvent?.deviceCode;
    const targetUserId =
      this.readString(metadata.targetUserId) ??
      (entry.primarySubject?.type === "user"
        ? entry.primarySubject.id
        : entry.secondarySubject?.type === "user"
          ? entry.secondarySubject.id
          : undefined) ??
      relatedEvent?.userId;
    const goodsSummary =
      this.readString(metadata.goodsSummary) ??
      this.buildEventGoodsSummary(relatedEvent) ??
      this.buildGoodsSummaryFromUnknown(metadata.intentItems) ??
      this.buildGoodsSummaryFromUnknown(metadata.acceptedIntentItems) ??
      this.buildGoodsSummaryFromUnknown(metadata.goods) ??
      this.readString(metadata.goodsName);
    const targetUserName =
      this.readString(metadata.targetUserName) ??
      this.getUserDisplayName(targetUserId);
    const deviceName =
      this.readString(metadata.deviceName) ??
      this.getDeviceDisplayName(deviceCode);

    if (deviceCode) {
      metadata.deviceCode = deviceCode;
    }

    if (deviceName) {
      metadata.deviceName = deviceName;
    }

    if (targetUserId) {
      metadata.targetUserId = targetUserId;
    }

    if (targetUserName) {
      metadata.targetUserName = targetUserName;
    }

    if (goodsSummary) {
      metadata.goodsSummary = goodsSummary;
    }

    if (relatedEvent?.eventId) {
      metadata.relatedEventId = relatedEvent.eventId;
    }

    if (relatedEvent?.orderNo) {
      metadata.relatedOrderNo = relatedEvent.orderNo;
    }

    return metadata;
  }

  private decorateStoredLog(
    entry: OperationLogRecord | (OperationLogDraft & { id: string; occurredAt: string })
  ) {
    const metadata = this.enrichOperationLogMetadata(entry);
    const normalizedEntry = {
      ...entry,
      metadata
    } as OperationLogRecord;

    return {
      ...normalizedEntry,
      ...formatOperationLog(normalizedEntry)
    };
  }

  logOperation(entry: OperationLogDraft) {
    const occurredAt = entry.occurredAt ?? new Date().toISOString();
    const id = entry.id ?? this.createId("log");
    const record = this.decorateStoredLog({
      ...entry,
      id,
      occurredAt
    });

    record.metadata = {
      undoState: "not_undoable",
      ...(record.metadata ?? {})
    };

    this.logs.unshift(record);
    return record;
  }

  snapshot(): PersistedStoreState {
    this.expireManualVerificationGrants();

    return {
      dataPlane: this.runtimeDataPlane,
      instanceId: this.dataPlaneInstanceId,
      initializationSource: this.initializationSource,
      flags: this.persistenceFlags,
      users: structuredClone(this.users),
      rules: structuredClone(this.rules),
      devices: structuredClone(this.devices),
      goodsCatalog: structuredClone(this.goodsCatalog),
      goodsCategories: structuredClone(this.goodsCategories),
      regions: structuredClone(this.regions),
      warehouses: structuredClone(this.warehouses),
      specialAccessPolicies: structuredClone(this.specialAccessPolicies),
      goodsAlertPolicies: structuredClone(this.goodsAlertPolicies),
      registrationApplications: structuredClone(this.registrationApplications),
      merchantGoodsTemplates: structuredClone(this.merchantGoodsTemplates),
      deviceGoodsSettings: structuredClone(this.deviceGoodsSettings),
      goodsBatches: structuredClone(this.goodsBatches),
      batchConsumptionTraces: structuredClone(this.batchConsumptionTraces),
      inventoryTransfers: structuredClone(this.inventoryTransfers),
      stocktakes: structuredClone(this.stocktakes),
      expiredBatchDispositions: structuredClone(this.expiredBatchDispositions),
      events: structuredClone(this.events),
      inventory: structuredClone(this.inventory),
      paymentOrders: structuredClone(this.paymentOrders),
      paymentRefunds: structuredClone(this.paymentRefunds),
      reservations: structuredClone(this.reservations),
      reservationSettings: structuredClone(this.reservationSettings),
      alerts: structuredClone(this.alerts),
      logs: structuredClone(this.logs),
      platformTenants: structuredClone(this.platformTenants),
      // 仅持久化不含手机号和验证码原文的外部挑战；Bearer 会话与资料草稿仍只在进程内。
      verificationCodes: Array.from(this.verificationCodes.entries())
        .filter(([key, record]) => this.isPersistableVerificationChallenge(key, record))
        .map(
          ([key, record]) =>
            [key, structuredClone(record)] as [string, VerificationRecord]
        ),
      manualVerificationGrants: structuredClone(
        this.manualVerificationGrants
      ),
      sessions: [],
      draftSessions: [],
      adminCredentials: structuredClone(this.adminCredentials),
      backofficeCredentials: structuredClone(this.backofficeCredentials),
      callbackLog: structuredClone(this.callbackLog),
      deviceRuntime: Array.from(this.deviceRuntime.entries()).map(([key, value]) => [key, structuredClone(value)])
    };
  }

  isPersistedStateIntegrityReady() {
    return this.persistedStateIntegrityStatus === "ready";
  }

  persist() {
    this.persistedStateIntegrityStatus = "checking";

    try {
      const state = this.snapshot();
      writePersistedState(state);
      this.persistedStateIntegrityStatus = "ready";
    } catch (error) {
      this.persistedStateIntegrityStatus = "failed";
      throw error;
    }
  }

  resetToSeed() {
    if (this.isLiveDataPlane()) {
      throw new BadRequestException("真实数据平面不能重置为测试种子。");
    }

    this.persistenceFlags = undefined;
    this.hydrate(createSeededPersistedState(this.dataPlaneInstanceId));
    this.ensureBootstrapAdmin();
    this.persist();
  }

  private refreshPersistedStateIntegrityStatus() {
    this.persistedStateIntegrityStatus = "checking";

    try {
      this.persistedStateIntegrityStatus =
        validatePersistedState(this.snapshot()).errors.length === 0 ? "ready" : "failed";
    } catch {
      this.persistedStateIntegrityStatus = "failed";
    }
  }

  private hydrate(state: PersistedStoreState) {
    if (state.dataPlane !== this.runtimeDataPlane) {
      throw new Error("运行数据平面标记与当前进程不一致，已拒绝加载。");
    }

    this.dataPlaneInstanceId = state.instanceId;
    this.initializationSource = state.initializationSource;
    this.replaceArray(this.users, state.users);
    this.replaceArray(this.rules, state.rules);
    this.replaceArray(this.devices, state.devices);
    this.replaceArray(this.goodsCatalog, state.goodsCatalog);
    this.replaceArray(this.goodsCategories, state.goodsCategories);
    this.replaceArray(this.regions, state.regions);
    this.replaceArray(this.warehouses, state.warehouses);
    this.replaceArray(this.specialAccessPolicies, state.specialAccessPolicies);
    this.replaceArray(this.goodsAlertPolicies, state.goodsAlertPolicies);
    this.replaceArray(this.registrationApplications, state.registrationApplications);
    this.replaceArray(this.merchantGoodsTemplates, state.merchantGoodsTemplates);
    this.replaceArray(this.deviceGoodsSettings, state.deviceGoodsSettings);
    this.replaceArray(this.goodsBatches, state.goodsBatches);
    this.replaceArray(this.batchConsumptionTraces, state.batchConsumptionTraces);
    this.replaceArray(this.inventoryTransfers, state.inventoryTransfers);
    this.replaceArray(this.stocktakes, state.stocktakes);
    this.replaceArray(this.expiredBatchDispositions, state.expiredBatchDispositions);
    this.replaceArray(this.events, state.events);
    this.replaceArray(this.inventory, state.inventory);
    this.replaceArray(this.paymentOrders, state.paymentOrders);
    this.replaceArray(this.paymentRefunds, state.paymentRefunds);
    this.replaceArray(this.reservations, state.reservations);
    Object.assign(this.reservationSettings, structuredClone(state.reservationSettings));
    this.replaceArray(this.alerts, state.alerts);
    this.replaceArray(
      this.logs,
      state.logs.map((entry) => this.decorateStoredLog(entry))
    );
    this.replaceArray(this.platformTenants, state.platformTenants);

    this.verificationCodes.clear();
    for (const [key, record] of state.verificationCodes) {
      if (this.isPersistableVerificationChallenge(key, record)) {
        this.verificationCodes.set(key, structuredClone(record));
      }
    }
    this.replaceArray(
      this.manualVerificationGrants,
      state.manualVerificationGrants
    );
    this.activeManualVerificationGrantIds.clear();
    for (const record of [...this.manualVerificationGrants].sort((left, right) =>
      right.requestedAt.localeCompare(left.requestedAt)
    )) {
      if (
        this.isManualVerificationGrantTerminal(record) ||
        !record.codeSalt ||
        !record.codeHash ||
        new Date(record.expiresAt).getTime() <= Date.now()
      ) {
        continue;
      }

      if (!this.activeManualVerificationGrantIds.has(record.challengeKey)) {
        this.activeManualVerificationGrantIds.set(
          record.challengeKey,
          record.manualGrantId
        );
      }
    }
    // Bearer 会话和资料草稿仍不从快照恢复，避免复活旧登录态。
    this.sessions.clear();
    this.draftSessions.clear();

    this.replaceArray(this.adminCredentials, state.adminCredentials);
    this.replaceArray(this.backofficeCredentials, state.backofficeCredentials);
    this.replaceArray(this.callbackLog, state.callbackLog);
    this.deviceRuntime.clear();
    for (const [key, value] of state.deviceRuntime) {
      this.deviceRuntime.set(key, value);
    }

    this.refreshAlertPresentation();
  }

  private replaceArray<T>(target: T[], source: T[]) {
    target.splice(0, target.length, ...structuredClone(source));
  }

  private removeMatching<T>(target: T[], matcher: (entry: T) => boolean) {
    for (let index = target.length - 1; index >= 0; index -= 1) {
      if (matcher(target[index])) {
        target.splice(index, 1);
      }
    }
  }

  private ensureBootstrapAdmin() {
    if (this.isLiveDataPlane()) {
      return false;
    }

    let changed = false;
    let superAdminUser =
      this.users.find((entry) => entry.id === DEFAULT_SUPER_ADMIN_USER_ID) ??
      this.users.find(
        (entry) =>
          entry.id === LEGACY_SUPER_ADMIN_USER_ID &&
          entry.role === "admin" &&
          entry.tags.includes(SUPER_ADMIN_TAG)
      );

    if (!superAdminUser) {
      superAdminUser = {
        id: DEFAULT_SUPER_ADMIN_USER_ID,
        role: "admin",
        phone: DEFAULT_SUPER_ADMIN_PHONE,
        name: DEFAULT_SUPER_ADMIN_NAME,
        status: "active",
        regionName: DEFAULT_SUPER_ADMIN_REGION_NAME,
        neighborhood: DEFAULT_SUPER_ADMIN_REGION_NAME,
        tags: [SUPER_ADMIN_TAG, HIDDEN_BACKOFFICE_USER_TAG],
        mobileProfileCompleted: false
      };
      this.users.unshift(superAdminUser);
      changed = true;
    } else {
      const nextTags = Array.from(
        new Set([...superAdminUser.tags, SUPER_ADMIN_TAG, HIDDEN_BACKOFFICE_USER_TAG])
      );

      if (
        superAdminUser.phone !== DEFAULT_SUPER_ADMIN_PHONE ||
        superAdminUser.name !== DEFAULT_SUPER_ADMIN_NAME ||
        superAdminUser.regionName !== DEFAULT_SUPER_ADMIN_REGION_NAME ||
        superAdminUser.neighborhood !== DEFAULT_SUPER_ADMIN_REGION_NAME ||
        nextTags.length !== superAdminUser.tags.length
      ) {
        superAdminUser.phone = DEFAULT_SUPER_ADMIN_PHONE;
        superAdminUser.name = DEFAULT_SUPER_ADMIN_NAME;
        superAdminUser.regionName = DEFAULT_SUPER_ADMIN_REGION_NAME;
        superAdminUser.neighborhood = DEFAULT_SUPER_ADMIN_REGION_NAME;
        superAdminUser.tags = nextTags;
        changed = true;
      }
    }

    changed = this.normalizeBackofficeBootstrapCredentials() || changed;

    const defaultAdminCredential =
      this.adminCredentials.find(
        (entry) => entry.username.trim().toLowerCase() === DEFAULT_ADMIN_USERNAME
      ) ??
      this.backofficeCredentials.find(
        (entry) =>
          entry.role === "admin" &&
          entry.username.trim().toLowerCase() === DEFAULT_ADMIN_USERNAME
      );
    let adminUser =
      this.users.find(
        (entry) =>
          entry.id === defaultAdminCredential?.userId &&
          entry.role === "admin" &&
          !this.isHiddenBackofficeUser(entry)
      ) ??
      this.users.find(
        (entry) =>
          entry.id === "admin-001" &&
          entry.role === "admin" &&
          !this.isHiddenBackofficeUser(entry)
      );

    if (!adminUser) {
      adminUser = {
        id: "admin-001",
        role: "admin",
        phone: DEFAULT_ADMIN_PHONE,
        name: DEFAULT_ADMIN_NAME,
        status: "active",
        regionName: DEFAULT_SUPER_ADMIN_REGION_NAME,
        neighborhood: DEFAULT_SUPER_ADMIN_REGION_NAME,
        tags: ["运营"],
        mobileProfileCompleted: false,
        profile: {
          organization: "扬名街道办",
          title: "值班管理员"
        }
      };
      this.users.unshift(adminUser);
      changed = true;
    }

    const defaultMerchantCredential = this.backofficeCredentials.find(
      (entry) =>
        entry.role === "merchant" &&
        entry.username.trim().toLowerCase() === DEFAULT_MERCHANT_USERNAME
    );
    let merchantUser =
      this.users.find(
        (entry) =>
          entry.id === defaultMerchantCredential?.userId &&
          entry.role === "merchant"
      ) ??
      this.users.find(
        (entry) => entry.id === "merchant-001" && entry.role === "merchant"
      );

    if (!merchantUser) {
      merchantUser = {
        id: "merchant-001",
        role: "merchant",
        phone: DEFAULT_MERCHANT_PHONE,
        name: DEFAULT_MERCHANT_NAME,
        status: "active",
        regionName: DEFAULT_SUPER_ADMIN_REGION_NAME,
        tags: ["食品捐赠"],
        mobileProfileCompleted: false,
        merchantProfile: {
          donationWindowDays: 2,
          defaultDeviceCodes: []
        }
      };
      this.users.unshift(merchantUser);
      changed = true;
    }

    if (!this.findAdminCredentialByUserId(adminUser.id)) {
      const hashedPassword = hashAdminPassword(DEFAULT_ADMIN_PASSWORD);

      this.adminCredentials.unshift({
        userId: adminUser.id,
        username: DEFAULT_ADMIN_USERNAME,
        passwordSalt: hashedPassword.salt,
        passwordHash: hashedPassword.hash,
        usesDefaultPassword: true,
        passwordUpdatedAt: new Date().toISOString()
      });
      changed = true;
    }

    changed = this.ensureDefaultTenantAdminPermissions(adminUser.id) || changed;

    changed =
      this.ensureDefaultBackofficeCredential(
      superAdminUser,
      "super_admin",
      DEFAULT_SUPER_ADMIN_USERNAME,
      DEFAULT_SUPER_ADMIN_PASSWORD
      ) || changed;
    changed =
      this.ensureDefaultBackofficeCredential(
      adminUser,
      "admin",
      DEFAULT_ADMIN_USERNAME,
      DEFAULT_ADMIN_PASSWORD,
      this.findAdminCredentialByUserId(adminUser.id),
      this.getDefaultTenantId()
    ) || changed;
    changed =
      this.ensureDefaultBackofficeCredential(
        merchantUser,
        "merchant",
        DEFAULT_MERCHANT_USERNAME,
        DEFAULT_MERCHANT_PASSWORD,
        undefined,
        this.getDefaultTenantId()
      ) || changed;

    changed = this.synchronizeLinkedAdminCredentials(adminUser.id) || changed;

    return changed;
  }

  /**
   * 旧单实例快照没有在人员记录上保存 tenantId。只有快照仍明确为单实例时才可将
   * 普通人员迁移到该唯一实例；多实例缺失归属必须失败关闭，绝不能用待校验凭据
   * 反向证明其所属实例。
   */
  private normalizeLegacyUserTenantOwnership() {
    let changed = false;
    const soleTenant = this.platformTenants.length === 1
      ? this.platformTenants[0]
      : undefined;

    for (const user of this.users) {
      if (user.tenantId) {
        const sanitizedTags = user.tags.filter(
          (tag) => !RESERVED_BACKOFFICE_USER_TAGS.has(tag)
        );
        if (sanitizedTags.length !== user.tags.length) {
          user.tags = sanitizedTags;
          changed = true;
        }
        continue;
      }

      const isProviderRoot =
        this.isControlledProviderUser(user) &&
        user.role === "admin" &&
        user.tags.includes(SUPER_ADMIN_TAG) &&
        user.tags.includes(HIDDEN_BACKOFFICE_USER_TAG) &&
        this.backofficeCredentials.some(
          (credential) =>
            credential.userId === user.id &&
            credential.role === "super_admin" &&
            credential.tenantId === undefined
        );

      if (isProviderRoot) {
        continue;
      }

      const sanitizedTags = user.tags.filter(
        (tag) => !RESERVED_BACKOFFICE_USER_TAGS.has(tag)
      );
      if (sanitizedTags.length !== user.tags.length) {
        user.tags = sanitizedTags;
        changed = true;
      }

      if (soleTenant) {
        user.tenantId = soleTenant.id;
        changed = true;
      }
    }

    return changed;
  }

  /**
   * 旧 admin 登录兼容记录与当前 admin 后台记录共用同一用户时，密码状态必须一致。
   * 显式密码写入指定其权威来源；启动归一化只修复“默认/已改密”不一致，避免覆盖两个都已改密的历史记录。
   */
  private synchronizeLinkedAdminCredentials(
    userId: string,
    sourceKind?: "legacy" | "backoffice"
  ) {
    const legacyCredential = this.findAdminCredentialByUserId(userId);
    const backofficeCredential = this.findBackofficeCredentialByUserId(userId, "admin");

    if (!legacyCredential || !backofficeCredential) {
      return false;
    }

    if (!sourceKind && legacyCredential.usesDefaultPassword === backofficeCredential.usesDefaultPassword) {
      return false;
    }

    const source =
      sourceKind === "legacy"
        ? legacyCredential
        : sourceKind === "backoffice"
          ? backofficeCredential
          : legacyCredential.usesDefaultPassword
            ? backofficeCredential
            : legacyCredential;
    const target = source === legacyCredential ? backofficeCredential : legacyCredential;

    if (
      target.passwordSalt === source.passwordSalt &&
      target.passwordHash === source.passwordHash &&
      target.usesDefaultPassword === source.usesDefaultPassword &&
      target.passwordUpdatedAt === source.passwordUpdatedAt
    ) {
      return false;
    }

    target.passwordSalt = source.passwordSalt;
    target.passwordHash = source.passwordHash;
    target.usesDefaultPassword = source.usesDefaultPassword;
    target.passwordUpdatedAt = source.passwordUpdatedAt;
    return true;
  }

  private ensureDefaultTenantAdminPermissions(userId: string) {
    const credential = this.findBackofficeCredentialByUserId(userId, "admin");

    if (!credential?.permissions) {
      return false;
    }

    delete credential.permissions;
    return true;
  }

  private normalizeBackofficeBootstrapCredentials() {
    let changed = false;

    for (const credential of this.backofficeCredentials) {
      if (credential.role === "super_admin") {
        if (credential.tenantId) {
          delete credential.tenantId;
          changed = true;
        }
        continue;
      }

      if (!credential.tenantId) {
        credential.tenantId = this.getDefaultTenantId();
        changed = true;
      }
    }

    const seen = new Set<string>();
    const uniqueCredentials: BackofficeCredentialRecord[] = [];

    for (const credential of this.backofficeCredentials) {
      const key = `${credential.userId}:${credential.role}`;

      if (seen.has(key)) {
        changed = true;
        continue;
      }

      seen.add(key);
      uniqueCredentials.push(credential);
    }

    if (uniqueCredentials.length !== this.backofficeCredentials.length) {
      this.backofficeCredentials.splice(0, this.backofficeCredentials.length, ...uniqueCredentials);
    }

    return changed;
  }

  private ensureDefaultBackofficeCredential(
    user: UserRecord,
    role: BackofficeRole,
    username: string,
    password: string,
    existingCredential?: Pick<BackofficeCredentialRecord, "passwordSalt" | "passwordHash">,
    tenantId?: string
  ) {
    const existing = this.findBackofficeCredentialByUserId(user.id, role);

    if (existing) {
      if (tenantId && existing.tenantId !== tenantId) {
        existing.tenantId = tenantId;
        return true;
      }

      if (
        role === "super_admin" &&
        existing.usesDefaultPassword &&
        existing.username === DEFAULT_ADMIN_USERNAME
      ) {
        const hashedPassword = hashAdminPassword(password);
        existing.username = username;
        existing.passwordSalt = hashedPassword.salt;
        existing.passwordHash = hashedPassword.hash;
        existing.passwordUpdatedAt = new Date().toISOString();
        return true;
      }

      return false;
    }

    const hashedPassword = existingCredential
      ? {
          salt: existingCredential.passwordSalt,
          hash: existingCredential.passwordHash
        }
      : hashAdminPassword(password);

    this.backofficeCredentials.unshift({
      userId: user.id,
      username,
      role,
      tenantId,
      passwordSalt: hashedPassword.salt,
      passwordHash: hashedPassword.hash,
      usesDefaultPassword: true,
      passwordUpdatedAt: new Date().toISOString()
    });

    return true;
  }
}
