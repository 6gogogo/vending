import assert from "node:assert/strict";
import test from "node:test";

import type { ConfigService } from "@nestjs/config";

import { SystemAuditLogService } from "../src/common/store/system-audit-log.service";
import {
  InstanceRuntimeControlService,
  type InstanceRestartRuntimeAdapter
} from "../src/modules/system-settings/instance-runtime-control.service";

const createService = (options?: {
  dataPlane?: string;
  tenantName?: string;
  available?: boolean;
}) => {
  const scheduledOperationIds: string[] = [];
  const auditEntries: unknown[] = [];
  const values = new Map<string, string>([
    ["VM_DATA_PLANE", options?.dataPlane ?? "live"],
    ["VM_PLATFORM_TENANT_NAME", options?.tenantName ?? "小柜大爱"]
  ]);
  const configService = {
    get: (key: string) => values.get(key)
  } as unknown as ConfigService;
  const auditLog = new SystemAuditLogService({
    appendAuditLog: (entry) => {
      auditEntries.push(entry);
      return "";
    }
  });
  const runtimeAdapter: InstanceRestartRuntimeAdapter = {
    isAvailable: () => options?.available ?? true,
    scheduleRestart: (operationId) => {
      scheduledOperationIds.push(operationId);
    }
  };

  return {
    service: new InstanceRuntimeControlService(configService, auditLog, runtimeAdapter),
    scheduledOperationIds,
    auditEntries
  };
};

const providerActor = {
  id: "provider-user",
  role: "admin" as const,
  backofficeRole: "super_admin" as const,
  tenantId: "tenant-live"
};

test("服务商进入正式实例后可安排固定目标重启并留下双阶段审计", () => {
  const { service, scheduledOperationIds, auditEntries } = createService();

  assert.deepEqual(service.getStatus(providerActor), {
    available: true,
    tenantName: "小柜大爱",
    scope: "current-instance",
    activeService: "API 应用"
  });
  const result = service.scheduleRestart(
    {
      tenantNameConfirmation: "小柜大爱",
      reason: "更新短信登录服务配置"
    },
    providerActor
  );

  assert.equal(scheduledOperationIds.length, 1);
  assert.equal(scheduledOperationIds[0], result.operationId);
  assert.equal(result.status, "scheduled");
  assert.equal(result.expectedReadyWithinSeconds, 30);
  assert.equal(auditEntries.length, 2);
  assert.doesNotMatch(JSON.stringify(auditEntries), /更新短信登录服务配置/u);
});

test("实例管理员、错误实例名、非正式数据面和不可用运行器都不能重启", () => {
  const instanceAdmin = { ...providerActor, backofficeRole: "admin" as const };
  const enabled = createService();
  assert.throws(
    () => enabled.service.getStatus(instanceAdmin),
    /只有服务提供商进入当前实例后才能使用快捷重启/
  );
  assert.throws(
    () =>
      enabled.service.scheduleRestart(
        { tenantNameConfirmation: "其他实例", reason: "确认配置生效" },
        providerActor
      ),
    /实例名称确认不一致/
  );
  assert.equal(enabled.scheduledOperationIds.length, 0);

  assert.throws(
    () => createService({ dataPlane: "simulation" }).service.getStatus(providerActor),
    /仅正式实例支持快捷重启/
  );
  assert.throws(
    () =>
      createService({ available: false }).service.scheduleRestart(
        { tenantNameConfirmation: "小柜大爱", reason: "确认配置生效" },
        providerActor
      ),
    /当前部署未启用快捷重启/
  );
});
