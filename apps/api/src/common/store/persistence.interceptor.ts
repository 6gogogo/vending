import { CallHandler, ExecutionContext, Inject, Injectable, NestInterceptor } from "@nestjs/common";
import { tap } from "rxjs";

import { InMemoryStoreService } from "./in-memory-store.service";
import { appendSystemAuditLog } from "./persistence";

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
    if (value === undefined || value === null) {
      return value;
    }

    if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
      return value;
    }

    if (Array.isArray(value)) {
      return value.map((item) => this.normalizeForLog(item));
    }

    if (typeof FormData !== "undefined" && value instanceof FormData) {
      return "[form-data]";
    }

    if (value instanceof Uint8Array || value instanceof ArrayBuffer) {
      return "[binary]";
    }

    if (typeof value === "object") {
      try {
        return JSON.parse(JSON.stringify(value));
      } catch {
        return "[unserializable]";
      }
    }

    return String(value);
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
