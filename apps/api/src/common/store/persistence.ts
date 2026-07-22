import {
  appendFileSync,
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync
} from "node:fs";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { dirname, isAbsolute, resolve } from "node:path";

import { cloneSeedState, type AlertTask, type BackofficePermission, type BackofficeRole, type BatchConsumptionTrace, type CabinetAccessRule, type CabinetEventRecord, type CabinetReservationRecord, type CallbackLogRecord, type DeviceGoodsSetting, type DeviceRecord, type DeviceRuntimeState, type ExpiredBatchDispositionRecord, type GoodsAlertPolicy, type GoodsBatchRecord, type GoodsCatalogItem, type GoodsCategoryRecord, type InventoryMovement, type InventoryTransferRecord, type MerchantGoodsTemplate, type OperationLogRecord, type PaymentOrderRecord, type PaymentRefundRecord, type RegionRecord, type RegistrationApplication, type ReservationSettings, type SpecialAccessPolicy, type StocktakeRecord, type SystemAuditLogEntry, type UserRecord, type UserRole, type WarehouseRecord } from "@vm/shared-types";

import { sanitizeAuditLogEntry } from "../logging/audit-log-sanitizer";
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

const MAX_PERSISTED_CALLBACK_LOGS = 1000;
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
    logs: raw.logs ?? seeded.logs,
    verificationCodes: raw.verificationCodes ?? seeded.verificationCodes,
    sessions: raw.sessions ?? seeded.sessions,
    draftSessions: raw.draftSessions ?? seeded.draftSessions,
    adminCredentials: raw.adminCredentials ?? seeded.adminCredentials,
    backofficeCredentials: raw.backofficeCredentials ?? seeded.backofficeCredentials,
    callbackLog: (raw.callbackLog ?? seeded.callbackLog).slice(0, MAX_PERSISTED_CALLBACK_LOGS),
    deviceRuntime: raw.deviceRuntime ?? seeded.deviceRuntime
  };
};

export const readPersistedState = () => {
  const filePath = resolveApiDataFile();

  if (!existsSync(filePath)) {
    return undefined;
  }

  const raw = JSON.parse(readFileSync(filePath, "utf8")) as Partial<PersistedStoreState>;
  return normalizePersistedState(raw);
};

export const writePersistedState = (state: PersistedStoreState) => {
  return runWithFinancialWriterFence(() => {
    const filePath = resolveApiDataFile();
    mkdirSync(dirname(filePath), { recursive: true });
    const temporaryPath = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
    let fileDescriptor: number | undefined;

    try {
      fileDescriptor = openSync(temporaryPath, "wx");
      writeFileSync(fileDescriptor, JSON.stringify(state, null, 2), "utf8");
      fsyncSync(fileDescriptor);
      closeSync(fileDescriptor);
      fileDescriptor = undefined;
      renameSync(temporaryPath, filePath);
    } catch (error) {
      if (fileDescriptor !== undefined) {
        closeSync(fileDescriptor);
      }

      if (existsSync(temporaryPath)) {
        unlinkSync(temporaryPath);
      }

      throw error;
    }

    return filePath;
  });
};

export const appendSystemAuditLog = (entry: SystemAuditLogEntry) => {
  const filePath = resolveSystemLogFile();
  mkdirSync(dirname(filePath), { recursive: true });
  appendFileSync(filePath, `${JSON.stringify(sanitizeAuditLogEntry(entry))}\n`, "utf8");
  return filePath;
};
