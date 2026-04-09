import { Injectable } from "@nestjs/common";

import {
  cloneSeedState,
  type AlertTask,
  type CabinetAccessRule,
  type CabinetEventRecord,
  type DeviceRuntimeState,
  type DeviceRecord,
  type GoodsAlertPolicy,
  type GoodsCatalogItem,
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

  logOperation(entry: OperationLogDraft) {
    const record: OperationLogRecord = {
      id: entry.id ?? this.createId("log"),
      occurredAt: entry.occurredAt ?? new Date().toISOString(),
      ...entry,
      ...formatOperationLog({
        ...entry,
        id: entry.id ?? this.createId("log"),
        occurredAt: entry.occurredAt ?? new Date().toISOString()
      } as OperationLogRecord)
    };

    this.logs.unshift(record);
    return record;
  }
}
