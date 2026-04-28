import { Injectable } from "@nestjs/common";

import {
  cloneSeedState,
  type BatchConsumptionTrace,
  type AlertTask,
  type BackofficeRole,
  type CabinetAccessRule,
  type CabinetEventRecord,
  type CallbackLogRecord,
  type DeviceGoods,
  type DeviceGoodsSetting,
  type DeviceRuntimeState,
  type DeviceRecord,
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
  type RegionRecord,
  type RegistrationApplication,
  type SpecialAccessPolicy,
  type StocktakeRecord,
  type UserRecord,
  type UserRole,
  type WarehouseRecord
} from "@vm/shared-types";

import { hashAdminPassword } from "../../modules/auth/admin-password.utils";
import { formatOperationLog } from "../logging/operation-log-template";
import {
  createSeededPersistedState,
  readPersistedState,
  type AdminCredentialRecord,
  type BackofficeCredentialRecord,
  type DraftSessionRecord,
  type PersistedStoreState,
  type SessionRecord,
  type VerificationRecord,
  writePersistedState
} from "./persistence";

interface BatchConsumptionEntry {
  batchId: string;
  quantity: number;
}

const MAX_CALLBACK_LOGS = 1000;
const NEGATIVE_STOCK_BALANCE_NOTE = "库存透支调整";
const DEFAULT_SUPER_ADMIN_USERNAME = "admin";
const DEFAULT_SUPER_ADMIN_PASSWORD = "admin";
const DEFAULT_SUPER_ADMIN_PHONE = "13800000001";
const DEFAULT_SUPER_ADMIN_NAME = "超级管理员";
const DEFAULT_SUPER_ADMIN_REGION_NAME = "系统管理";

type OperationLogDraft = Omit<OperationLogRecord, "id" | "occurredAt" | "description" | "detail"> &
  Partial<Pick<OperationLogRecord, "id" | "occurredAt" | "description" | "detail">>;

@Injectable()
export class InMemoryStoreService {
  private readonly seed = cloneSeedState();
  private persistenceFlags: PersistedStoreState["flags"];

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
  readonly events: CabinetEventRecord[] = this.seed.events;
  readonly inventory: InventoryMovement[] = this.seed.inventory;
  readonly paymentOrders: PaymentOrderRecord[] = [];
  readonly paymentRefunds: PaymentRefundRecord[] = [];
  readonly alerts: AlertTask[] = this.seed.alerts;
  readonly logs: OperationLogRecord[] = this.seed.logs.map((entry) => this.decorateStoredLog(entry));

  readonly verificationCodes = new Map<string, VerificationRecord>();
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
    const persisted = readPersistedState();
    this.persistenceFlags = persisted?.flags;
    let shouldPersist = false;

    if (persisted) {
      this.hydrate(persisted);
    } else {
      this.persist();
    }

    shouldPersist = this.normalizeRegionsState() || shouldPersist;
    shouldPersist = this.ensureBootstrapAdmin() || shouldPersist;

    if (!persisted?.flags?.skipCompetitionTestDevice) {
      this.ensureCompetitionTestDevice();
    }
    this.syncDeviceStocksFromBatches();
    this.refreshAlertPresentation();

    if (shouldPersist) {
      this.persist();
    }
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

  issueVerificationCode(phone: string) {
    const code = "123456";
    const now = Date.now();
    const expiresAt = new Date(now + 5 * 60_000).toISOString();
    const requestedAt = new Date(now).toISOString();
    const resendAvailableAt = new Date(now + 60_000).toISOString();
    this.verificationCodes.set(phone, {
      code,
      expiresAt,
      requestedAt,
      resendAvailableAt
    });
    return code;
  }

  rememberVerificationRequest(phone: string) {
    const now = Date.now();
    const existing = this.verificationCodes.get(phone);

    this.verificationCodes.set(phone, {
      code: existing?.code ?? "",
      expiresAt: existing?.expiresAt ?? new Date(now + 5 * 60_000).toISOString(),
      requestedAt: new Date(now).toISOString(),
      resendAvailableAt: new Date(now + 60_000).toISOString()
    });
  }

  verifyCode(phone: string, code: string) {
    const record = this.verificationCodes.get(phone);

    if (!record) {
      return false;
    }

    return record.code === code && new Date(record.expiresAt).getTime() > Date.now();
  }

  createSession(user: UserRecord) {
    const token = this.createId("session");
    this.sessions.set(token, {
      token,
      userId: user.id,
      role: user.role,
      createdAt: new Date().toISOString()
    });
    return token;
  }

  createBackofficeSession(user: UserRecord, backofficeRole: BackofficeRole) {
    const token = this.createId("session");
    this.sessions.set(token, {
      token,
      userId: user.id,
      role: user.role,
      backofficeRole,
      createdAt: new Date().toISOString()
    });
    return token;
  }

  createDraftSession(payload: {
    phone: string;
    requestedRole?: UserRole;
    linkedUserId?: string;
    applicationId?: string;
  }) {
    const token = this.createId("draft");
    this.draftSessions.set(token, {
      token,
      phone: payload.phone,
      requestedRole: payload.requestedRole,
      linkedUserId: payload.linkedUserId,
      applicationId: payload.applicationId,
      createdAt: new Date().toISOString()
    });
    return token;
  }

  getSession(token?: string) {
    if (!token) {
      return undefined;
    }

    return this.sessions.get(token);
  }

  getSessionUser(token?: string) {
    const session = this.getSession(token);

    if (!session) {
      return undefined;
    }

    return this.users.find((entry) => entry.id === session.userId);
  }

  getBackofficeSessionUser(token?: string) {
    const session = this.getSession(token);

    if (!session?.backofficeRole) {
      return undefined;
    }

    const user = this.users.find((entry) => entry.id === session.userId);

    if (!user) {
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

    return this.draftSessions.get(token);
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
      return existing;
    }

    this.adminCredentials.unshift(record);
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

      return this.users.some((user) => this.isUserValidForBackofficeRole(user, entry.role));
    });
  }

  findBackofficeCredentialByUserId(userId: string, role?: BackofficeRole) {
    return this.backofficeCredentials.find(
      (entry) => entry.userId === userId && (!role || entry.role === role)
    );
  }

  upsertBackofficeCredential(record: BackofficeCredentialRecord) {
    const existing = this.findBackofficeCredentialByUserId(record.userId, record.role);

    if (existing) {
      Object.assign(existing, record);
      return existing;
    }

    this.backofficeCredentials.unshift(record);
    return record;
  }

  isUserValidForBackofficeRole(user: UserRecord, role: BackofficeRole) {
    if (user.status !== "active") {
      return false;
    }

    if (role === "super_admin") {
      return user.role === "admin";
    }

    return user.role === "merchant";
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
    this.callbackLog.unshift({
      id: this.createId("callback"),
      type,
      receivedAt: new Date().toISOString(),
      payload
    });

    if (this.callbackLog.length > MAX_CALLBACK_LOGS) {
      this.callbackLog.splice(MAX_CALLBACK_LOGS);
    }
  }

  private ensureCompetitionTestDevice() {
    const competitionDeviceCode = "91120149";

    if (this.devices.some((entry) => entry.deviceCode === competitionDeviceCode)) {
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

  private normalizePrefix(prefix: string) {
    const normalized = prefix.replace(/[^a-zA-Z0-9]/g, "").slice(0, 12);
    return normalized || "id";
  }

  private createCompactSuffix(randomLength = 5) {
    const timePart = Date.now().toString(36);
    const randomPart = Math.random().toString(36).slice(2, 2 + randomLength);
    return `${timePart}${randomPart}`;
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
      .sort((left, right) => left.localeCompare(right))
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
        return;
      }

      user.merchantProfile.defaultDeviceCodes = user.merchantProfile.defaultDeviceCodes.filter(
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

  consumeGoodsBatches(deviceCode: string, goodsId: string, quantity: number) {
    let remaining = Math.max(0, quantity);
    const consumed: BatchConsumptionEntry[] = [];

    const ordered = this.getGoodsBatches(deviceCode, goodsId)
      .filter((entry) => entry.remainingQuantity > 0)
      .sort((left, right) => {
        const leftExpiry = left.expiresAt ?? "9999-12-31T23:59:59.999Z";
        const rightExpiry = right.expiresAt ?? "9999-12-31T23:59:59.999Z";

        if (leftExpiry !== rightExpiry) {
          return leftExpiry.localeCompare(rightExpiry);
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
      consumed.push({
        batchId: batch.batchId,
        quantity: used
      });
    }

    if (remaining > 0) {
      const negativeBalanceBatch = this.recordNegativeStockBalance(deviceCode, goodsId, remaining);
      consumed.push({
        batchId: negativeBalanceBatch.batchId,
        quantity: remaining
      });
      remaining = 0;
    }

    this.syncDeviceStocksFromBatches(deviceCode);

    return {
      actualQuantity: quantity,
      consumed,
      shortage: remaining
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
    return {
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
      events: structuredClone(this.events),
      inventory: structuredClone(this.inventory),
      paymentOrders: structuredClone(this.paymentOrders),
      paymentRefunds: structuredClone(this.paymentRefunds),
      alerts: structuredClone(this.alerts),
      logs: structuredClone(this.logs),
      verificationCodes: Array.from(this.verificationCodes.entries()).map(([key, value]) => [key, structuredClone(value)]),
      sessions: Array.from(this.sessions.entries()).map(([key, value]) => [key, structuredClone(value)]),
      draftSessions: Array.from(this.draftSessions.entries()).map(([key, value]) => [key, structuredClone(value)]),
      adminCredentials: structuredClone(this.adminCredentials),
      backofficeCredentials: structuredClone(this.backofficeCredentials),
      callbackLog: structuredClone(this.callbackLog),
      deviceRuntime: Array.from(this.deviceRuntime.entries()).map(([key, value]) => [key, structuredClone(value)])
    };
  }

  persist() {
    writePersistedState(this.snapshot());
  }

  resetToSeed() {
    this.persistenceFlags = undefined;
    this.hydrate(createSeededPersistedState());
    this.ensureBootstrapAdmin();
    this.persist();
  }

  private hydrate(state: PersistedStoreState) {
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
    this.replaceArray(this.events, state.events);
    this.replaceArray(this.inventory, state.inventory);
    this.replaceArray(this.paymentOrders, state.paymentOrders);
    this.replaceArray(this.paymentRefunds, state.paymentRefunds);
    this.replaceArray(this.alerts, state.alerts);
    this.replaceArray(
      this.logs,
      state.logs.map((entry) => this.decorateStoredLog(entry))
    );

    this.verificationCodes.clear();
    for (const [key, value] of state.verificationCodes) {
      this.verificationCodes.set(key, value);
    }

    this.sessions.clear();
    for (const [key, value] of state.sessions) {
      this.sessions.set(key, value);
    }

    this.draftSessions.clear();
    for (const [key, value] of state.draftSessions) {
      this.draftSessions.set(key, value);
    }

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
    let changed = false;
    let adminUser = this.users.find((entry) => entry.role === "admin" && entry.status === "active");

    if (!adminUser) {
      adminUser = {
        id: "admin-root",
        role: "admin",
        phone: DEFAULT_SUPER_ADMIN_PHONE,
        name: DEFAULT_SUPER_ADMIN_NAME,
        status: "active",
        regionName: DEFAULT_SUPER_ADMIN_REGION_NAME,
        neighborhood: DEFAULT_SUPER_ADMIN_REGION_NAME,
        tags: ["super-admin"],
        mobileProfileCompleted: false
      };
      this.users.unshift(adminUser);
      changed = true;
    }

    if (!this.findAdminCredentialByUserId(adminUser.id)) {
      const hashedPassword = hashAdminPassword(DEFAULT_SUPER_ADMIN_PASSWORD);

      this.adminCredentials.unshift({
        userId: adminUser.id,
        username: DEFAULT_SUPER_ADMIN_USERNAME,
        passwordSalt: hashedPassword.salt,
        passwordHash: hashedPassword.hash,
        usesDefaultPassword: true,
        passwordUpdatedAt: new Date().toISOString()
      });
      changed = true;
    }

    if (!this.findBackofficeCredentialByUserId(adminUser.id, "super_admin")) {
      const existingAdminCredential = this.findAdminCredentialByUserId(adminUser.id);
      const hashedPassword = existingAdminCredential
        ? {
            salt: existingAdminCredential.passwordSalt,
            hash: existingAdminCredential.passwordHash
          }
        : hashAdminPassword(DEFAULT_SUPER_ADMIN_PASSWORD);

      this.backofficeCredentials.unshift({
        userId: adminUser.id,
        username: DEFAULT_SUPER_ADMIN_USERNAME,
        role: "super_admin",
        passwordSalt: hashedPassword.salt,
        passwordHash: hashedPassword.hash,
        usesDefaultPassword: true,
        passwordUpdatedAt: new Date().toISOString()
      });
      changed = true;
    }

    return changed;
  }
}
