import { Injectable } from "@nestjs/common";

import {
  cloneSeedState,
  type AlertTask,
  type CabinetAccessRule,
  type CabinetEventRecord,
  type DeviceRecord,
  type InventoryMovement,
  type UserRecord,
  type UserRole
} from "@vm/shared-types";

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

@Injectable()
export class InMemoryStoreService {
  private readonly seed = cloneSeedState();

  readonly users: UserRecord[] = this.seed.users;
  readonly rules: CabinetAccessRule[] = this.seed.rules;
  readonly devices: DeviceRecord[] = this.seed.devices;
  readonly events: CabinetEventRecord[] = this.seed.events;
  readonly inventory: InventoryMovement[] = this.seed.inventory;
  readonly alerts: AlertTask[] = this.seed.alerts;

  readonly verificationCodes = new Map<string, VerificationRecord>();
  readonly sessions = new Map<string, SessionRecord>();
  readonly callbackLog: CallbackLog[] = [];

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

  logCallback(type: string, payload: unknown) {
    this.callbackLog.unshift({
      id: this.createId("callback"),
      type,
      receivedAt: new Date().toISOString(),
      payload
    });
  }
}
