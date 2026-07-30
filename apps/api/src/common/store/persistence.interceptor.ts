import {
  CallHandler,
  ConflictException,
  ExecutionContext,
  Inject,
  Injectable,
  NestInterceptor,
  Optional,
  ServiceUnavailableException
} from "@nestjs/common";
import { catchError, tap, throwError } from "rxjs";

import { isProductionRuntime } from "../config/runtime-environment";
import { summarizeCallbackPayload } from "../logging/callback-log-sanitizer";
import { InMemoryStoreService } from "./in-memory-store.service";
import { PersistedStateWriteError } from "./persistence";
import {
  SystemAuditLogService,
  type CriticalAuditOutcome
} from "./system-audit-log.service";

const MAX_LOG_DEPTH = 4;
const MAX_LOG_STRING_LENGTH = 4_000;
const MAX_LOG_ARRAY_ITEMS = 20;
const MAX_LOG_OBJECT_KEYS = 40;
const SENSITIVE_LOG_KEY_FRAGMENTS = [
  "password",
  "passwd",
  "passcode",
  "token",
  "secret",
  "authorization",
  "cookie",
  "credential"
] as const;
const SENSITIVE_LOG_KEY_SUFFIXES = [
  "apikey",
  "accesskey",
  "clientkey",
  "encryptionkey",
  "privatekey",
  "secretkey",
  "signingkey",
  "phone",
  "phonenumber",
  "mobile",
  "mobilenumber",
  "telephone"
] as const;
const SENSITIVE_LOG_CODE_KEYS = new Set([
  "authcode",
  "buyerid",
  "buyerlogonid",
  "buyeropenid",
  "buyeruserid",
  "certifycode",
  "code",
  "invitecode",
  "otp",
  "otpcode",
  "previewcode",
  "payeralipayuserid",
  "payeridentityhandle",
  "payeropenid",
  "package",
  "paysign",
  "prepayid",
  "sign",
  "signature",
  "recoverycode",
  "smscode",
  "verificationcode"
]);
const HEALTH_PROBE_PATHS = new Set([
  "/api/health",
  "/api/health/production-readiness"
]);

export const REQUEST_PERSISTENCE_HANDLED = Symbol(
  "request-persistence-handled"
);

@Injectable()
export class PersistenceInterceptor implements NestInterceptor {
  constructor(
    @Inject(InMemoryStoreService)
    private readonly store: InMemoryStoreService,
    @Optional()
    @Inject(SystemAuditLogService)
    private readonly auditLog: SystemAuditLogService = new SystemAuditLogService()
  ) {}

  intercept(context: ExecutionContext, next: CallHandler) {
    const request = context.switchToHttp().getRequest<{
      method?: string;
      path?: string;
      url?: string;
      query?: unknown;
      params?: unknown;
      body?: unknown;
      ip?: string;
      headers?: Record<string, string | undefined>;
      authUser?: { id?: string; role?: string };
      [REQUEST_PERSISTENCE_HANDLED]?: boolean;
    }>();
    const response = context.switchToHttp().getResponse<{ statusCode?: number; getHeader?: (name: string) => unknown }>();
    const startedAt = Date.now();
    const shouldWriteAuditLog = this.shouldWriteAuditLog(request);

    if (
      isProductionRuntime() &&
      !this.isHealthProbe(request) &&
      (!this.store.isPersistedStateIntegrityReady() || !this.auditLog.isReady())
    ) {
      return throwError(
        () => new ServiceUnavailableException("运行数据暂不可用。")
      );
    }

    let criticalOperation: ReturnType<SystemAuditLogService["beginCriticalIntent"]> | undefined;
    let criticalAuditCompleted = false;

    if (isProductionRuntime() && this.shouldWriteCriticalAuditIntent(request)) {
      try {
        criticalOperation = this.auditLog.beginCriticalIntent({
          method: request.method ?? "UNKNOWN",
          path: this.getAuditIntentPath(request),
          actorUserId: request.authUser?.id,
          actorRole: request.authUser?.role as "admin" | "merchant" | "special" | undefined,
          metadata: {
            source: "http",
            operationClass: "mutating-request"
          }
        });
      } catch {
        return throwError(
          () => new ServiceUnavailableException("系统审计暂不可用。")
        );
      }
    }

    const completeCriticalAudit = (
      outcome: CriticalAuditOutcome,
      statusCode: number,
      metadata?: Record<string, unknown>
    ) => {
      if (!criticalOperation || criticalAuditCompleted) {
        return;
      }

      criticalAuditCompleted = true;

      try {
        this.auditLog.completeCriticalOperation(criticalOperation, {
          method: request.method ?? "UNKNOWN",
          path: this.getAuditIntentPath(request),
          statusCode,
          durationMs: Date.now() - startedAt,
          outcome,
          actorUserId: request.authUser?.id,
          actorRole: request.authUser?.role as "admin" | "merchant" | "special" | undefined,
          metadata: {
            source: "http",
            operationClass: "mutating-request",
            ...metadata
          }
        });
      } catch {
        // 完成记录失败不能改写已发生的业务结果；服务状态会在下一次入口检查中保持关闭。
        this.auditLog.recordFailure();
      }
    };

    return next.handle().pipe(
      catchError((error) => {
        if (error instanceof PersistedStateWriteError && error.committed) {
          return throwError(
            () =>
              new ConflictException({
                message: "请求状态暂不可确认，请勿重复提交；请联系管理员核对。",
                code: "operation_indeterminate",
                ...(criticalOperation
                  ? { operationId: criticalOperation.operationId }
                  : {}),
                retryable: false
              })
          );
        }

        return throwError(() => error);
      }),
      tap({
        next: (data) => {
          if (
            request[REQUEST_PERSISTENCE_HANDLED] !== true &&
            this.shouldPersistRequest(request.method, response.statusCode)
          ) {
            try {
              this.store.persist();
            } catch (error) {
              completeCriticalAudit(
                "indeterminate",
                409,
                {
                  failureClass: "persistence",
                  retryable: false
                }
              );
              if (shouldWriteAuditLog) {
                this.writeAuditLogSafely({
                  request,
                  response,
                  startedAt,
                  error
                });
              }

              if (isProductionRuntime() && criticalOperation) {
                throw new ConflictException({
                  message: "请求状态暂不可确认，请勿重复提交；请联系管理员核对。",
                  code: "operation_indeterminate",
                  operationId: criticalOperation.operationId,
                  retryable: false
                });
              }
              throw error;
            }
          }
          completeCriticalAudit("completed", response.statusCode ?? 200);
          if (shouldWriteAuditLog) {
            this.writeAuditLogSafely({
              request,
              response,
              startedAt,
              responseBody: data
            });
          }
        },
        error: (error) => {
          const errorStatus = this.readErrorStatus(error) ?? response.statusCode ?? 500;
          const operationIndeterminate =
            this.isOperationIndeterminateError(error);
          completeCriticalAudit(
            operationIndeterminate
              ? "indeterminate"
              : errorStatus >= 400 && errorStatus < 500
                ? "rejected"
                : "indeterminate",
            errorStatus
          );
          if (shouldWriteAuditLog) {
            this.writeAuditLogSafely({
              request,
              response,
              startedAt,
              error
            });
          }
        }
      })
    );
  }

  private shouldWriteAuditLog(request: { method?: string; path?: string; url?: string }) {
    return !this.isHealthProbe(request);
  }

  private shouldWriteCriticalAuditIntent(request: { method?: string; path?: string; url?: string }) {
    return (
      !this.isHealthProbe(request) &&
      !["GET", "HEAD", "OPTIONS"].includes((request.method ?? "").toUpperCase())
    );
  }

  private getAuditIntentPath(request: { path?: string; url?: string }) {
    const rawPath = request.path ?? request.url ?? "";
    return rawPath.split("?", 1)[0] ?? rawPath;
  }

  private isHealthProbe(request: { method?: string; path?: string; url?: string }) {
    const method = request.method?.toUpperCase();
    const path = ((request.path ?? request.url ?? "").split("?", 1)[0] ?? "").replace(/\/+$/, "");

    // 健康探测可被负载均衡或受控网关高频调用，不能让它同步放大为审计文件写入。
    return ["GET", "HEAD"].includes(method ?? "") && HEALTH_PROBE_PATHS.has(path);
  }

  private writeAuditLogSafely(payload: Parameters<PersistenceInterceptor["writeAuditLog"]>[0]) {
    try {
      this.writeAuditLog(payload);
    } catch {
      // 日志序列化、摘要或响应对象访问失败同样意味着审计不可用；不得覆盖原业务结果。
      this.auditLog.recordFailure();
    }
  }

  private writeAuditLog(payload: {
    request: {
      method?: string;
      path?: string;
      url?: string;
      query?: unknown;
      params?: unknown;
      body?: unknown;
      ip?: string;
      headers?: Record<string, string | undefined>;
      authUser?: { id?: string; role?: string };
    };
    response: {
      statusCode?: number;
      getHeader?: (name: string) => unknown;
    };
    startedAt: number;
    responseBody?: unknown;
    error?: unknown;
  }) {
    const contentDisposition = payload.response.getHeader?.("content-disposition");
    const isFileDownload = typeof contentDisposition === "string" && contentDisposition.length > 0;
    const rawRequestPath = payload.request.path ?? payload.request.url ?? "";
    const callbackRoutePath = rawRequestPath.split("?", 1)[0] ?? rawRequestPath;
    const isCallback = callbackRoutePath.includes("/callbacks/");
    const requestPath = isCallback ? callbackRoutePath : rawRequestPath;
    const normalizedResponse = payload.error
      ? undefined
      : isFileDownload
        ? "[file download]"
        : this.normalizeForLog(payload.responseBody);

    return this.auditLog.appendSafely({
      occurredAt: new Date().toISOString(),
      method: payload.request.method ?? "UNKNOWN",
      path: requestPath,
      query: isCallback ? undefined : this.normalizeForLog(payload.request.query),
      params: isCallback ? undefined : this.normalizeForLog(payload.request.params),
      body: isCallback
        ? summarizeCallbackPayload(payload.request.body)
        : this.normalizeForLog(payload.request.body),
      statusCode: payload.error
        ? this.readErrorStatus(payload.error) ?? payload.response.statusCode ?? 500
        : payload.response.statusCode ?? 200,
      durationMs: Date.now() - payload.startedAt,
      actorUserId: payload.request.authUser?.id,
      actorRole: payload.request.authUser?.role as "admin" | "merchant" | "special" | undefined,
      ip: payload.request.ip,
      userAgent: payload.request.headers?.["user-agent"],
      response: normalizedResponse,
      error: payload.error
        ? {
            name: payload.error instanceof Error ? payload.error.name : "Error",
            message: payload.error instanceof Error ? payload.error.message : "unknown"
          }
        : undefined,
      metadata: {
        direction: isCallback ? "incoming" : "internal",
        source: isCallback ? "platform" : "client",
        target: "backend",
        actualResponseBodyRecorded: normalizedResponse !== undefined
      }
    });
  }

  private normalizeForLog(value: unknown): unknown {
    return this.normalizeForLogValue(value, 0);
  }

  private normalizeForLogValue(value: unknown, depth: number): unknown {
    if (value === undefined || value === null) {
      return value;
    }

    if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
      return typeof value === "string" ? this.truncateString(value) : value;
    }

    if (depth >= MAX_LOG_DEPTH) {
      return "[truncated: max depth]";
    }

    if (Array.isArray(value)) {
      const normalizedItems = value
        .slice(0, MAX_LOG_ARRAY_ITEMS)
        .map((item) => this.normalizeForLogValue(item, depth + 1));

      if (value.length > MAX_LOG_ARRAY_ITEMS) {
        normalizedItems.push(`[truncated: ${value.length - MAX_LOG_ARRAY_ITEMS} more items]`);
      }

      return normalizedItems;
    }

    if (typeof FormData !== "undefined" && value instanceof FormData) {
      return "[form-data]";
    }

    if (value instanceof Uint8Array || value instanceof ArrayBuffer) {
      return "[binary]";
    }

    if (typeof value === "object") {
      try {
        const normalizedObject: Record<string, unknown> = {};
        const entries = Object.entries(value as Record<string, unknown>);

        for (const [index, [key, nestedValue]] of entries.entries()) {
          if (index >= MAX_LOG_OBJECT_KEYS) {
            normalizedObject.__truncated__ = `${entries.length - MAX_LOG_OBJECT_KEYS} more keys`;
            break;
          }

          if (this.isSensitiveLogKey(key)) {
            normalizedObject[key] = "[redacted]";
            continue;
          }

          normalizedObject[key] = this.normalizeForLogValue(nestedValue, depth + 1);
        }

        return normalizedObject;
      } catch {
        return "[unserializable]";
      }
    }

    return String(value);
  }

  private truncateString(value: string) {
    if (value.length <= MAX_LOG_STRING_LENGTH) {
      return value;
    }

    return `${value.slice(0, MAX_LOG_STRING_LENGTH)}...[truncated ${value.length - MAX_LOG_STRING_LENGTH} chars]`;
  }

  private shouldPersistRequest(method?: string, statusCode = 200) {
    return (
      statusCode >= 200 &&
      statusCode < 400 &&
      !["GET", "HEAD", "OPTIONS"].includes((method ?? "").toUpperCase())
    );
  }

  private isSensitiveLogKey(key: string) {
    const normalized = key.replace(/[^a-zA-Z0-9]/g, "").toLowerCase();
    const words = key
      .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter(Boolean);

    return (
      SENSITIVE_LOG_CODE_KEYS.has(normalized) ||
      normalized === "key" ||
      words.includes("key") ||
      SENSITIVE_LOG_KEY_FRAGMENTS.some((fragment) => normalized.includes(fragment)) ||
      SENSITIVE_LOG_KEY_SUFFIXES.some((suffix) => normalized.endsWith(suffix))
    );
  }

  private readErrorStatus(error: unknown) {
    if (typeof error === "object" && error && "status" in error) {
      const status = (error as { status?: unknown }).status;
      if (typeof status === "number") {
        return status;
      }
    }

    return undefined;
  }

  private isOperationIndeterminateError(error: unknown) {
    if (
      typeof error !== "object" ||
      !error ||
      !("getResponse" in error) ||
      typeof error.getResponse !== "function"
    ) {
      return false;
    }

    const response = error.getResponse();
    return (
      typeof response === "object" &&
      response !== null &&
      "code" in response &&
      response.code === "operation_indeterminate"
    );
  }
}
