import assert from "node:assert/strict";
import test from "node:test";

import { ServiceUnavailableException } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { SmartVmRequestError } from "@vm/shared-client/smartvm";

import { SystemAuditLogService } from "../src/common/store/system-audit-log.service.js";
import { SmartVmGateway } from "../src/modules/devices/smartvm.gateway.js";

test("生产 SmartVM 开门审计意图失败时，不发送外部命令", async () => {
  const auditLog = new SystemAuditLogService({
    appendAuditLog: () => {
      throw new Error("private-audit-write-failed");
    },
    reportFailure: () => undefined
  });
  const gateway = new SmartVmGateway(new ConfigService({}), auditLog);
  let externalCalls = 0;
  (gateway as unknown as {
    createClient: () => {
      openDoor: () => Promise<{ orderNo: string }>;
    };
  }).createClient = () => ({
    openDoor: async () => {
      externalCalls += 1;
      return { orderNo: "must-not-be-sent" };
    }
  });
  const previousAppEnv = process.env.APP_ENV;
  process.env.APP_ENV = "production";

  try {
    await assert.rejects(
      gateway.openDoor({
        userId: "user-audit-intent",
        eventId: "event-audit-intent",
        deviceCode: "device-audit-intent",
        phone: "13800000000"
      }),
      (error: unknown) =>
        error instanceof ServiceUnavailableException && error.getStatus() === 503
    );
    assert.equal(externalCalls, 0);
  } finally {
    if (previousAppEnv === undefined) {
      delete process.env.APP_ENV;
    } else {
      process.env.APP_ENV = previousAppEnv;
    }
  }
});

test("SmartVM 超时与明确拒绝分别记录为不确定和拒绝终态", async () => {
  const cases: Array<{
    label: string;
    error: SmartVmRequestError;
    expectedPhase: string;
  }> = [
    {
      label: "timeout",
      error: new SmartVmRequestError("timeout", 0, "/api/pay/container/opendoor", {}, { reason: "timeout" }),
      expectedPhase: "indeterminate"
    },
    {
      label: "rejected",
      error: new SmartVmRequestError(
        "rejected",
        400,
        "/api/pay/container/opendoor",
        {},
        { code: 400, message: "rejected" }
      ),
      expectedPhase: "rejected"
    },
    {
      label: "empty-2xx",
      error: new SmartVmRequestError("empty", 200, "/api/pay/container/opendoor", {}, ""),
      expectedPhase: "indeterminate"
    },
    {
      label: "non-json-2xx",
      error: new SmartVmRequestError("non-json", 200, "/api/pay/container/opendoor", {}, "<html>proxy</html>"),
      expectedPhase: "indeterminate"
    },
    {
      label: "missing-code-2xx",
      error: new SmartVmRequestError(
        "missing-code",
        200,
        "/api/pay/container/opendoor",
        {},
        { message: "missing code" }
      ),
      expectedPhase: "indeterminate"
    }
  ];
  const previousAppEnv = process.env.APP_ENV;
  process.env.APP_ENV = "production";

  try {
    for (const testCase of cases) {
      const entries: Array<Record<string, unknown>> = [];
      const auditLog = new SystemAuditLogService({
        appendAuditLog: (entry) => {
          entries.push(entry as unknown as Record<string, unknown>);
          return "test-system-audit.ndjson";
        }
      });
      const gateway = new SmartVmGateway(new ConfigService({}), auditLog);
      (gateway as unknown as {
        createClient: () => {
          openDoor: () => Promise<never>;
        };
      }).createClient = () => ({
        openDoor: async () => {
          throw testCase.error;
        }
      });

      await assert.rejects(
        gateway.openDoor({
          userId: "user-audit-phase",
          eventId: `event-audit-${testCase.label}`,
          deviceCode: "device-audit-phase",
          phone: "13800000000"
        }),
        (error: unknown) => error === testCase.error
      );
      assert.equal(
        entries.some(
          (entry) =>
            (entry.metadata as Record<string, unknown> | undefined)?.auditPhase === testCase.expectedPhase
        ),
        true,
        testCase.label
      );
    }
  } finally {
    if (previousAppEnv === undefined) {
      delete process.env.APP_ENV;
    } else {
      process.env.APP_ENV = previousAppEnv;
    }
  }
});
