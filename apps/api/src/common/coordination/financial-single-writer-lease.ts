import { randomUUID } from "node:crypto";
import {
  closeSync,
  existsSync,
  ftruncateSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
  writeSync
} from "node:fs";
import { hostname as readHostname } from "node:os";
import { dirname } from "node:path";

export interface FinancialWriterLeaseSnapshot {
  version: 2;
  ownerId: string;
  fencingToken: string;
  pid: number;
  hostname: string;
  acquiredAt: string;
  heartbeatAt: string;
  expiresAt: string;
}

interface LegacyFinancialWriterLeaseSnapshot {
  version: 1;
  ownerId: string;
  pid: number;
  hostname: string;
  acquiredAt: string;
  heartbeatAt: string;
  expiresAt: string;
}

type StoredFinancialWriterLeaseSnapshot =
  | FinancialWriterLeaseSnapshot
  | LegacyFinancialWriterLeaseSnapshot;

interface LeaseFileRecord {
  serialized: string;
  snapshot: StoredFinancialWriterLeaseSnapshot;
}

interface LifecycleGuardSnapshot {
  version: 1;
  ownerId: string;
  token: string;
  pid: number;
  hostname: string;
  createdAt: string;
}

export interface FinancialSingleWriterLeaseOptions {
  lockFile: string;
  ownerId?: string;
  leaseDurationMs?: number;
  heartbeatIntervalMs?: number;
  autoHeartbeat?: boolean;
  now?: () => Date;
  hostname?: string;
  pid?: number;
  isProcessAlive?: (pid: number) => boolean;
}

const DEFAULT_LEASE_DURATION_MS = 30_000;
const MINIMUM_LEASE_DURATION_MS = 1_000;

export class FinancialSingleWriterLease {
  private readonly lockFile: string;
  private readonly lifecycleGuardFile: string;
  private readonly ownerId: string;
  private readonly leaseDurationMs: number;
  private readonly heartbeatIntervalMs: number;
  private readonly autoHeartbeat: boolean;
  private readonly now: () => Date;
  private readonly hostname: string;
  private readonly pid: number;
  private readonly isProcessAlive: (pid: number) => boolean;
  private heartbeatTimer?: ReturnType<typeof setInterval>;
  private snapshot?: FinancialWriterLeaseSnapshot;
  private lostReason?: string;

  constructor(options: FinancialSingleWriterLeaseOptions) {
    if (!options.lockFile?.trim()) {
      throw new Error("金融单写者租约文件路径不能为空。");
    }

    this.lockFile = options.lockFile;
    this.lifecycleGuardFile = `${options.lockFile}.lifecycle`;
    this.ownerId = options.ownerId?.trim() || randomUUID();
    this.leaseDurationMs = Math.max(
      MINIMUM_LEASE_DURATION_MS,
      options.leaseDurationMs ?? DEFAULT_LEASE_DURATION_MS
    );
    this.heartbeatIntervalMs = Math.max(
      250,
      Math.min(
        options.heartbeatIntervalMs ?? Math.floor(this.leaseDurationMs / 3),
        Math.floor(this.leaseDurationMs / 2)
      )
    );
    this.autoHeartbeat = options.autoHeartbeat ?? true;
    this.now = options.now ?? (() => new Date());
    this.hostname = options.hostname?.trim() || readHostname();
    this.pid = options.pid ?? process.pid;
    this.isProcessAlive = options.isProcessAlive ?? this.defaultIsProcessAlive;
  }

  acquire(): FinancialWriterLeaseSnapshot {
    if (this.snapshot && !this.lostReason) {
      return structuredClone(this.snapshot);
    }

    mkdirSync(dirname(this.lockFile), { recursive: true });

    if (existsSync(this.lockFile)) {
      const existing = this.readExistingLeaseRecord().snapshot;
      if (this.isActive(existing, this.now())) {
        throw this.createExistingOwnerError(existing);
      }
    }

    return this.withLifecycleGuard(() => {
      if (existsSync(this.lockFile)) {
        const existing = this.readExistingLeaseRecord();
        const now = this.now();

        if (this.isActive(existing.snapshot, now)) {
          throw this.createExistingOwnerError(existing.snapshot);
        }

        const quarantinePath =
          `${this.lockFile}.stale.${now.toISOString().replace(/[:.]/g, "-")}.${randomUUID()}`;
        renameSync(this.lockFile, quarantinePath);
      }

      const acquired = this.createLeaseFile();
      this.snapshot = acquired;
      this.lostReason = undefined;
      this.startHeartbeat();
      return structuredClone(acquired);
    });
  }

  heartbeat(): FinancialWriterLeaseSnapshot {
    try {
      return this.withLifecycleGuard(() => {
        const existing = this.assertCurrentLeaseUnderGuard();
        const now = this.now();
        const next = this.createSnapshot(
          now,
          existing.acquiredAt,
          existing.fencingToken
        );
        let descriptor: number | undefined;

        try {
          descriptor = openSync(this.lockFile, "r+");
          const serialized = JSON.stringify(next, null, 2);
          ftruncateSync(descriptor, 0);
          writeSync(descriptor, serialized, 0, "utf8");
          fsyncSync(descriptor);
          closeSync(descriptor);
          descriptor = undefined;
        } finally {
          if (descriptor !== undefined) {
            closeSync(descriptor);
          }
        }

        const persisted = this.readExistingLeaseRecord().snapshot;
        if (
          persisted.version !== 2 ||
          persisted.ownerId !== this.ownerId ||
          persisted.fencingToken !== next.fencingToken ||
          persisted.heartbeatAt !== next.heartbeatAt
        ) {
          throw new Error(
            "金融单写者租约在心跳期间被替换，当前实例必须停止金融操作。"
          );
        }

        this.snapshot = next;
        return structuredClone(next);
      });
    } catch (error) {
      if (!this.lostReason) {
        this.markLost(
          error instanceof Error
            ? error.message
            : "金融单写者租约心跳失败，当前实例必须停止金融操作。"
        );
      }
      throw error;
    }
  }

  runWithFence<T>(operation: () => T): T {
    if (!this.snapshot || this.lostReason) {
      throw new Error(this.lostReason ?? "当前实例未持有金融单写者租约。");
    }

    try {
      return this.withLifecycleGuard(() => {
        this.assertCurrentLeaseUnderGuard();
        return operation();
      });
    } catch (error) {
      if (!this.lostReason) {
        this.markLost(
          error instanceof Error
            ? error.message
            : "金融单写者 fencing token 核验失败，当前实例必须停止金融操作。"
        );
      }
      throw error;
    }
  }

  release() {
    this.stopHeartbeat();

    const releasingSnapshot = this.snapshot;
    if (releasingSnapshot) {
      try {
        this.withLifecycleGuard(() => {
          if (!existsSync(this.lockFile)) {
            return;
          }

          const existing = this.readExistingLeaseRecord().snapshot;
          if (this.isSameAcquisition(existing, releasingSnapshot)) {
            unlinkSync(this.lockFile);
          }
        });
      } catch {
        // 无法在生命周期互斥区证明路径仍属于本实例时绝不删除，避免删掉继任者的新租约。
      }
    }

    this.snapshot = undefined;
    this.lostReason = undefined;
  }

  isHeld() {
    return Boolean(this.snapshot) && !this.lostReason;
  }

  assertHeld() {
    this.runWithFence(() => undefined);
  }

  getSnapshot() {
    return this.snapshot ? structuredClone(this.snapshot) : undefined;
  }

  getFencingToken() {
    return this.snapshot?.fencingToken;
  }

  private createLeaseFile() {
    const now = this.now();
    const snapshot = this.createSnapshot(now);
    let descriptor: number | undefined;

    try {
      descriptor = openSync(this.lockFile, "wx", 0o600);
      writeFileSync(descriptor, JSON.stringify(snapshot, null, 2), "utf8");
      fsyncSync(descriptor);
      closeSync(descriptor);
      descriptor = undefined;
      return snapshot;
    } catch (error) {
      if (descriptor !== undefined) {
        closeSync(descriptor);
      }
      throw error;
    }
  }

  private createSnapshot(
    now: Date,
    acquiredAt = now.toISOString(),
    fencingToken: string = randomUUID()
  ): FinancialWriterLeaseSnapshot {
    return {
      version: 2,
      ownerId: this.ownerId,
      fencingToken,
      pid: this.pid,
      hostname: this.hostname,
      acquiredAt,
      heartbeatAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + this.leaseDurationMs).toISOString()
    };
  }

  private assertCurrentLeaseUnderGuard() {
    if (!this.snapshot || this.lostReason) {
      throw new Error(this.lostReason ?? "当前实例未持有金融单写者租约。");
    }

    const existing = this.readExistingLeaseRecord().snapshot;
    if (!this.isSameAcquisition(existing, this.snapshot)) {
      throw new Error(
        "金融单写者租约所有者已变化或 fencing token 不匹配，当前实例必须停止金融操作。"
      );
    }
    if (Date.parse(existing.expiresAt) <= this.now().getTime()) {
      throw new Error("金融单写者租约已过期，当前实例必须停止金融操作。");
    }

    return existing as FinancialWriterLeaseSnapshot;
  }

  private isSameAcquisition(
    left: StoredFinancialWriterLeaseSnapshot,
    right: FinancialWriterLeaseSnapshot
  ) {
    return (
      left.version === 2 &&
      left.ownerId === right.ownerId &&
      left.fencingToken === right.fencingToken
    );
  }

  private isActive(snapshot: StoredFinancialWriterLeaseSnapshot, now: Date) {
    const expired = Date.parse(snapshot.expiresAt) <= now.getTime();
    const sameHostProcessAlive =
      snapshot.hostname === this.hostname &&
      snapshot.pid > 0 &&
      this.isProcessAlive(snapshot.pid);
    return !expired || sameHostProcessAlive;
  }

  private createExistingOwnerError(snapshot: StoredFinancialWriterLeaseSnapshot) {
    return new Error(
      `已有其他实例持有金融单写者租约：${snapshot.ownerId}（${snapshot.hostname}:${snapshot.pid}）。`
    );
  }

  private readExistingLeaseRecord(): LeaseFileRecord {
    let serialized: string;

    try {
      serialized = readFileSync(this.lockFile, "utf8");
    } catch {
      throw new Error(
        `金融单写者租约文件无法读取，已关闭式停止：${this.lockFile}`
      );
    }

    return {
      serialized,
      snapshot: this.parseLeaseSnapshot(serialized)
    };
  }

  private parseLeaseSnapshot(
    serialized: string
  ): StoredFinancialWriterLeaseSnapshot {
    let parsed: unknown;

    try {
      parsed = JSON.parse(serialized);
    } catch {
      throw new Error("金融单写者租约内容不是有效 JSON。");
    }

    const record = parsed as Partial<StoredFinancialWriterLeaseSnapshot>;
    const commonFieldsValid =
      parsed &&
      typeof parsed === "object" &&
      (record.version === 1 || record.version === 2) &&
      typeof record.ownerId === "string" &&
      typeof record.pid === "number" &&
      typeof record.hostname === "string" &&
      typeof record.acquiredAt === "string" &&
      typeof record.heartbeatAt === "string" &&
      typeof record.expiresAt === "string" &&
      Number.isFinite(Date.parse(record.acquiredAt)) &&
      Number.isFinite(Date.parse(record.heartbeatAt)) &&
      Number.isFinite(Date.parse(record.expiresAt));
    const fencingTokenValid =
      record.version === 1 ||
      (
        "fencingToken" in record &&
        typeof record.fencingToken === "string" &&
        Boolean(record.fencingToken.trim())
      );

    if (!commonFieldsValid || !fencingTokenValid) {
      throw new Error("金融单写者租约内容不完整。");
    }

    return record as StoredFinancialWriterLeaseSnapshot;
  }

  private withLifecycleGuard<T>(operation: () => T): T {
    const guard = this.acquireLifecycleGuard();

    try {
      return operation();
    } finally {
      this.releaseLifecycleGuard(guard);
    }
  }

  private acquireLifecycleGuard(): LifecycleGuardSnapshot {
    mkdirSync(dirname(this.lifecycleGuardFile), { recursive: true });
    const guard: LifecycleGuardSnapshot = {
      version: 1,
      ownerId: this.ownerId,
      token: randomUUID(),
      pid: this.pid,
      hostname: this.hostname,
      createdAt: this.now().toISOString()
    };
    let descriptor: number | undefined;

    try {
      descriptor = openSync(this.lifecycleGuardFile, "wx", 0o600);
      writeFileSync(descriptor, JSON.stringify(guard, null, 2), "utf8");
      fsyncSync(descriptor);
      closeSync(descriptor);
      descriptor = undefined;
      return guard;
    } catch (error) {
      if (descriptor !== undefined) {
        closeSync(descriptor);
      }
      if ((error as NodeJS.ErrnoException).code === "EEXIST") {
        throw new Error(
          `金融租约生命周期互斥锁已存在，可能有接管/释放正在进行；为避免双写已停止：${this.lifecycleGuardFile}`
        );
      }
      throw error;
    }
  }

  private releaseLifecycleGuard(guard: LifecycleGuardSnapshot) {
    try {
      const persisted = JSON.parse(
        readFileSync(this.lifecycleGuardFile, "utf8")
      ) as Partial<LifecycleGuardSnapshot>;
      if (persisted.token === guard.token) {
        unlinkSync(this.lifecycleGuardFile);
      }
    } catch {
      // 互斥锁无法证明仍属于本次操作时保留现场，后续写入继续失败关闭。
    }
  }

  private startHeartbeat() {
    if (!this.autoHeartbeat || this.heartbeatTimer) {
      return;
    }

    this.heartbeatTimer = setInterval(() => {
      try {
        this.heartbeat();
      } catch {
        // heartbeat 已记录租约丢失状态；调用方和持久化层会关闭式阻断后续金融写入。
      }
    }, this.heartbeatIntervalMs);
    this.heartbeatTimer.unref?.();
  }

  private stopHeartbeat() {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = undefined;
    }
  }

  private markLost(reason: string) {
    this.lostReason = reason;
    this.stopHeartbeat();
  }

  private readonly defaultIsProcessAlive = (pid: number) => {
    try {
      process.kill(pid, 0);
      return true;
    } catch (error) {
      return (error as NodeJS.ErrnoException).code === "EPERM";
    }
  };
}
