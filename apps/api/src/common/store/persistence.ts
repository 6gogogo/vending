import {
  closeSync,
  constants as fsConstants,
  existsSync,
  fchmodSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  unlinkSync,
  writeSync,
  writeFileSync
} from "node:fs";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";

import { cloneSeedState, type AlertTask, type BackofficePermission, type BackofficeRole, type BatchConsumptionTrace, type CabinetAccessRule, type CabinetEventRecord, type CabinetReservationRecord, type CallbackLogRecord, type DeviceGoodsSetting, type DeviceRecord, type DeviceRuntimeState, type ExpiredBatchDispositionRecord, type GoodsAlertPolicy, type GoodsBatchRecord, type GoodsCatalogItem, type GoodsCategoryRecord, type GoodsTaxonomyNode, type InventoryMovement, type InventoryTransferRecord, type MerchantGoodsTemplate, type OperationLogRecord, type PaymentOrderRecord, type PaymentRefundRecord, type PlatformTenantRecord, type RegionRecord, type RegistrationApplication, type ReservationSettings, type SpecialAccessPolicy, type StocktakeRecord, type SystemAuditLogEntry, type UserRecord, type UserRole, type WarehouseRecord } from "@vm/shared-types";

import { sanitizeAuditLogEntry } from "../logging/audit-log-sanitizer";
import {
  isCallbackLogRecordSanitized,
  isOperationLogCallbackMetadataSanitized,
  sanitizeCallbackLogRecord,
  sanitizeOperationLogCallbackMetadata
} from "../logging/callback-log-sanitizer";
import {
  assertPersistedStateIntegrity,
  validatePersistedState
} from "./persisted-state-integrity";
import {
  envFilesDeclareProductionRuntime,
  isProductionRuntime,
  isTestEnvironmentIsolated
} from "../config/runtime-environment";
import {
  assertLivePlatformTenantConfiguration,
  createSimulationPlatformTenant,
  resolveLivePlatformTenantConfiguration,
  resolveRuntimeDataPlane,
  resolveRuntimeDataPlaneInstanceId,
  RUNTIME_DATA_PLANE_ENV_KEY,
  RUNTIME_DATA_PLANE_ID_ENV_KEY,
  RUNTIME_DATA_ROOT_ENV_KEY,
  type RuntimeDataPlane
} from "../config/runtime-data-plane";
import { isFullSimulationProfile } from "../config/full-simulation-mode";
import { runWithFinancialWriterFence } from "../coordination/financial-writer-fence";

export type VerificationPurpose = "app-login" | "register" | "general" | "password-reset";
export type ExternalVerificationProvider = "manual" | "aliyun_pnvs";
export type PersistedDataPlaneInitializationSource =
  | "simulation-seed"
  | "simulation-empty"
  | "legacy-simulation"
  | "live-bootstrap-pending"
  | "live-bootstrap";

export interface VerificationRecord {
  code: string;
  purpose: VerificationPurpose;
  challengeId?: string;
  expiresAt: string;
  requestedAt?: string;
  resendAvailableAt?: string;
  failedAttempts?: number;
  consumedAt?: string;
  externalChallenge?: boolean;
  externalProvider?: ExternalVerificationProvider;
  externalChallengeId?: string;
  manualGrant?: boolean;
  manualGrantId?: string;
  issuerUserId?: string;
  targetUserId?: string;
  tenantId?: string;
  phoneHash?: string;
  codeSalt?: string;
  codeHash?: string;
  revokedAt?: string;
}

export interface ManualVerificationGrantRecord {
  manualGrantId: string;
  challengeKey: string;
  purpose: Extract<VerificationPurpose, "app-login" | "password-reset">;
  issuerUserId: string;
  targetUserId: string;
  tenantId: string;
  phoneHash: string;
  codeSalt?: string;
  codeHash?: string;
  expiresAt: string;
  requestedAt: string;
  failedAttempts: number;
  consumedAt?: string;
  revokedAt?: string;
  lockedAt?: string;
  expiredAt?: string;
  supersededAt?: string;
  supersededByGrantId?: string;
}

export interface SessionRecord {
  token: string;
  /** 会话只以令牌摘要持久化；移动端长期保活，后台会话必须设置过期时间。 */
  persistent?: boolean;
  userId: string;
  role: UserRole;
  backofficeRole?: BackofficeRole;
  tenantId?: string;
  mobileAdminCredentialUpdatedAt?: string;
  mobileAdminTenantCredentialUpdatedAt?: string;
  createdAt: string;
  expiresAt?: string;
}

export interface DraftSessionRecord {
  token: string;
  tenantId?: string;
  phone: string;
  requestedRole?: UserRole;
  linkedUserId?: string;
  applicationId?: string;
  createdAt: string;
  expiresAt: string;
}

export interface AdminCredentialRecord {
  userId: string;
  username: string;
  passwordSalt: string;
  passwordHash: string;
  usesDefaultPassword: boolean;
  passwordUpdatedAt: string;
}

export interface BackofficeCredentialRecord {
  userId: string;
  username: string;
  role: BackofficeRole;
  tenantId?: string;
  permissions?: BackofficePermission[];
  passwordSalt: string;
  passwordHash: string;
  usesDefaultPassword: boolean;
  passwordUpdatedAt: string;
}

export interface PersistedStoreState {
  /** 运行数据必须明确归属模拟或真实平面，避免跨平面误启动或误恢复。 */
  dataPlane: RuntimeDataPlane;
  /** 同一数据根首次初始化时生成，备份/恢复据此拒绝跨实例写入。 */
  instanceId: string;
  /** 标明状态如何进入当前平面；真实平面仅接受受控初始化完成标记。 */
  initializationSource: PersistedDataPlaneInitializationSource;
  flags?: {
    skipCompetitionTestDevice?: boolean;
  };
  users: UserRecord[];
  rules: CabinetAccessRule[];
  devices: DeviceRecord[];
  goodsCatalog: GoodsCatalogItem[];
  goodsCategories: GoodsCategoryRecord[];
  /** 旧账本可缺省；读取规范化后始终存在。 */
  goodsTaxonomyNodes: GoodsTaxonomyNode[];
  regions: RegionRecord[];
  warehouses: WarehouseRecord[];
  specialAccessPolicies: SpecialAccessPolicy[];
  goodsAlertPolicies: GoodsAlertPolicy[];
  registrationApplications: RegistrationApplication[];
  merchantGoodsTemplates: MerchantGoodsTemplate[];
  deviceGoodsSettings: DeviceGoodsSetting[];
  goodsBatches: GoodsBatchRecord[];
  batchConsumptionTraces: BatchConsumptionTrace[];
  inventoryTransfers: InventoryTransferRecord[];
  stocktakes: StocktakeRecord[];
  expiredBatchDispositions: ExpiredBatchDispositionRecord[];
  events: CabinetEventRecord[];
  inventory: InventoryMovement[];
  paymentOrders: PaymentOrderRecord[];
  paymentRefunds: PaymentRefundRecord[];
  reservations: CabinetReservationRecord[];
  reservationSettings: ReservationSettings;
  alerts: AlertTask[];
  logs: OperationLogRecord[];
  /** 平台租户是业务数据归属的一部分；真实平面只允许一个受控当前实例。 */
  platformTenants: PlatformTenantRecord[];
  verificationCodes: Array<[string, VerificationRecord]>;
  manualVerificationGrants: ManualVerificationGrantRecord[];
  sessions: Array<[string, SessionRecord]>;
  draftSessions: Array<[string, DraftSessionRecord]>;
  adminCredentials: AdminCredentialRecord[];
  backofficeCredentials: BackofficeCredentialRecord[];
  callbackLog: CallbackLogRecord[];
  deviceRuntime: Array<[string, DeviceRuntimeState]>;
}

export interface PersistedStateReadResult {
  state: PersistedStoreState;
  requiresPrivacyRewrite: boolean;
  requiresDataPlaneRewrite: boolean;
}

const MAX_PERSISTED_CALLBACK_LOGS = 1000;
const PRIVATE_RUNTIME_DIRECTORY_MODE = 0o700;
const PRIVATE_RUNTIME_FILE_MODE = 0o600;
const runtimeDataPlaneInstanceIdPattern = /^[A-Za-z0-9][A-Za-z0-9._-]{7,127}$/;
const simulationInitializationSources = new Set<PersistedDataPlaneInitializationSource>([
  "simulation-seed",
  "simulation-empty",
  "legacy-simulation"
]);
const liveInitializationSources = new Set<PersistedDataPlaneInitializationSource>([
  "live-bootstrap-pending",
  "live-bootstrap"
]);
export const isControlledLiveBootstrapProcess = () =>
  process.argv.includes("--confirm-live-initialization") &&
  process.argv.some((argument) => /(?:^|[\\/])initialize-live-data\.(?:ts|js)$/.test(argument));
export const DEFAULT_RESERVATION_SETTINGS: ReservationSettings = {
  enabled: true,
  holdMinutes: 60,
  maxTimeouts: 3
};

const findApiWorkspaceRoot = () => {
  const cwdApiRoot = resolve(process.cwd(), "apps/api");

  if (existsSync(resolve(cwdApiRoot, "package.json"))) {
    return cwdApiRoot;
  }

  if (existsSync(resolve(process.cwd(), "package.json"))) {
    const packageJson = readFileSync(resolve(process.cwd(), "package.json"), "utf8");

    if (packageJson.includes('"name": "@vm/api"')) {
      return process.cwd();
    }
  }

  let cursor = dirname(fileURLToPath(import.meta.url));

  for (let level = 0; level < 10; level += 1) {
    const packageJsonPath = resolve(cursor, "package.json");

    if (existsSync(packageJsonPath)) {
      const packageJson = readFileSync(packageJsonPath, "utf8");

      if (packageJson.includes('"name": "@vm/api"')) {
        return cursor;
      }
    }

    const parent = resolve(cursor, "..");

    if (parent === cursor) {
      break;
    }

    cursor = parent;
  }

  return resolve(process.cwd(), "apps/api");
};

const apiWorkspaceRoot = findApiWorkspaceRoot();

export const resolveApiWorkspaceRoot = () => apiWorkspaceRoot;

const loadApiEnvFile = () => {
  if (isTestEnvironmentIsolated()) {
    return;
  }

  const processWithEnvLoader = process as typeof process & {
    loadEnvFile?: (path?: string) => void;
  };

  const envPaths = [
    ".env.local",
    ".env",
    "apps/api/.env.local",
    "apps/api/.env"
  ];

  for (const envPath of envPaths) {
    try {
      processWithEnvLoader.loadEnvFile?.(envPath);
    } catch {
      // 当前环境没有配置某个 env 文件时直接跳过。
    }
  }

  const hasExplicitDataPlaneConfig = Boolean(
    process.env[RUNTIME_DATA_PLANE_ENV_KEY]?.trim() ||
      process.env[RUNTIME_DATA_ROOT_ENV_KEY]?.trim() ||
      process.env[RUNTIME_DATA_PLANE_ID_ENV_KEY]?.trim()
  );
  const shouldLoadExamples =
    !hasExplicitDataPlaneConfig &&
    !isProductionRuntime() &&
    !envFilesDeclareProductionRuntime(envPaths);

  if (!shouldLoadExamples) {
    return;
  }

  for (const envPath of [".env.example", "apps/api/.env.example"]) {
    try {
      processWithEnvLoader.loadEnvFile?.(envPath);
    } catch {
      // 当前环境没有配置样例文件时直接跳过。
    }
  }
};

const resolveApiWorkspacePath = (configuredPath: string, fallbackRelativePath: string) => {
  const rawPath = configuredPath || fallbackRelativePath;
  const normalizedPath = rawPath.replace(/\\/g, "/");

  if (isAbsolute(rawPath)) {
    return rawPath;
  }

  if (normalizedPath.startsWith("apps/api/")) {
    return resolve(apiWorkspaceRoot, normalizedPath.slice("apps/api/".length));
  }

  return resolve(apiWorkspaceRoot, rawPath);
};

export interface RuntimeStoragePaths {
  dataPlane: RuntimeDataPlane;
  instanceId: string;
  root?: string;
  dataFile: string;
  uploadDir: string;
  systemLogFile: string;
  backupDir: string;
  financialLeaseFile: string;
}

const runtimeStorageOverrideKeys = [
  "API_DATA_FILE",
  "UPLOAD_DIR",
  "SYSTEM_LOG_FILE",
  "API_BACKUP_DIR",
  "FINANCIAL_SINGLE_WRITER_LEASE_FILE"
] as const;

const getConfiguredRuntimeStorageOverrides = () =>
  runtimeStorageOverrideKeys.filter((key) => Boolean(process.env[key]?.trim()));

/**
 * live 平面和全真模拟档都只接受一个根目录，并从中派生全部运行路径。这样状态、审计、上传、
 * 备份和金融租约不会混入另一条数据路径；标准模拟仍保留旧路径配置，兼容已有本地夹具。
 */
export const resolveRuntimeStoragePaths = (): RuntimeStoragePaths => {
  loadApiEnvFile();
  const dataPlane = resolveRuntimeDataPlane();
  const instanceId = resolveRuntimeDataPlaneInstanceId();
  const configuredRoot = process.env[RUNTIME_DATA_ROOT_ENV_KEY]?.trim();
  const configuredOverrides = getConfiguredRuntimeStorageOverrides();
  const fullSimulation = isFullSimulationProfile();

  if (dataPlane === "live" || fullSimulation) {
    if (!configuredRoot) {
      throw new Error(
        `${dataPlane === "live" ? "真实数据平面" : "全真模拟"}必须设置 ${RUNTIME_DATA_ROOT_ENV_KEY}，并由该根目录派生全部运行路径。`
      );
    }

    if (configuredOverrides.length > 0) {
      throw new Error(
        `${dataPlane === "live" ? "真实数据平面" : "全真模拟"}不能单独设置 ${configuredOverrides.join("、")}；请只使用 ${RUNTIME_DATA_ROOT_ENV_KEY}。`
      );
    }

    const root = resolveApiWorkspacePath(
      configuredRoot,
      dataPlane === "live" ? "runtime-data/live" : "runtime-data/full-simulation"
    );
    return {
      dataPlane,
      instanceId,
      root,
      dataFile: join(root, "store.json"),
      uploadDir: join(root, "uploads"),
      systemLogFile: join(root, "system-audit.ndjson"),
      backupDir: join(root, "backups"),
      financialLeaseFile: join(root, "financial-writer.lock")
    };
  }

  if (configuredRoot) {
    if (configuredOverrides.length > 0) {
      throw new Error(
        `${RUNTIME_DATA_ROOT_ENV_KEY} 不能与 ${configuredOverrides.join("、")} 同时设置；请只选择一种模拟数据路径配置方式。`
      );
    }

    const root = resolveApiWorkspacePath(configuredRoot, "runtime-data/simulation");
    return {
      dataPlane,
      instanceId,
      root,
      dataFile: join(root, "store.json"),
      uploadDir: join(root, "uploads"),
      systemLogFile: join(root, "system-audit.ndjson"),
      backupDir: join(root, "backups"),
      financialLeaseFile: join(root, "financial-writer.lock")
    };
  }

  return {
    dataPlane,
    instanceId,
    dataFile: resolveApiWorkspacePath(
      process.env.API_DATA_FILE ?? "runtime-data/store.json",
      "runtime-data/store.json"
    ),
    uploadDir: resolveApiWorkspacePath(
      process.env.UPLOAD_DIR ?? "runtime-uploads",
      "runtime-uploads"
    ),
    systemLogFile: resolveApiWorkspacePath(
      process.env.SYSTEM_LOG_FILE ?? "runtime-data/system-audit.ndjson",
      "runtime-data/system-audit.ndjson"
    ),
    backupDir: resolveApiWorkspacePath(
      process.env.API_BACKUP_DIR ?? "runtime-backups",
      "runtime-backups"
    ),
    financialLeaseFile: resolveApiWorkspacePath(
      process.env.FINANCIAL_SINGLE_WRITER_LEASE_FILE ?? "runtime-data/financial-writer.lock",
      "runtime-data/financial-writer.lock"
    )
  };
};

export const resolveApiDataFile = () => {
  return resolveRuntimeStoragePaths().dataFile;
};

export const resolveUploadDir = () => {
  return resolveRuntimeStoragePaths().uploadDir;
};

export const resolveSystemLogFile = () => {
  return resolveRuntimeStoragePaths().systemLogFile;
};

export const resolveApiBackupDir = () => {
  return resolveRuntimeStoragePaths().backupDir;
};

export const resolveFinancialSingleWriterLeaseFile = (configuredPath?: string) => {
  const paths = resolveRuntimeStoragePaths();

  if (paths.dataPlane === "live" || isFullSimulationProfile()) {
    if (configuredPath?.trim()) {
      throw new Error(
        `${paths.dataPlane === "live" ? "真实数据平面" : "全真模拟"}不能单独设置 FINANCIAL_SINGLE_WRITER_LEASE_FILE；请只使用 ${RUNTIME_DATA_ROOT_ENV_KEY}。`
      );
    }

    return paths.financialLeaseFile;
  }

  return resolveApiWorkspacePath(
    configuredPath?.trim() ||
      process.env.FINANCIAL_SINGLE_WRITER_LEASE_FILE ||
      "runtime-data/financial-writer.lock",
    "runtime-data/financial-writer.lock"
  );
};

const isolatedSystemSettingsEnvFileKey = "VM_ISOLATED_SYSTEM_SETTINGS_ENV_FILE";

export const resolveApiEnvFile = () => {
  const isolatedEnvFile = process.env[isolatedSystemSettingsEnvFileKey]?.trim();

  if (isTestEnvironmentIsolated() && isolatedEnvFile) {
    if (!isAbsolute(isolatedEnvFile)) {
      throw new Error(`${isolatedSystemSettingsEnvFileKey} 必须是绝对路径。`);
    }

    return resolve(isolatedEnvFile);
  }

  return resolve(apiWorkspaceRoot, ".env");
};

export const createSeededPersistedState = (
  instanceId =
    resolveRuntimeDataPlane() === "simulation"
      ? resolveRuntimeDataPlaneInstanceId()
      : "simulation-default"
): PersistedStoreState => {
  const seed = cloneSeedState();

  return {
    dataPlane: "simulation",
    instanceId,
    initializationSource: "simulation-seed",
    ...seed,
    platformTenants: [createSimulationPlatformTenant()],
    verificationCodes: [],
    manualVerificationGrants: [],
    sessions: [],
    draftSessions: [],
    adminCredentials: [],
    backofficeCredentials: [],
    paymentOrders: [],
    paymentRefunds: [],
    expiredBatchDispositions: [],
    reservations: [],
    reservationSettings: structuredClone(DEFAULT_RESERVATION_SETTINGS),
    callbackLog: [],
    deviceRuntime: seed.devices.map((device) => [
      device.deviceCode,
      {
        deviceCode: device.deviceCode,
        doorState: "closed",
        lastOpenedAt: seed.events
          .filter((event) => event.deviceCode === device.deviceCode)
          .map((event) => event.updatedAt)
          .sort()
          .at(-1),
        lastClosedAt: seed.events
          .filter((event) => event.deviceCode === device.deviceCode)
          .map((event) => event.updatedAt)
          .sort()
          .at(-1),
        lastRefreshAt: device.lastSeenAt,
        openedAfterLastCommand: true
      }
    ])
  };
};

export const createEmptyPersistedState = (
  dataPlane: RuntimeDataPlane = resolveRuntimeDataPlane(),
  instanceId?: string
): PersistedStoreState => {
  const runtimeDataPlane = resolveRuntimeDataPlane();
  const resolvedInstanceId =
    instanceId ??
    (dataPlane === runtimeDataPlane
      ? resolveRuntimeDataPlaneInstanceId()
      : dataPlane === "simulation"
        ? "simulation-default"
        : randomUUID());
  const platformTenants: PlatformTenantRecord[] =
    dataPlane === "simulation"
      ? [createSimulationPlatformTenant()]
      : runtimeDataPlane === "live"
        ? (() => {
            // 待初始化空库只验证部署配置，不提前落租户记录；受控初始化在写入首个管理员
            // 前原子地创建该记录。否则“空库不得含历史数组”的防护会把自身身份记录当成历史数据。
            resolveLivePlatformTenantConfiguration();

            return [];
          })()
        : [];

  return {
    dataPlane,
    instanceId: resolvedInstanceId,
    initializationSource:
      dataPlane === "live" ? "live-bootstrap-pending" : "simulation-empty",
    flags: {
      skipCompetitionTestDevice: true
    },
    users: [],
    rules: [],
    devices: [],
    goodsCatalog: [],
    goodsCategories: [],
    goodsTaxonomyNodes: [],
    regions: [],
    warehouses: [],
    specialAccessPolicies: [],
    goodsAlertPolicies: [],
    registrationApplications: [],
    merchantGoodsTemplates: [],
    deviceGoodsSettings: [],
    goodsBatches: [],
    batchConsumptionTraces: [],
    inventoryTransfers: [],
    stocktakes: [],
    expiredBatchDispositions: [],
    events: [],
    inventory: [],
    paymentOrders: [],
    paymentRefunds: [],
    reservations: [],
    reservationSettings: structuredClone(DEFAULT_RESERVATION_SETTINGS),
    alerts: [],
    logs: [],
    platformTenants,
    verificationCodes: [],
    manualVerificationGrants: [],
    sessions: [],
    draftSessions: [],
    adminCredentials: [],
    backofficeCredentials: [],
    callbackLog: [],
    deviceRuntime: []
  };
};

const readPlatformTenantHostname = (instanceUrl: unknown) => {
  if (typeof instanceUrl !== "string" || !instanceUrl.trim()) {
    return undefined;
  }

  try {
    return new URL(instanceUrl).hostname.toLowerCase();
  } catch {
    return undefined;
  }
};

/**
 * 早期模拟快照会保留当时的默认实例 URL；公网入口迁移后，App 会在验证码校验前
 * 因 Host 找不到实例而返回 404。只对既有固定默认实例做一次保守校正：若它已暂停，
 * 或其他实例已声明当前公网 Host，则不改写，继续由实例隔离规则拒绝请求。
 */
const reconcileSimulationDefaultTenantPublicHost = (
  tenants: PlatformTenantRecord[]
) => {
  const expectedTenant = createSimulationPlatformTenant();
  const [defaultTenant, ...otherTenants] = tenants;

  if (
    defaultTenant?.id !== expectedTenant.id ||
    defaultTenant.code !== expectedTenant.code ||
    defaultTenant.status === "paused"
  ) {
    return tenants;
  }

  const expectedHostname = readPlatformTenantHostname(expectedTenant.instanceUrl);

  if (
    !expectedHostname ||
    readPlatformTenantHostname(defaultTenant.instanceUrl) === expectedHostname
  ) {
    return tenants;
  }

  if (
    otherTenants.some(
      (tenant) => readPlatformTenantHostname(tenant?.instanceUrl) === expectedHostname
    )
  ) {
    return tenants;
  }

  return [
    {
      ...defaultTenant,
      instanceUrl: expectedTenant.instanceUrl
    },
    ...otherTenants
  ];
};

const normalizePlatformTenantServiceModes = (
  tenants: PlatformTenantRecord[],
  dataPlane: RuntimeDataPlane
) => {
  let changed = false;
  const normalized = tenants.map((tenant) => {
    const serviceMode = (tenant as Partial<PlatformTenantRecord>).serviceMode;

    if (serviceMode !== undefined && serviceMode !== "simulation" && serviceMode !== "production") {
      throw new Error("客户实例服务模式无效，已拒绝启动。");
    }

    if (dataPlane === "live" && serviceMode === "simulation") {
      throw new Error("真实数据平面的客户实例不能标记为模拟服务。");
    }

    if (serviceMode) {
      return tenant;
    }

    changed = true;
    const inferredServiceMode: PlatformTenantRecord["serviceMode"] =
      dataPlane === "live" ? "production" : "simulation";
    return {
      ...tenant,
      serviceMode: inferredServiceMode
    };
  });

  return changed ? normalized : tenants;
};

const normalizePersistedState = (
  raw: Partial<PersistedStoreState>,
  options: {
    legacySimulationInstanceId?: string;
  } = {}
): PersistedStoreState => {
  const dataPlane = raw.dataPlane === "live" ? "live" : "simulation";
  const instanceId =
    typeof raw.instanceId === "string" && raw.instanceId.trim()
      ? raw.instanceId.trim()
      : dataPlane === "simulation"
        ? options.legacySimulationInstanceId ?? "simulation-legacy"
        : "";
  // live 绝不能借由结构兼容逻辑回填模拟种子。读入时会对 live 原始状态强制做完整性校验；
  // 这里仍以空状态作防御性默认值，避免未来新增字段时意外带入测试数据。
  const fallbackState =
    dataPlane === "live"
      ? createEmptyPersistedState("live", instanceId || "live-invalid-instance")
      : createSeededPersistedState(instanceId);
  const initializationSource =
    raw.initializationSource === "simulation-seed" ||
    raw.initializationSource === "simulation-empty" ||
    raw.initializationSource === "legacy-simulation" ||
    raw.initializationSource === "live-bootstrap-pending" ||
    raw.initializationSource === "live-bootstrap"
      ? raw.initializationSource
      : dataPlane === "simulation"
        ? "legacy-simulation"
        : "live-bootstrap-pending";
  const sourcePlatformTenants = normalizePlatformTenantServiceModes(
    raw.platformTenants ?? fallbackState.platformTenants,
    dataPlane
  );
  const platformTenants =
    dataPlane === "simulation"
      ? reconcileSimulationDefaultTenantPublicHost(sourcePlatformTenants)
      : sourcePlatformTenants;

  return {
    dataPlane,
    instanceId,
    initializationSource,
    flags: raw.flags,
    users: raw.users ?? fallbackState.users,
    rules: raw.rules ?? fallbackState.rules,
    devices: raw.devices ?? fallbackState.devices,
    goodsCatalog: raw.goodsCatalog ?? fallbackState.goodsCatalog,
    goodsCategories: raw.goodsCategories ?? fallbackState.goodsCategories,
    goodsTaxonomyNodes: raw.goodsTaxonomyNodes ?? fallbackState.goodsTaxonomyNodes,
    regions: raw.regions ?? fallbackState.regions,
    warehouses: raw.warehouses ?? fallbackState.warehouses,
    specialAccessPolicies: raw.specialAccessPolicies ?? fallbackState.specialAccessPolicies,
    goodsAlertPolicies: raw.goodsAlertPolicies ?? fallbackState.goodsAlertPolicies,
    registrationApplications: raw.registrationApplications ?? fallbackState.registrationApplications,
    merchantGoodsTemplates: raw.merchantGoodsTemplates ?? fallbackState.merchantGoodsTemplates,
    deviceGoodsSettings: raw.deviceGoodsSettings ?? fallbackState.deviceGoodsSettings,
    goodsBatches: raw.goodsBatches ?? fallbackState.goodsBatches,
    batchConsumptionTraces: raw.batchConsumptionTraces ?? fallbackState.batchConsumptionTraces,
    inventoryTransfers: raw.inventoryTransfers ?? fallbackState.inventoryTransfers,
    stocktakes: raw.stocktakes ?? fallbackState.stocktakes,
    expiredBatchDispositions: raw.expiredBatchDispositions ?? fallbackState.expiredBatchDispositions,
    events: raw.events ?? fallbackState.events,
    inventory: raw.inventory ?? fallbackState.inventory,
    paymentOrders: raw.paymentOrders ?? fallbackState.paymentOrders,
    paymentRefunds: raw.paymentRefunds ?? fallbackState.paymentRefunds,
    reservations: (raw.reservations ?? fallbackState.reservations).map((reservation) => ({
      ...reservation,
      inventoryReservationMode: "goods_quantity",
      batchAllocationTiming: "on_open"
    })),
    reservationSettings: {
      ...DEFAULT_RESERVATION_SETTINGS,
      ...(raw.reservationSettings ?? fallbackState.reservationSettings)
    },
    alerts: raw.alerts ?? fallbackState.alerts,
    logs: (raw.logs ?? fallbackState.logs).map((entry) => ({
      ...entry,
      metadata: sanitizeOperationLogCallbackMetadata(entry.metadata)
    })),
    platformTenants,
    verificationCodes: raw.verificationCodes ?? fallbackState.verificationCodes,
    manualVerificationGrants:
      raw.manualVerificationGrants ?? fallbackState.manualVerificationGrants,
    sessions: raw.sessions ?? fallbackState.sessions,
    draftSessions: raw.draftSessions ?? fallbackState.draftSessions,
    adminCredentials: raw.adminCredentials ?? fallbackState.adminCredentials,
    backofficeCredentials: raw.backofficeCredentials ?? fallbackState.backofficeCredentials,
    callbackLog: (raw.callbackLog ?? fallbackState.callbackLog)
      .slice(0, MAX_PERSISTED_CALLBACK_LOGS)
      .map((entry) => sanitizeCallbackLogRecord(entry))
      .filter((entry): entry is NonNullable<typeof entry> => Boolean(entry)),
    deviceRuntime: raw.deviceRuntime ?? fallbackState.deviceRuntime
  };
};

export const assertNoInterruptedRuntimeRestoreArtifacts = (targetPaths: string[]) => {
  for (const targetPath of targetPaths) {
    const parentDirectory = dirname(targetPath);

    if (!existsSync(parentDirectory)) {
      continue;
    }

    const targetName = basename(targetPath);
    const hasInterruptedRestoreArtifact = readdirSync(parentDirectory).some(
      (entryName) =>
        (entryName.startsWith(`.${targetName}.staging-`) ||
          entryName.startsWith(`.${targetName}.rollback-`)) &&
        entryName.endsWith(".tmp")
    );

    if (hasInterruptedRestoreArtifact) {
      throw new Error(
        "检测到未完成的运行数据恢复残留，已拒绝启动；请在维护窗口按恢复流程核对并处理。"
      );
    }
  }
};

/**
 * 仅完全无 marker 的历史模拟状态可在 simulation 平面进行一次元数据迁移。任何半迁移、
 * 拼写错误或跨平面 marker 都不能被当作模拟数据“兼容修复”，否则会把错误状态写回覆盖证据。
 */
const assertPersistedDataPlaneMarkerIsKnown = (raw: Partial<PersistedStoreState>) => {
  const hasNoMarker =
    raw.dataPlane === undefined &&
    raw.instanceId === undefined &&
    raw.initializationSource === undefined;

  if (hasNoMarker) {
    return;
  }

  if (
    (raw.dataPlane !== "simulation" && raw.dataPlane !== "live") ||
    typeof raw.instanceId !== "string" ||
    !runtimeDataPlaneInstanceIdPattern.test(raw.instanceId) ||
    typeof raw.initializationSource !== "string"
  ) {
    throw new Error("运行数据平面标记无效或不完整，已拒绝启动。");
  }

  const source = raw.initializationSource as PersistedDataPlaneInitializationSource;
  const sourceMatchesPlane =
    (raw.dataPlane === "simulation" && simulationInitializationSources.has(source)) ||
    (raw.dataPlane === "live" && liveInitializationSources.has(source));

  if (!sourceMatchesPlane) {
    throw new Error("运行数据平面初始化标记与数据平面不匹配，已拒绝启动。");
  }
};

export const readPersistedStateWithMetadata = (): PersistedStateReadResult | undefined => {
  const filePath = resolveApiDataFile();
  const runtimeDataPlane = resolveRuntimeDataPlane();
  const runtimeDataPlaneInstanceId = resolveRuntimeDataPlaneInstanceId();

  // 即使真实库尚不存在，也不能让缺失的实例 URL 或名称绕过首次初始化门禁。
  if (runtimeDataPlane === "live") {
    resolveLivePlatformTenantConfiguration();
  }

  if (isProductionRuntime()) {
    assertNoInterruptedRuntimeRestoreArtifacts([
      filePath,
      resolveSystemLogFile(),
      resolveUploadDir()
    ]);
  }

  if (!existsSync(filePath)) {
    return undefined;
  }

  const parsed = JSON.parse(readFileSync(filePath, "utf8")) as unknown;

  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("业务数据根节点必须是对象，已拒绝启动。");
  }

  const raw = parsed as Partial<PersistedStoreState>;
  assertPersistedDataPlaneMarkerIsKnown(raw);

  if (runtimeDataPlane === "live") {
    const isPendingBootstrap =
      raw.dataPlane === "live" && raw.initializationSource === "live-bootstrap-pending";

    if (isPendingBootstrap) {
      if (!isControlledLiveBootstrapProcess()) {
        throw new Error("待初始化的真实数据平面只能由受控初始化命令读取。");
      }

      if (!Array.isArray(raw.platformTenants) || raw.platformTenants.length !== 0) {
        throw new Error("待初始化的真实数据平面不能预先持久化客户实例或历史记录。");
      }
    } else {
      assertLivePlatformTenantConfiguration(raw.platformTenants);
    }
  }

  const normalized = normalizePersistedState(raw, {
    legacySimulationInstanceId:
      runtimeDataPlane === "simulation" &&
      raw.dataPlane === undefined &&
      raw.instanceId === undefined &&
      raw.initializationSource === undefined
        ? runtimeDataPlaneInstanceId
        : undefined
  });

  if (normalized.dataPlane !== runtimeDataPlane) {
    throw new Error(
      `运行数据平面标记与当前 ${RUNTIME_DATA_PLANE_ENV_KEY} 不一致，已拒绝启动。`
    );
  }

  if (!runtimeDataPlaneInstanceIdPattern.test(normalized.instanceId)) {
    throw new Error("运行数据平面实例标识格式无效，已拒绝启动。");
  }

  if (normalized.instanceId !== runtimeDataPlaneInstanceId) {
    throw new Error("运行数据平面实例标识与当前受控部署配置不一致，已拒绝启动。");
  }

  const validation = validatePersistedState(raw);
  const hasInvalidManualVerificationGrants =
    raw.manualVerificationGrants !== undefined &&
    !Array.isArray(raw.manualVerificationGrants);

  if (
    (isProductionRuntime() || runtimeDataPlane === "live" || hasInvalidManualVerificationGrants) &&
    validation.errors.length > 0
  ) {
    throw new Error("运行数据完整性检查未通过。");
  }

  return {
    state: normalized,
    requiresPrivacyRewrite:
      (raw.callbackLog?.some((entry) => !isCallbackLogRecordSanitized(entry)) ?? false) ||
      (raw.logs?.some((entry) => !isOperationLogCallbackMetadataSanitized(entry.metadata)) ?? false),
    requiresDataPlaneRewrite:
      raw.dataPlane !== normalized.dataPlane ||
      raw.instanceId !== normalized.instanceId ||
      raw.initializationSource !== normalized.initializationSource ||
      raw.platformTenants === undefined ||
      raw.platformTenants !== normalized.platformTenants ||
      raw.manualVerificationGrants === undefined
  };
};

export const readPersistedState = () => readPersistedStateWithMetadata()?.state;

export interface PersistedStateFileSystem {
  mkdirSync: (path: string, options: { recursive: true; mode: number }) => string | undefined;
  openSync: (path: string, flags: string | number, mode?: number) => number;
  writeFileSync: (fileDescriptor: number, data: string, encoding: "utf8") => void;
  fsyncSync: (fileDescriptor: number) => void;
  closeSync: (fileDescriptor: number) => void;
  renameSync: (oldPath: string, newPath: string) => void;
  existsSync: (path: string) => boolean;
  unlinkSync: (path: string) => void;
}

export class PersistedStateWriteError extends Error {
  constructor(
    message: string,
    public readonly committed: boolean
  ) {
    super(message);
    this.name = "PersistedStateWriteError";
  }
}

const nodePersistedStateFileSystem: PersistedStateFileSystem = {
  mkdirSync,
  openSync,
  writeFileSync,
  fsyncSync,
  closeSync,
  renameSync,
  existsSync,
  unlinkSync
};

/**
 * 先同步临时快照，再原子替换并同步父目录；任一阶段不确定都向调用方报告失败。
 * Windows 缺少等价的可移植目录 fsync，因此发布门禁不得把该平台当作 POSIX 耐久性保证。
 */
export const createPersistedStateWriter = (
  fileSystem: PersistedStateFileSystem = nodePersistedStateFileSystem,
  platform: NodeJS.Platform = process.platform,
  resolveDataFile: () => string = resolveApiDataFile,
  createTemporaryToken: () => string = randomUUID
) => {
  return (state: PersistedStoreState) => {
    assertPersistedStateIntegrity(state);
    const filePath = resolveDataFile();
    const directory = dirname(filePath);
    fileSystem.mkdirSync(directory, {
      recursive: true,
      mode: PRIVATE_RUNTIME_DIRECTORY_MODE
    });
    const temporaryPath = `${filePath}.${process.pid}.${createTemporaryToken()}.tmp`;
    let fileDescriptor: number | undefined;
    let directoryDescriptor: number | undefined;
    let committed = false;

    try {
      fileDescriptor = fileSystem.openSync(temporaryPath, "wx", PRIVATE_RUNTIME_FILE_MODE);
      fileSystem.writeFileSync(fileDescriptor, JSON.stringify(state, null, 2), "utf8");
      fileSystem.fsyncSync(fileDescriptor);
      fileSystem.closeSync(fileDescriptor);
      fileDescriptor = undefined;
      fileSystem.renameSync(temporaryPath, filePath);
      committed = true;

      if (platform !== "win32") {
        directoryDescriptor = fileSystem.openSync(directory, "r");
        fileSystem.fsyncSync(directoryDescriptor);
        fileSystem.closeSync(directoryDescriptor);
        directoryDescriptor = undefined;
      }
    } catch (error) {
      if (fileDescriptor !== undefined) {
        try {
          fileSystem.closeSync(fileDescriptor);
        } catch {
          // 保留原始失败；关闭异常同样要求调用方失败关闭。
        }
      }

      if (directoryDescriptor !== undefined) {
        try {
          fileSystem.closeSync(directoryDescriptor);
        } catch {
          // 保留原始失败；目录句柄关闭异常不改变是否已经替换正式文件。
        }
      }

      if (!committed && fileSystem.existsSync(temporaryPath)) {
        try {
          fileSystem.unlinkSync(temporaryPath);
        } catch {
          // 暂存文件作为失败现场保留，不能覆盖原始错误。
        }
      }

      if (error instanceof PersistedStateWriteError) {
        throw error;
      }

      throw new PersistedStateWriteError(
        committed
          ? "业务数据已替换，但目录耐久性未确认。"
          : "业务数据写入未提交。",
        committed
      );
    }

    return filePath;
  };
};

const writePersistedStateToDisk = createPersistedStateWriter();

export const writePersistedState = (state: PersistedStoreState) => {
  const runtimePaths = resolveRuntimeStoragePaths();

  if (
    state.dataPlane !== runtimePaths.dataPlane ||
    state.instanceId !== runtimePaths.instanceId
  ) {
    throw new Error("待写入业务数据的数据平面与当前受控部署配置不一致。");
  }

  if (state.dataPlane === "live") {
    if (state.initializationSource === "live-bootstrap-pending") {
      if (!isControlledLiveBootstrapProcess()) {
        throw new Error("待初始化的真实数据平面只能由受控初始化命令写入。");
      }

      if (state.platformTenants.length !== 0) {
        throw new Error("待初始化的真实数据平面不能预先持久化客户实例。");
      }
    } else {
      assertLivePlatformTenantConfiguration(state.platformTenants);
    }
  }

  return runWithFinancialWriterFence(() => writePersistedStateToDisk(state));
};

export interface SystemAuditLogFileSystem {
  mkdirSync: (path: string, options: { recursive: true; mode: number }) => string | undefined;
  existsSync: (path: string) => boolean;
  lstatSync: (path: string) => {
    isSymbolicLink: () => boolean;
    isFile: () => boolean;
  };
  openSync: (path: string, flags: string | number, mode?: number) => number;
  fchmodSync: (fileDescriptor: number, mode: number) => void;
  fstatSync: (fileDescriptor: number) => {
    isFile: () => boolean;
  };
  writeSync: (
    fileDescriptor: number,
    buffer: Uint8Array,
    offset: number,
    length: number
  ) => number;
  fsyncSync: (fileDescriptor: number) => void;
  closeSync: (fileDescriptor: number) => void;
}

const nodeSystemAuditLogFileSystem: SystemAuditLogFileSystem = {
  mkdirSync,
  existsSync,
  lstatSync,
  openSync,
  fchmodSync,
  fstatSync,
  writeSync,
  fsyncSync,
  closeSync
};

/**
 * 只有文件数据和父目录都同步后，审计写入才视为成功。
 * 该边界不负责跨进程排序；生产部署仍必须保持单写者运行方式。
 */
export const createSystemAuditLogAppender = (
  fileSystem: SystemAuditLogFileSystem = nodeSystemAuditLogFileSystem,
  platform = process.platform
) => {
  return (entry: SystemAuditLogEntry) => {
    const filePath = resolveSystemLogFile();
    const directory = dirname(filePath);
    const fileExistedBeforeOpen = fileSystem.existsSync(filePath);
    fileSystem.mkdirSync(directory, {
      recursive: true,
      mode: PRIVATE_RUNTIME_DIRECTORY_MODE
    });

    if (fileExistedBeforeOpen) {
      const fileStat = fileSystem.lstatSync(filePath);

      if (fileStat.isSymbolicLink() || !fileStat.isFile()) {
        throw new Error("系统审计日志目标必须是普通文件。");
      }
    }

    const payload = Buffer.from(`${JSON.stringify(sanitizeAuditLogEntry(entry))}\n`, "utf8");
    let fileDescriptor: number | undefined;

    try {
      const appendFlags =
        platform === "win32"
          ? "a"
          : fsConstants.O_WRONLY |
            fsConstants.O_APPEND |
            fsConstants.O_CREAT |
            fsConstants.O_NOFOLLOW;
      fileDescriptor = fileSystem.openSync(filePath, appendFlags, PRIVATE_RUNTIME_FILE_MODE);
      fileSystem.fchmodSync(fileDescriptor, PRIVATE_RUNTIME_FILE_MODE);

      if (!fileSystem.fstatSync(fileDescriptor).isFile()) {
        throw new Error("系统审计日志目标必须是普通文件。");
      }

      for (let offset = 0; offset < payload.length;) {
        const written = fileSystem.writeSync(fileDescriptor, payload, offset, payload.length - offset);

        if (written <= 0) {
          throw new Error("系统审计日志写入未取得进展。");
        }
        offset += written;
      }

      fileSystem.fsyncSync(fileDescriptor);
    } finally {
      if (fileDescriptor !== undefined) {
        fileSystem.closeSync(fileDescriptor);
      }
    }

    if (platform !== "win32") {
      let directoryDescriptor: number | undefined;

      try {
        directoryDescriptor = fileSystem.openSync(directory, "r");
        fileSystem.fsyncSync(directoryDescriptor);
      } finally {
        if (directoryDescriptor !== undefined) {
          fileSystem.closeSync(directoryDescriptor);
        }
      }
    }

    return filePath;
  };
};

export const appendSystemAuditLog = createSystemAuditLogAppender();
