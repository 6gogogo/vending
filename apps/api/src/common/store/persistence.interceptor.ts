import { CallHandler, ExecutionContext, Inject, Injectable, NestInterceptor } from "@nestjs/common";
import { tap } from "rxjs";

import { InMemoryStoreService } from "./in-memory-store.service";
import { appendSystemAuditLog } from "./persistence";

const MAX_LOG_DEPTH = 4;
const MAX_LOG_STRING_LENGTH = 4_000;
const MAX_LOG_ARRAY_ITEMS = 20;
const MAX_LOG_OBJECT_KEYS = 40;

@Injectable()
export class PersistenceInterceptor implements NestInterceptor {
  constructor(
    @Inject(InMemoryStoreService)
    private readonly store: InMemoryStoreService
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
    }>();
    const response = context.switchToHttp().getResponse<{ statusCode?: number; getHeader?: (name: string) => unknown }>();
    const startedAt = Date.now();

    return next.handle().pipe(
      tap({
        next: (data) => {
          this.writeAuditLog({
            request,
            response,
            startedAt,
            responseBody: data
          });
          this.store.persist();
        },
        error: (error) => {
          this.writeAuditLog({
            request,
            response,
            startedAt,
            error
          });
        }
      })
    );
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

    appendSystemAuditLog({
      occurredAt: new Date().toISOString(),
      method: payload.request.method ?? "UNKNOWN",
      path: payload.request.path ?? payload.request.url ?? "",
      query: this.normalizeForLog(payload.request.query),
      params: this.normalizeForLog(payload.request.params),
      body: this.normalizeForLog(payload.request.body),
      statusCode: payload.error
        ? this.readErrorStatus(payload.error) ?? payload.response.statusCode ?? 500
        : payload.response.statusCode ?? 200,
      durationMs: Date.now() - payload.startedAt,
      actorUserId: payload.request.authUser?.id,
      actorRole: payload.request.authUser?.role as "admin" | "merchant" | "special" | undefined,
      ip: payload.request.ip,
      userAgent: payload.request.headers?.["user-agent"],
      response: payload.error
        ? undefined
        : isFileDownload
          ? "[file download]"
          : this.normalizeForLog(payload.responseBody),
      error: payload.error
        ? {
            name: payload.error instanceof Error ? payload.error.name : "Error",
            message: payload.error instanceof Error ? payload.error.message : "unknown"
          }
        : undefined
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

  private readErrorStatus(error: unknown) {
    if (typeof error === "object" && error && "status" in error) {
      const status = (error as { status?: unknown }).status;
      if (typeof status === "number") {
        return status;
      }
    }

    return undefined;
  }
}
