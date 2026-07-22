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
import { basename, dirname, isAbsolute, resolve } from "node:path";

import { cloneSeedState, type AlertTask, type BackofficePermission, type BackofficeRole, type BatchConsumptionTrace, type CabinetAccessRule, type CabinetEventRecord, type CabinetReservationRecord, type CallbackLogRecord, type DeviceGoodsSetting, type DeviceRecord, type DeviceRuntimeState, type ExpiredBatchDispositionRecord, type GoodsAlertPolicy, type GoodsBatchRecord, type GoodsCatalogItem, type GoodsCategoryRecord, type InventoryMovement, type InventoryTransferRecord, type MerchantGoodsTemplate, type OperationLogRecord, type PaymentOrderRecord, type PaymentRefundRecord, type RegionRecord, type RegistrationApplication, type ReservationSettings, type SpecialAccessPolicy, type StocktakeRecord, type SystemAuditLogEntry, type UserRecord, type UserRole, type WarehouseRecord } from "@vm/shared-types";

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
  isProductionRuntime
} from "../config/runtime-environment";
import { runWithFinancialWriterFence } from "../coordination/financial-writer-fence";

export type VerificationPurpose = "app-login" | "register" | "general";

export interface VerificationRecord {
  code: string;
  purpose: VerificationPurpose;
  expiresAt: string;
  requestedAt?: string;
  resendAvailableAt?: string;
  failedAttempts?: number;
  consumedAt?: string;
}

export interface SessionRecord {
  token: string;
  userId: string;
  role: UserRole;
  backofficeRole?: BackofficeRole;
  tenantId?: string;
  mobileAdminCredentialUpdatedAt?: string;
  mobileAdminTenantCredentialUpdatedAt?: string;
  createdAt: string;
  expiresAt: string;
}

export interface DraftSessionRecord {
  token: string;
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
  flags?: {
    skipCompetitionTestDevice?: boolean;
  };
  users: UserRecord[];
  rules: CabinetAccessRule[];
  devices: DeviceRecord[];
  goodsCatalog: GoodsCatalogItem[];
  goodsCategories: GoodsCategoryRecord[];
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
  verificationCodes: Array<[string, VerificationRecord]>;
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
}

const MAX_PERSISTED_CALLBACK_LOGS = 1000;
const PRIVATE_RUNTIME_DIRECTORY_MODE = 0o700;
const PRIVATE_RUNTIME_FILE_MODE = 0o600;
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
  const processWithEnvLoader = process as typeof process & {
    loadEnvFile?: (path?: string) => void;
  };

  const envPaths = [
    ".env.local",
    ".env",
    "apps/api/.env.local",
    "apps/api/.env"
  ];
  const shouldLoadExamples =
    !isProductionRuntime() && !envFilesDeclareProductionRuntime(envPaths);

  if (shouldLoadExamples) {
    envPaths.push(".env.example", "apps/api/.env.example");
  }

  for (const envPath of envPaths) {
    try {
      processWithEnvLoader.loadEnvFile?.(envPath);
    } catch {
      // 当前环境没有配置某个 env 文件时直接跳过。
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

export const resolveApiDataFile = () => {
  loadApiEnvFile();
  const configuredPath = process.env.API_DATA_FILE ?? "runtime-data/store.json";
  return resolveApiWorkspacePath(configuredPath, "runtime-data/store.json");
};

export const resolveUploadDir = () => {
  loadApiEnvFile();
  const configuredPath = process.env.UPLOAD_DIR ?? "runtime-uploads";
  return resolveApiWorkspacePath(configuredPath, "runtime-uploads");
};

export const resolveSystemLogFile = () => {
  loadApiEnvFile();
  const configuredPath = process.env.SYSTEM_LOG_FILE ?? "runtime-data/system-audit.ndjson";
  return resolveApiWorkspacePath(configuredPath, "runtime-data/system-audit.ndjson");
};

export const resolveApiBackupDir = () => {
  loadApiEnvFile();
  const configuredPath = process.env.API_BACKUP_DIR ?? "runtime-backups";
  return resolveApiWorkspacePath(configuredPath, "runtime-backups");
};

export const resolveFinancialSingleWriterLeaseFile = (configuredPath?: string) => {
  loadApiEnvFile();
  return resolveApiWorkspacePath(
    configuredPath?.trim() ||
      process.env.FINANCIAL_SINGLE_WRITER_LEASE_FILE ||
      "runtime-data/financial-writer.lock",
    "runtime-data/financial-writer.lock"
  );
};

export const resolveApiEnvFile = () => resolve(apiWorkspaceRoot, ".env");

export const createSeededPersistedState = (): PersistedStoreState => {
  const seed = cloneSeedState();

  return {
    ...seed,
    verificationCodes: [],
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

export const createEmptyPersistedState = (): PersistedStoreState => ({
  flags: {
    skipCompetitionTestDevice: true
  },
  users: [],
  rules: [],
  devices: [],
  goodsCatalog: [],
  goodsCategories: [],
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
  verificationCodes: [],
  sessions: [],
  draftSessions: [],
  adminCredentials: [],
  backofficeCredentials: [],
  callbackLog: [],
  deviceRuntime: []
});

const normalizePersistedState = (raw: Partial<PersistedStoreState>): PersistedStoreState => {
  const seeded = createSeededPersistedState();

  return {
    flags: raw.flags,
    users: raw.users ?? seeded.users,
    rules: raw.rules ?? seeded.rules,
    devices: raw.devices ?? seeded.devices,
    goodsCatalog: raw.goodsCatalog ?? seeded.goodsCatalog,
    goodsCategories: raw.goodsCategories ?? seeded.goodsCategories,
    regions: raw.regions ?? seeded.regions,
    warehouses: raw.warehouses ?? seeded.warehouses,
    specialAccessPolicies: raw.specialAccessPolicies ?? seeded.specialAccessPolicies,
    goodsAlertPolicies: raw.goodsAlertPolicies ?? seeded.goodsAlertPolicies,
    registrationApplications: raw.registrationApplications ?? seeded.registrationApplications,
    merchantGoodsTemplates: raw.merchantGoodsTemplates ?? seeded.merchantGoodsTemplates,
    deviceGoodsSettings: raw.deviceGoodsSettings ?? seeded.deviceGoodsSettings,
    goodsBatches: raw.goodsBatches ?? seeded.goodsBatches,
    batchConsumptionTraces: raw.batchConsumptionTraces ?? seeded.batchConsumptionTraces,
    inventoryTransfers: raw.inventoryTransfers ?? seeded.inventoryTransfers,
    stocktakes: raw.stocktakes ?? seeded.stocktakes,
    expiredBatchDispositions: raw.expiredBatchDispositions ?? seeded.expiredBatchDispositions,
    events: raw.events ?? seeded.events,
    inventory: raw.inventory ?? seeded.inventory,
    paymentOrders: raw.paymentOrders ?? seeded.paymentOrders,
    paymentRefunds: raw.paymentRefunds ?? seeded.paymentRefunds,
    reservations: (raw.reservations ?? seeded.reservations).map((reservation) => ({
      ...reservation,
      inventoryReservationMode: "goods_quantity",
      batchAllocationTiming: "on_open"
    })),
    reservationSettings: {
      ...DEFAULT_RESERVATION_SETTINGS,
      ...(raw.reservationSettings ?? seeded.reservationSettings)
    },
    alerts: raw.alerts ?? seeded.alerts,
    logs: (raw.logs ?? seeded.logs).map((entry) => ({
      ...entry,
      metadata: sanitizeOperationLogCallbackMetadata(entry.metadata)
    })),
    verificationCodes: raw.verificationCodes ?? seeded.verificationCodes,
    sessions: raw.sessions ?? seeded.sessions,
    draftSessions: raw.draftSessions ?? seeded.draftSessions,
    adminCredentials: raw.adminCredentials ?? seeded.adminCredentials,
    backofficeCredentials: raw.backofficeCredentials ?? seeded.backofficeCredentials,
    callbackLog: (raw.callbackLog ?? seeded.callbackLog)
      .slice(0, MAX_PERSISTED_CALLBACK_LOGS)
      .map((entry) => sanitizeCallbackLogRecord(entry))
      .filter((entry): entry is NonNullable<typeof entry> => Boolean(entry)),
    deviceRuntime: raw.deviceRuntime ?? seeded.deviceRuntime
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

export const readPersistedStateWithMetadata = (): PersistedStateReadResult | undefined => {
  const filePath = resolveApiDataFile();

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

  const raw = JSON.parse(readFileSync(filePath, "utf8")) as Partial<PersistedStoreState>;
  const validation = validatePersistedState(raw);

  if (isProductionRuntime() && validation.errors.length > 0) {
    throw new Error("运行数据完整性检查未通过。");
  }

  return {
    state: normalizePersistedState(raw),
    requiresPrivacyRewrite:
      (raw.callbackLog?.some((entry) => !isCallbackLogRecordSanitized(entry)) ?? false) ||
      (raw.logs?.some((entry) => !isOperationLogCallbackMetadataSanitized(entry.metadata)) ?? false)
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

    try {
      fileDescriptor = fileSystem.openSync(temporaryPath, "wx", PRIVATE_RUNTIME_FILE_MODE);
      fileSystem.writeFileSync(fileDescriptor, JSON.stringify(state, null, 2), "utf8");
      fileSystem.fsyncSync(fileDescriptor);
      fileSystem.closeSync(fileDescriptor);
      fileDescriptor = undefined;
      fileSystem.renameSync(temporaryPath, filePath);

      if (platform !== "win32") {
        directoryDescriptor = fileSystem.openSync(directory, "r");
        fileSystem.fsyncSync(directoryDescriptor);
        fileSystem.closeSync(directoryDescriptor);
        directoryDescriptor = undefined;
      }
    } catch (error) {
      if (fileDescriptor !== undefined) {
        fileSystem.closeSync(fileDescriptor);
      }

      if (directoryDescriptor !== undefined) {
        fileSystem.closeSync(directoryDescriptor);
      }

      if (fileSystem.existsSync(temporaryPath)) {
        fileSystem.unlinkSync(temporaryPath);
      }

      throw error;
    }

    return filePath;
  };
};

const writePersistedStateToDisk = createPersistedStateWriter();

export const writePersistedState = (state: PersistedStoreState) => {
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
