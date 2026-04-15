import { Injectable } from "@nestjs/common";

import {
  cloneSeedState,
  type BatchConsumptionTrace,
  type AlertTask,
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
  type RegionRecord,
  type RegistrationApplication,
  type SpecialAccessPolicy,
  type StocktakeRecord,
  type UserRecord,
  type UserRole,
  type WarehouseRecord
} from "@vm/shared-types";

import { formatOperationLog } from "../logging/operation-log-template";
import { createSeededPersistedState, readPersistedState, type DraftSessionRecord, type PersistedStoreState, type SessionRecord, type VerificationRecord, writePersistedState } from "./persistence";

interface BatchConsumptionEntry {
  batchId: string;
  quantity: number;
}

const MAX_CALLBACK_LOGS = 1000;

type OperationLogDraft = Omit<OperationLogRecord, "id" | "occurredAt" | "description" | "detail"> &
  Partial<Pick<OperationLogRecord, "id" | "occurredAt" | "description" | "detail">>;

@Injectable()
export class InMemoryStoreService {
  private readonly seed = cloneSeedState();

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
  readonly alerts: AlertTask[] = this.seed.alerts;
  readonly logs: OperationLogRecord[] = this.seed.logs.map((entry) => ({
    ...entry,
    ...formatOperationLog(entry)
  }));

  readonly verificationCodes = new Map<string, VerificationRecord>();
  readonly sessions = new Map<string, SessionRecord>();
  readonly draftSessions = new Map<string, DraftSessionRecord>();
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

    if (persisted) {
      this.hydrate(persisted);
    } else {
      this.persist();
    }

    this.ensureCompetitionTestDevice();
    this.syncDeviceStocksFromBatches();
  }

  createId(prefix: string) {
    return `${this.normalizePrefix(prefix)}-${this.createCompactSuffix()}`;
  }

  createReference(prefix: string) {
    return `${this.normalizePrefix(prefix)}-${this.createCompactSuffix(4)}`;
  }

  issueVerificationCode(phone: string) {
    const code = "123456";
    const expiresAt = new Date(Date.now() + 5 * 60_000).toISOString();
    this.verificationCodes.set(phone, {
      code,
      expiresAt
    });
    return code;
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

  getDraftSession(token?: string) {
    if (!token) {
      return undefined;
    }

    return this.draftSessions.get(token);
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

    this.syncDeviceStocksFromBatches(deviceCode);

    return {
      actualQuantity: quantity - remaining,
      consumed,
      shortage: remaining
    };
  }

  restoreGoodsBatchConsumption(deviceCode: string, consumed: BatchConsumptionEntry[]) {
    for (const item of consumed) {
      const batch = this.goodsBatches.find((entry) => entry.batchId === item.batchId);

      if (batch) {
        batch.remainingQuantity = Math.min(batch.quantity, batch.remainingQuantity + item.quantity);
      }
    }

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

  logOperation(entry: OperationLogDraft) {
    const occurredAt = entry.occurredAt ?? new Date().toISOString();
    const id = entry.id ?? this.createId("log");
    const record: OperationLogRecord = {
      id,
      occurredAt,
      ...entry,
      ...formatOperationLog({
        ...entry,
        id,
        occurredAt
      } as OperationLogRecord)
    };

    record.metadata = {
      undoState: "not_undoable",
      ...(record.metadata ?? {})
    };

    this.logs.unshift(record);
    return record;
  }

  snapshot(): PersistedStoreState {
    return {
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
      alerts: structuredClone(this.alerts),
      logs: structuredClone(this.logs),
      verificationCodes: Array.from(this.verificationCodes.entries()).map(([key, value]) => [key, structuredClone(value)]),
      sessions: Array.from(this.sessions.entries()).map(([key, value]) => [key, structuredClone(value)]),
      draftSessions: Array.from(this.draftSessions.entries()).map(([key, value]) => [key, structuredClone(value)]),
      callbackLog: structuredClone(this.callbackLog),
      deviceRuntime: Array.from(this.deviceRuntime.entries()).map(([key, value]) => [key, structuredClone(value)])
    };
  }

  persist() {
    writePersistedState(this.snapshot());
  }

  resetToSeed() {
    this.hydrate(createSeededPersistedState());
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
    this.replaceArray(this.alerts, state.alerts);
    this.replaceArray(
      this.logs,
      state.logs.map((entry) => ({
        ...entry,
        ...formatOperationLog(entry)
      }))
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

    this.replaceArray(this.callbackLog, state.callbackLog);
    this.deviceRuntime.clear();
    for (const [key, value] of state.deviceRuntime) {
      this.deviceRuntime.set(key, value);
    }
  }

  private replaceArray<T>(target: T[], source: T[]) {
    target.splice(0, target.length, ...structuredClone(source));
  }
}
