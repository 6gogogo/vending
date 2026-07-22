import assert from "node:assert/strict";
import test from "node:test";

import {
  SystemAuditLogService,
  type SystemAuditLogRuntimeAdapter
} from "../src/common/store/system-audit-log.service.js";

const createEntry = () => ({
  occurredAt: "2026-07-22T00:00:00.000Z",
  method: "POST",
  path: "/api/example",
  statusCode: 200,
  durationMs: 1
});

test("系统审计日志服务启动意图写入成功后保持审计可写", () => {
  const entries: unknown[] = [];
  const service = new SystemAuditLogService({
    appendAuditLog: (entry) => {
      entries.push(entry);
      return "test-system-audit.ndjson";
    }
  } satisfies SystemAuditLogRuntimeAdapter);

  assert.equal(service.getStatus(), "unverified");
  assert.doesNotThrow(() => service.initialize());
  assert.equal(service.getStatus(), "ready");
  assert.equal(service.isReady(), true);
  assert.equal(entries.length, 1);
  assert.equal(service.appendSafely(createEntry()), true);
  assert.equal(entries.length, 2);
});

test("启动审计先写最小意图，并在监听成功后补写完成终态", () => {
  const entries: Array<Record<string, unknown>> = [];
  const service = new SystemAuditLogService({
    appendAuditLog: (entry) => {
      entries.push(entry as unknown as Record<string, unknown>);
      return "test-system-audit.ndjson";
    }
  } satisfies SystemAuditLogRuntimeAdapter);

  const startup = service.initialize();

  assert.ok(startup);
  assert.equal(entries.length, 1);
  assert.equal(entries[0]!.method, "SYSTEM");
  assert.equal(entries[0]!.path, "/internal/system-audit-log/startup");
  assert.equal(entries[0]!.statusCode, 202);
  assert.equal(
    (entries[0]!.metadata as Record<string, unknown>).auditPhase,
    "intent"
  );
  assert.equal(service.completeStartup(startup), true);
  assert.equal(entries.length, 2);
  assert.equal(entries[1]!.statusCode, 200);
  assert.equal(
    (entries[1]!.metadata as Record<string, unknown>).auditPhase,
    "completed"
  );
});

test("启动前置步骤失败时只补写无原始错误的失败终态", () => {
  const entries: Array<Record<string, unknown>> = [];
  const service = new SystemAuditLogService({
    appendAuditLog: (entry) => {
      entries.push(entry as unknown as Record<string, unknown>);
      return "test-system-audit.ndjson";
    }
  } satisfies SystemAuditLogRuntimeAdapter);

  const startup = service.initialize();

  assert.ok(startup);
  assert.equal(service.failStartup(startup), true);
  assert.equal(entries.length, 2);
  assert.equal(entries[1]!.method, "SYSTEM");
  assert.equal(entries[1]!.path, "/internal/system-audit-log/startup");
  assert.equal(entries[1]!.statusCode, 500);
  assert.equal(
    (entries[1]!.metadata as Record<string, unknown>).auditPhase,
    "failed"
  );
  assert.equal(entries[1]!.body, undefined);
  assert.equal(entries[1]!.query, undefined);
  assert.equal(entries[1]!.error, undefined);
  assert.equal(
    (entries[1]!.metadata as Record<string, unknown>).error,
    undefined
  );
  assert.equal(service.completeStartup(startup), false);
});

test("系统审计日志首次写入失败后粘性关闭，且不泄露底层错误", () => {
  let attempts = 0;
  let reports = 0;
  const service = new SystemAuditLogService({
    appendAuditLog: () => {
      attempts += 1;
      throw new Error("private-filesystem-path");
    },
    reportFailure: () => {
      reports += 1;
    }
  } satisfies SystemAuditLogRuntimeAdapter);

  assert.equal(service.appendSafely(createEntry()), false);
  assert.equal(service.getStatus(), "failed");
  assert.equal(service.isReady(), false);
  assert.equal(attempts, 1);
  assert.equal(reports, 1);
  assert.equal(service.appendSafely(createEntry()), false);
  assert.equal(attempts, 1);
  assert.equal(reports, 1);
  assert.throws(() => service.initialize(), /系统审计日志不可用/);
});

test("审计故障报告器自身异常不能覆盖原始业务结果", () => {
  const service = new SystemAuditLogService({
    appendAuditLog: () => {
      throw new Error("audit-write-failed");
    },
    reportFailure: () => {
      throw new Error("reporter-failed");
    }
  } satisfies SystemAuditLogRuntimeAdapter);

  assert.doesNotThrow(() => service.appendSafely(createEntry()));
  assert.equal(service.getStatus(), "failed");
});

test("关键审计意图只写入最小字段，并在写入失败时拒绝后续副作用", () => {
  const entries: Array<Record<string, unknown>> = [];
  const service = new SystemAuditLogService({
    appendAuditLog: (entry) => {
      entries.push(entry as unknown as Record<string, unknown>);
      return "test-system-audit.ndjson";
    }
  });
  const marker = "private-audit-marker";

  const operation = service.beginCriticalIntent({
    method: "PATCH",
    path: "/api/system-settings",
    actorUserId: "operator-1",
    metadata: { action: "update-settings" }
  });
  const intent = entries[0]!;
  assert.equal(intent.body, undefined);
  assert.equal(intent.query, undefined);
  assert.equal(JSON.stringify(intent).includes(marker), false);
  assert.equal(
    (intent.metadata as Record<string, unknown>).auditPhase,
    "intent"
  );
  assert.equal(typeof operation.operationId, "string");

  assert.equal(
    service.completeCriticalOperation(operation, {
      method: "PATCH",
      path: "/api/system-settings",
      statusCode: 200,
      durationMs: 1,
      outcome: "completed"
    }),
    true
  );
  assert.equal(
    (entries[1]!.metadata as Record<string, unknown>).auditPhase,
    "completed"
  );
});

test("关键审计意图写入失败时抛出泛化 503 且服务锁存失败", () => {
  const service = new SystemAuditLogService({
    appendAuditLog: () => {
      throw new Error("private-audit-write-failed");
    },
    reportFailure: () => undefined
  });

  assert.throws(
    () =>
      service.beginCriticalIntent({
        method: "POST",
        path: "/api/payment"
      }),
    (error: unknown) =>
      typeof error === "object" && error !== null && "getStatus" in error &&
      (error as { getStatus: () => number }).getStatus() === 503
  );
  assert.equal(service.isReady(), false);
});

test("同一关键操作只接受一次终态记录", () => {
  const entries: Array<Record<string, unknown>> = [];
  const service = new SystemAuditLogService({
    appendAuditLog: (entry) => {
      entries.push(entry as unknown as Record<string, unknown>);
      return "test-system-audit.ndjson";
    }
  });
  const operation = service.beginCriticalIntent({
    method: "POST",
    path: "/api/example"
  });
  const completion = {
    method: "POST",
    path: "/api/example",
    statusCode: 200,
    durationMs: 1,
    outcome: "completed" as const
  };

  assert.equal(service.completeCriticalOperation(operation, completion), true);
  assert.equal(service.completeCriticalOperation(operation, completion), false);
  assert.equal(
    service.completeCriticalOperation(
      { ...operation },
      completion
    ),
    false
  );
  assert.equal(
    entries.filter(
      (entry) => (entry.metadata as Record<string, unknown> | undefined)?.auditPhase === "completed"
    ).length,
    1
  );
});
