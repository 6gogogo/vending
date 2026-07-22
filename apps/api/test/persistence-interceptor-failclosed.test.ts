import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  ConflictException,
  ServiceUnavailableException,
  type CallHandler,
  type ExecutionContext
} from "@nestjs/common";
import { firstValueFrom, of, throwError } from "rxjs";

import { PersistenceInterceptor } from "../src/common/store/persistence.interceptor.js";
import type { InMemoryStoreService } from "../src/common/store/in-memory-store.service.js";
import { SystemAuditLogService } from "../src/common/store/system-audit-log.service.js";

const withEnvironment = (
  values: Record<string, string | undefined>,
  action: () => Promise<void>
) => {
  const previous = new Map(
    Object.keys(values).map((key) => [key, process.env[key]])
  );

  for (const [key, value] of Object.entries(values)) {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }

  return action().finally(() => {
    for (const [key, value] of previous) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  });
};

const createContext = (request: {
  method: string;
  path?: string;
  url?: string;
  headers?: Record<string, string | undefined>;
  getHeader?: (name: string) => unknown;
}) =>
  ({
    switchToHttp: () => ({
      getRequest: () => ({ ...request, headers: request.headers ?? {} }),
      getResponse: () => ({ statusCode: 200, getHeader: request.getHeader })
    })
  }) as ExecutionContext;

test("生产运行数据失效后拒绝业务请求，但保留健康和就绪探针", async () => {
  await withEnvironment(
    {
      NODE_ENV: "production",
      APP_ENV: "production"
    },
    async () => {
      let blockedHandlerCalls = 0;
      const interceptor = new PersistenceInterceptor({
        isPersistedStateIntegrityReady: () => false,
        persist: () => undefined
      } as InMemoryStoreService);

      await assert.rejects(
        firstValueFrom(
          interceptor.intercept(
            createContext({ method: "GET", path: "/api/public-config" }),
            {
              handle: () => {
                blockedHandlerCalls += 1;
                return of({ data: "must-not-run" });
              }
            } as CallHandler
          )
        ),
        (error: unknown) =>
          error instanceof ServiceUnavailableException && error.getStatus() === 503
      );
      assert.equal(blockedHandlerCalls, 0);

      for (const path of ["/api/health", "/api/health/production-readiness"]) {
        const response = await firstValueFrom(
          interceptor.intercept(
            createContext({ method: "GET", path }),
            { handle: () => of({ data: "probe-allowed" }) } as CallHandler
          )
        );
        assert.deepEqual(response, { data: "probe-allowed" });
      }
    }
  );
});

test("生产熔断只豁免精确的健康探针，非生产环境保留诊断入口", async (t) => {
  const directory = mkdtempSync(join(tmpdir(), "vm-persistence-interceptor-probe-"));
  const systemLogFile = join(directory, "system-audit.ndjson");
  t.after(() => rmSync(directory, { recursive: true, force: true }));

  await withEnvironment(
    {
      NODE_ENV: "production",
      APP_ENV: "production",
      SYSTEM_LOG_FILE: systemLogFile
    },
    async () => {
      const interceptor = new PersistenceInterceptor({
        isPersistedStateIntegrityReady: () => false,
        persist: () => undefined
      } as InMemoryStoreService);

      for (const request of [
        { method: "GET", path: "/api/health/" },
        { method: "HEAD", url: "/api/health?probe=load-balancer" },
        { method: "GET", url: "/api/health/production-readiness?probe=gateway" }
      ]) {
        let handlerCalls = 0;
        await firstValueFrom(
          interceptor.intercept(
            createContext(request),
            {
              handle: () => {
                handlerCalls += 1;
                return of({ data: "probe-allowed" });
              }
            } as CallHandler
          )
        );
        assert.equal(handlerCalls, 1);
      }

      for (const request of [
        { method: "GET", path: "/api/health-extra" },
        { method: "POST", path: "/api/health" },
        { method: "OPTIONS", path: "/api/health" }
      ]) {
        let handlerCalls = 0;
        await assert.rejects(
          firstValueFrom(
            interceptor.intercept(
              createContext(request),
              {
                handle: () => {
                  handlerCalls += 1;
                  return of({ data: "must-not-run" });
                }
              } as CallHandler
            )
          ),
          (error: unknown) =>
            error instanceof ServiceUnavailableException && error.getStatus() === 503
        );
        assert.equal(handlerCalls, 0);
      }
    }
  );

  await withEnvironment(
    {
      NODE_ENV: "test",
      APP_ENV: undefined,
      SYSTEM_LOG_FILE: systemLogFile
    },
    async () => {
      let handlerCalls = 0;
      const interceptor = new PersistenceInterceptor({
        isPersistedStateIntegrityReady: () => false,
        persist: () => undefined
      } as InMemoryStoreService);
      const response = await firstValueFrom(
        interceptor.intercept(
          createContext({ method: "GET", path: "/api/public-config" }),
          {
            handle: () => {
              handlerCalls += 1;
              return of({ data: "local-diagnostics-allowed" });
            }
          } as CallHandler
        )
      );

      assert.equal(handlerCalls, 1);
      assert.deepEqual(response, { data: "local-diagnostics-allowed" });
    }
  );
});

test("生产持久化失败后锁存为不可用，后续业务请求不再进入处理器", async (t) => {
  const directory = mkdtempSync(join(tmpdir(), "vm-persistence-interceptor-latch-"));
  const systemLogFile = join(directory, "system-audit.ndjson");
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  let integrityReady = true;
  let handlerCalls = 0;
  const persistError = new Error("persist-failed");
  const auditEntries: Array<Record<string, unknown>> = [];

  await withEnvironment(
    {
      NODE_ENV: "production",
      APP_ENV: "production",
      SYSTEM_LOG_FILE: systemLogFile
    },
    async () => {
      const auditLog = new SystemAuditLogService({
        appendAuditLog: (entry) => {
          auditEntries.push(entry as unknown as Record<string, unknown>);
          return "test-system-audit.ndjson";
        },
        reportFailure: () => undefined
      });
      auditLog.initialize();
      const interceptor = new PersistenceInterceptor({
        isPersistedStateIntegrityReady: () => integrityReady,
        persist: () => {
          integrityReady = false;
          throw persistError;
        }
      } as unknown as InMemoryStoreService, auditLog);

      await assert.rejects(
        firstValueFrom(
          interceptor.intercept(
            createContext({ method: "POST", path: "/api/example" }),
            {
              handle: () => {
                handlerCalls += 1;
                return of({ data: "business-result" });
              }
            } as CallHandler
          )
        ),
        (error: unknown) => {
          if (!(error instanceof ConflictException) || error.getStatus() !== 409) {
            return false;
          }
          const response = error.getResponse() as Record<string, unknown>;
          return (
            response.code === "operation_indeterminate" &&
            typeof response.operationId === "string" &&
            response.retryable === false
          );
        }
      );
      assert.equal(handlerCalls, 1);
      assert.equal(
        auditEntries.some(
          (entry) =>
            (entry.metadata as Record<string, unknown> | undefined)?.auditPhase === "indeterminate"
        ),
        true
      );
      const indeterminateEntry = auditEntries.find(
        (entry) =>
          (entry.metadata as Record<string, unknown> | undefined)?.auditPhase === "indeterminate"
      );
      assert.equal(indeterminateEntry?.statusCode, 409);
      assert.equal(
        (indeterminateEntry?.metadata as Record<string, unknown> | undefined)?.retryable,
        false
      );

      await assert.rejects(
        firstValueFrom(
          interceptor.intercept(
            createContext({ method: "GET", path: "/api/public-config" }),
            {
              handle: () => {
                handlerCalls += 1;
                return of({ data: "must-not-run" });
              }
            } as CallHandler
          )
        ),
        (error: unknown) =>
          error instanceof ServiceUnavailableException && error.getStatus() === 503
      );
      assert.equal(handlerCalls, 1);
    }
  );
});

test("审计日志不可写时，成功业务仍先持久化且不把审计故障返回给客户端", async (t) => {
  const directory = mkdtempSync(join(tmpdir(), "vm-persistence-interceptor-"));
  const blocker = join(directory, "not-a-directory");
  writeFileSync(blocker, "blocker", "utf8");
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  let persistedCount = 0;

  await withEnvironment(
    {
      NODE_ENV: "test",
      APP_ENV: undefined,
      SYSTEM_LOG_FILE: join(blocker, "system-audit.ndjson")
    },
    async () => {
      const interceptor = new PersistenceInterceptor({
        isPersistedStateIntegrityReady: () => true,
        persist: () => {
          persistedCount += 1;
        }
      } as InMemoryStoreService);

      const response = await firstValueFrom(
        interceptor.intercept(
          createContext({ method: "POST", path: "/api/example" }),
          { handle: () => of({ data: "durable-success" }) } as CallHandler
        )
      );

      assert.deepEqual(response, { data: "durable-success" });
      assert.equal(persistedCount, 1);
    }
  );
});

test("生产关键写入的审计意图失败时，不执行处理器或持久化", async () => {
  let auditWriteFails = false;
  const auditLog = new SystemAuditLogService({
    appendAuditLog: () => {
      if (auditWriteFails) {
        throw new Error("audit-write-failed");
      }
      return "test-system-audit.ndjson";
    },
    reportFailure: () => undefined
  });
  auditLog.initialize();
  let persistedCount = 0;
  let handlerCalls = 0;

  await withEnvironment(
    {
      NODE_ENV: "production",
      APP_ENV: "production"
    },
    async () => {
      const interceptor = new PersistenceInterceptor({
        isPersistedStateIntegrityReady: () => true,
        persist: () => {
          persistedCount += 1;
        }
      } as InMemoryStoreService, auditLog);
      auditWriteFails = true;

      await assert.rejects(
        firstValueFrom(
          interceptor.intercept(
            createContext({ method: "POST", path: "/api/example" }),
            {
              handle: () => {
                handlerCalls += 1;
                return of({ data: "must-not-run" });
              }
            } as CallHandler
          )
        ),
        (error: unknown) =>
          error instanceof ServiceUnavailableException && error.getStatus() === 503
      );
      assert.equal(persistedCount, 0);
      assert.equal(handlerCalls, 0);
      assert.equal(auditLog.isReady(), false);
    }
  );
});

test("生产关键写入先耐久记录最小审计意图，再执行处理器、持久化和完成记录", async () => {
  const sequence: string[] = [];
  const auditEntries: Array<Record<string, unknown>> = [];
  const auditLog = new SystemAuditLogService({
    appendAuditLog: (entry) => {
      const phase = (entry.metadata as Record<string, unknown> | undefined)?.auditPhase;
      sequence.push(`audit:${typeof phase === "string" ? phase : "normal"}`);
      auditEntries.push(entry as unknown as Record<string, unknown>);
      return "test-system-audit.ndjson";
    },
    reportFailure: () => undefined
  });
  auditLog.initialize();
  sequence.length = 0;
  auditEntries.length = 0;

  await withEnvironment(
    {
      NODE_ENV: "production",
      APP_ENV: "production"
    },
    async () => {
      const interceptor = new PersistenceInterceptor({
        isPersistedStateIntegrityReady: () => true,
        persist: () => {
          sequence.push("persist");
        }
      } as InMemoryStoreService, auditLog);

      const response = await firstValueFrom(
        interceptor.intercept(
          createContext({ method: "POST", path: "/api/example?private=value" }),
          {
            handle: () => {
              sequence.push("handler");
              return of({ data: "business-result" });
            }
          } as CallHandler
        )
      );

      assert.deepEqual(response, { data: "business-result" });
      assert.deepEqual(sequence.slice(0, 4), [
        "audit:intent",
        "handler",
        "persist",
        "audit:completed"
      ]);
      const intent = auditEntries.find(
        (entry) => (entry.metadata as Record<string, unknown> | undefined)?.auditPhase === "intent"
      );
      assert.ok(intent);
      assert.equal(intent.path, "/api/example");
      assert.equal(intent.body, undefined);
      assert.equal(intent.query, undefined);
      assert.equal(JSON.stringify(intent).includes("private=value"), false);
      assert.equal(auditLog.isReady(), true);
    }
  );
});

test("生产关键写入完成审计失败保留已完成结果，但锁存后续请求", async () => {
  let failCompletion = false;
  const auditLog = new SystemAuditLogService({
    appendAuditLog: (entry) => {
      const phase = (entry.metadata as Record<string, unknown> | undefined)?.auditPhase;
      if (phase === "completed" && failCompletion) {
        throw new Error("audit-completion-failed");
      }
      return "test-system-audit.ndjson";
    },
    reportFailure: () => undefined
  });
  auditLog.initialize();
  let persistedCount = 0;
  let handlerCalls = 0;

  await withEnvironment(
    {
      NODE_ENV: "production",
      APP_ENV: "production"
    },
    async () => {
      const interceptor = new PersistenceInterceptor({
        isPersistedStateIntegrityReady: () => true,
        persist: () => {
          persistedCount += 1;
        }
      } as InMemoryStoreService, auditLog);
      failCompletion = true;

      const response = await firstValueFrom(
        interceptor.intercept(
          createContext({ method: "POST", path: "/api/example" }),
          {
            handle: () => {
              handlerCalls += 1;
              return of({ data: "already-completed" });
            }
          } as CallHandler
        )
      );
      assert.deepEqual(response, { data: "already-completed" });
      assert.equal(persistedCount, 1);
      assert.equal(handlerCalls, 1);
      assert.equal(auditLog.isReady(), false);

      await assert.rejects(
        firstValueFrom(
          interceptor.intercept(
            createContext({ method: "GET", path: "/api/public-config" }),
            { handle: () => of({ data: "must-not-run" }) } as CallHandler
          )
        ),
        (error: unknown) =>
          error instanceof ServiceUnavailableException && error.getStatus() === 503
      );
    }
  );
});

test("审计日志不可写时不覆盖原始业务异常", async (t) => {
  const directory = mkdtempSync(join(tmpdir(), "vm-persistence-interceptor-error-"));
  const blocker = join(directory, "not-a-directory");
  writeFileSync(blocker, "blocker", "utf8");
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const originalError = new Error("original-business-error");

  await withEnvironment(
    {
      NODE_ENV: "test",
      APP_ENV: undefined,
      SYSTEM_LOG_FILE: join(blocker, "system-audit.ndjson")
    },
    async () => {
      const interceptor = new PersistenceInterceptor({
        isPersistedStateIntegrityReady: () => true,
        persist: () => undefined
      } as InMemoryStoreService);

      await assert.rejects(
        firstValueFrom(
          interceptor.intercept(
            createContext({ method: "POST", path: "/api/example" }),
            { handle: () => throwError(() => originalError) } as CallHandler
          )
        ),
        (error: unknown) => error === originalError
      );
    }
  );
});

test("审计日志格式化失败不覆盖原始业务异常，且锁存审计状态", async () => {
  const originalError = new Error("original-business-error");
  const auditLog = new SystemAuditLogService({
    appendAuditLog: () => "test-system-audit.ndjson",
    reportFailure: () => undefined
  });
  auditLog.initialize();

  await withEnvironment(
    {
      NODE_ENV: "test",
      APP_ENV: undefined
    },
    async () => {
      const interceptor = new PersistenceInterceptor({
        isPersistedStateIntegrityReady: () => true,
        persist: () => undefined
      } as InMemoryStoreService, auditLog);

      await assert.rejects(
        firstValueFrom(
          interceptor.intercept(
            createContext({
              method: "POST",
              path: "/api/example",
              getHeader: () => {
                throw new Error("audit-formatter-failed");
              }
            }),
            { handle: () => throwError(() => originalError) } as CallHandler
          )
        ),
        (error: unknown) => error === originalError
      );
      assert.equal(auditLog.isReady(), false);
    }
  );
});
