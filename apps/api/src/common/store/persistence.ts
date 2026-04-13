import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, isAbsolute, resolve } from "node:path";

import { cloneSeedState, type AlertTask, type BatchConsumptionTrace, type CabinetAccessRule, type CabinetEventRecord, type CallbackLogRecord, type DeviceGoodsSetting, type DeviceRecord, type DeviceRuntimeState, type GoodsAlertPolicy, type GoodsBatchRecord, type GoodsCatalogItem, type GoodsCategoryRecord, type InventoryMovement, type InventoryTransferRecord, type MerchantGoodsTemplate, type OperationLogRecord, type RegionRecord, type RegistrationApplication, type SpecialAccessPolicy, type StocktakeRecord, type SystemAuditLogEntry, type UserRecord, type UserRole, type WarehouseRecord } from "@vm/shared-types";

export interface VerificationRecord {
  code: string;
  expiresAt: string;
}

export interface SessionRecord {
  token: string;
  userId: string;
  role: UserRole;
  createdAt: string;
}

export interface DraftSessionRecord {
  token: string;
  phone: string;
  requestedRole?: UserRole;
  linkedUserId?: string;
  applicationId?: string;
  createdAt: string;
}

export interface PersistedStoreState {
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
  events: CabinetEventRecord[];
  inventory: InventoryMovement[];
  alerts: AlertTask[];
  logs: OperationLogRecord[];
  verificationCodes: Array<[string, VerificationRecord]>;
  sessions: Array<[string, SessionRecord]>;
  draftSessions: Array<[string, DraftSessionRecord]>;
  callbackLog: CallbackLogRecord[];
  deviceRuntime: Array<[string, DeviceRuntimeState]>;
}

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

const loadApiEnvFile = () => {
  const processWithEnvLoader = process as typeof process & {
    loadEnvFile?: (path?: string) => void;
  };

  const envPaths = [
    ".env.local",
    ".env",
    ".env.example",
    "apps/api/.env.local",
    "apps/api/.env",
    "apps/api/.env.example"
  ];

  for (const envPath of envPaths) {
    try {
      processWithEnvLoader.loadEnvFile?.(envPath);
    } catch {
      // 当前环境没有配置某个 env 文件时直接跳过。
    }
  }
};

const resolveApiWorkspacePath = (configuredPath: string, fallbackRelativePath: string) => {
  loadApiEnvFile();
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
  const configuredPath = process.env.API_DATA_FILE ?? "runtime-data/store.json";
  return resolveApiWorkspacePath(configuredPath, "runtime-data/store.json");
};

export const resolveUploadDir = () => {
  const configuredPath = process.env.UPLOAD_DIR ?? "runtime-uploads";
  return resolveApiWorkspacePath(configuredPath, "runtime-uploads");
};

export const resolveSystemLogFile = () => {
  const configuredPath = process.env.SYSTEM_LOG_FILE ?? "runtime-data/system-audit.ndjson";
  return resolveApiWorkspacePath(configuredPath, "runtime-data/system-audit.ndjson");
};

export const createSeededPersistedState = (): PersistedStoreState => {
  const seed = cloneSeedState();

  return {
    ...seed,
    verificationCodes: [],
    sessions: [],
    draftSessions: [],
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

const normalizePersistedState = (raw: Partial<PersistedStoreState>): PersistedStoreState => {
  const seeded = createSeededPersistedState();

  return {
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
    events: raw.events ?? seeded.events,
    inventory: raw.inventory ?? seeded.inventory,
    alerts: raw.alerts ?? seeded.alerts,
    logs: raw.logs ?? seeded.logs,
    verificationCodes: raw.verificationCodes ?? seeded.verificationCodes,
    sessions: raw.sessions ?? seeded.sessions,
    draftSessions: raw.draftSessions ?? seeded.draftSessions,
    callbackLog: raw.callbackLog ?? seeded.callbackLog,
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
  const filePath = resolveApiDataFile();
  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(filePath, JSON.stringify(state, null, 2), "utf8");
  return filePath;
};

export const appendSystemAuditLog = (entry: SystemAuditLogEntry) => {
  const filePath = resolveSystemLogFile();
  mkdirSync(dirname(filePath), { recursive: true });
  appendFileSync(filePath, `${JSON.stringify(entry)}\n`, "utf8");
  return filePath;
};
