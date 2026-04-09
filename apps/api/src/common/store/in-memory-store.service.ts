import { Injectable } from "@nestjs/common";

import {
  cloneSeedState,
  type AlertTask,
  type CabinetAccessRule,
  type CabinetEventRecord,
  type DeviceGoods,
  type DeviceGoodsSetting,
  type DeviceRuntimeState,
  type DeviceRecord,
  type GoodsBatchSource,
  type GoodsAlertPolicy,
  type GoodsBatchRecord,
  type GoodsCatalogItem,
  type GoodsCategory,
  type InventoryMovement,
  type OperationLogRecord,
  type SpecialAccessPolicy,
  type UserRecord,
  type UserRole
} from "@vm/shared-types";

import { formatOperationLog } from "../logging/operation-log-template";

interface VerificationRecord {
  code: string;
  expiresAt: string;
}

interface SessionRecord {
  token: string;
  userId: string;
  role: UserRole;
  createdAt: string;
}

interface CallbackLog {
  id: string;
  type: string;
  receivedAt: string;
  payload: unknown;
}

interface BatchConsumptionEntry {
  batchId: string;
  quantity: number;
}

type OperationLogDraft = Omit<OperationLogRecord, "id" | "occurredAt" | "description" | "detail"> &
  Partial<Pick<OperationLogRecord, "id" | "occurredAt" | "description" | "detail">>;

@Injectable()
export class InMemoryStoreService {
  private readonly seed = cloneSeedState();

  readonly users: UserRecord[] = this.seed.users;
  readonly rules: CabinetAccessRule[] = this.seed.rules;
  readonly devices: DeviceRecord[] = this.seed.devices;
  readonly goodsCatalog: GoodsCatalogItem[] = this.seed.goodsCatalog;
  readonly specialAccessPolicies: SpecialAccessPolicy[] = this.seed.specialAccessPolicies;
  readonly goodsAlertPolicies: GoodsAlertPolicy[] = this.seed.goodsAlertPolicies;
  readonly deviceGoodsSettings: DeviceGoodsSetting[] = this.seed.deviceGoodsSettings;
  readonly goodsBatches: GoodsBatchRecord[] = this.seed.goodsBatches;
  readonly events: CabinetEventRecord[] = this.seed.events;
  readonly inventory: InventoryMovement[] = this.seed.inventory;
  readonly alerts: AlertTask[] = this.seed.alerts;
  readonly logs: OperationLogRecord[] = this.seed.logs.map((entry) => ({
    ...entry,
    ...formatOperationLog(entry)
  }));

  readonly verificationCodes = new Map<string, VerificationRecord>();
  readonly sessions = new Map<string, SessionRecord>();
  readonly callbackLog: CallbackLog[] = [];
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
    this.syncDeviceStocksFromBatches();
  }

  createId(prefix: string) {
    return `${prefix}-${Date.now()}-${Math.floor(Math.random() * 10_000)}`;
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

  logCallback(type: string, payload: unknown) {
    this.callbackLog.unshift({
      id: this.createId("callback"),
      type,
      receivedAt: new Date().toISOString(),
      payload
    });
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
        updatedAt: new Date().toISOString()
      });
      return existing;
    }

    const created: GoodsCatalogItem = {
      ...item,
      status: item.status ?? "active",
      createdAt: item.createdAt ?? new Date().toISOString(),
      updatedAt: item.updatedAt ?? new Date().toISOString()
    };
    this.goodsCatalog.unshift(created);
    return created;
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
    const batch: GoodsBatchRecord = {
      batchId: payload.batchId ?? this.createId("batch"),
      goodsId: payload.goodsId,
      deviceCode: payload.deviceCode,
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
}
