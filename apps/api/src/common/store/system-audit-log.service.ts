import { randomUUID } from "node:crypto";
import { Inject, Injectable, Optional, ServiceUnavailableException } from "@nestjs/common";
import type { SystemAuditLogEntry } from "@vm/shared-types";

import { appendSystemAuditLog } from "./persistence";

export type SystemAuditLogStatus = "unverified" | "ready" | "failed";

export interface SystemAuditLogRuntimeAdapter {
  appendAuditLog?: typeof appendSystemAuditLog;
  reportFailure?: () => void;
}

export interface CriticalAuditIntentInput {
  method: string;
  path: string;
  actorUserId?: string;
  actorRole?: SystemAuditLogEntry["actorRole"];
  metadata?: Record<string, unknown>;
}

export interface CriticalAuditOperation {
  operationId: string;
  startedAt: number;
}

export type CriticalAuditOutcome = "completed" | "failed" | "indeterminate" | "rejected";

export interface CriticalAuditCompletionInput {
  method: string;
  path: string;
  statusCode: number;
  durationMs: number;
  outcome: CriticalAuditOutcome;
  actorUserId?: string;
  actorRole?: SystemAuditLogEntry["actorRole"];
  metadata?: Record<string, unknown>;
}

export const SYSTEM_AUDIT_LOG_RUNTIME_ADAPTER = Symbol(
  "SYSTEM_AUDIT_LOG_RUNTIME_ADAPTER"
);

const SYSTEM_AUDIT_STARTUP_PATH = "/internal/system-audit-log/startup";

@Injectable()
export class SystemAuditLogService {
  private readonly appendAuditLog: typeof appendSystemAuditLog;
  private readonly reportFailure: () => void;
  private status: SystemAuditLogStatus = "unverified";
  private failureReported = false;
  private readonly activeCriticalOperations = new Map<string, CriticalAuditOperation>();
  private startupInitialized = false;
  private startupOperation?: CriticalAuditOperation;

  constructor(
    @Optional()
    @Inject(SYSTEM_AUDIT_LOG_RUNTIME_ADAPTER)
    runtimeAdapter?: SystemAuditLogRuntimeAdapter
  ) {
    this.appendAuditLog = runtimeAdapter?.appendAuditLog ?? appendSystemAuditLog;
    this.reportFailure = runtimeAdapter?.reportFailure ?? (() => {
      if (process.env.NODE_ENV !== "test") {
        console.error("系统审计日志不可用；生产业务流量将保持关闭，请检查持久化介质后重启服务。");
      }
    });
  }

  initialize() {
    if (this.status === "failed") {
      throw new Error("系统审计日志不可用。");
    }

    if (this.startupOperation) {
      return this.startupOperation;
    }

    if (this.startupInitialized) {
      return undefined;
    }

    const operation = this.beginCriticalIntent({
      method: "SYSTEM",
      path: SYSTEM_AUDIT_STARTUP_PATH,
      metadata: {
        component: "api",
        operationClass: "startup"
      }
    });
    this.startupInitialized = true;
    this.startupOperation = operation;

    return operation;
  }

  completeStartup(operation: CriticalAuditOperation) {
    if (this.startupOperation !== operation) {
      return false;
    }

    const completed = this.completeCriticalOperation(operation, {
      method: "SYSTEM",
      path: SYSTEM_AUDIT_STARTUP_PATH,
      statusCode: 200,
      durationMs: Math.max(0, Date.now() - operation.startedAt),
      outcome: "completed",
      metadata: {
        component: "api",
        operationClass: "startup"
      }
    });
    this.startupOperation = undefined;

    return completed;
  }

  failStartup(operation: CriticalAuditOperation) {
    if (this.startupOperation !== operation) {
      return false;
    }

    const completed = this.completeCriticalOperation(operation, {
      method: "SYSTEM",
      path: SYSTEM_AUDIT_STARTUP_PATH,
      statusCode: 500,
      durationMs: Math.max(0, Date.now() - operation.startedAt),
      outcome: "failed",
      metadata: {
        component: "api",
        operationClass: "startup"
      }
    });
    this.startupOperation = undefined;

    return completed;
  }

  appendSafely(entry: SystemAuditLogEntry) {
    if (this.status === "failed") {
      return false;
    }

    try {
      this.appendAuditLog(entry);
      this.status = "ready";
      return true;
    } catch {
      this.markFailed();
      return false;
    }
  }

  /**
   * 在不可逆副作用前持久化最小审计意图。写入失败必须阻止副作用，
   * 因而不接受请求体、响应体、URL 查询或原始错误等高风险字段。
   */
  beginCriticalIntent(input: CriticalAuditIntentInput): CriticalAuditOperation {
    const operation: CriticalAuditOperation = {
      operationId: randomUUID(),
      startedAt: Date.now()
    };
    const appended = this.appendSafely({
      occurredAt: new Date(operation.startedAt).toISOString(),
      method: input.method,
      path: input.path,
      statusCode: 202,
      durationMs: 0,
      actorUserId: input.actorUserId,
      actorRole: input.actorRole,
      metadata: {
        ...input.metadata,
        auditPhase: "intent",
        operationId: operation.operationId
      }
    });

    if (!appended) {
      throw new ServiceUnavailableException("系统审计暂不可用。");
    }

    this.activeCriticalOperations.set(operation.operationId, operation);

    return operation;
  }

  /**
   * 完成记录只能补充已存在的意图。若此处失败，实际副作用可能已经完成，
   * 因此锁存服务但由调用方保留真实业务结果，避免诱导客户端盲目重试。
   */
  completeCriticalOperation(
    operation: CriticalAuditOperation,
    input: CriticalAuditCompletionInput
  ) {
    if (this.activeCriticalOperations.get(operation.operationId) !== operation) {
      return false;
    }

    // 在写入前移出活动集合，避免结果构造/错误处理路径为同一意图写出互相矛盾的结论。
    this.activeCriticalOperations.delete(operation.operationId);

    const appended = this.appendSafely({
      occurredAt: new Date().toISOString(),
      method: input.method,
      path: input.path,
      statusCode: input.statusCode,
      durationMs: input.durationMs,
      actorUserId: input.actorUserId,
      actorRole: input.actorRole,
      metadata: {
        ...input.metadata,
        auditPhase: input.outcome,
        operationId: operation.operationId
      }
    });

    return appended;
  }

  recordFailure() {
    this.markFailed();
  }

  isReady() {
    return this.status === "ready";
  }

  getStatus() {
    return this.status;
  }

  private markFailed() {
    this.status = "failed";

    if (!this.failureReported) {
      this.failureReported = true;
      try {
        this.reportFailure();
      } catch {
        // 故障上报是旁路诊断，绝不能覆盖已经完成的业务或金融结果。
      }
    }
  }

}
