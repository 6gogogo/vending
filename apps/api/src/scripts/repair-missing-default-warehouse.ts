import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { acquireFinancialSingleWriterForMaintenance } from "../common/coordination/financial-single-writer-runtime.js";
import { assertLivePlatformTenantConfiguration } from "../common/config/runtime-data-plane.js";
import {
  ensureDefaultWarehouse,
  findActiveWarehouse
} from "../common/store/default-warehouse.js";
import { InMemoryStoreService } from "../common/store/in-memory-store.service.js";
import {
  PersistedStateWriteError,
  resolveRuntimeStoragePaths
} from "../common/store/persistence.js";
import { assertRuntimePathsSafe } from "../common/store/runtime-path-safety.js";
import { SystemAuditLogService } from "../common/store/system-audit-log.service.js";

const CONFIRMATION = "--confirm-backed-up-live-data";
const ACTION = "repair-missing-default-warehouse";
const AUDIT_PATH = "/internal/live-data/repair-missing-default-warehouse";

type RepairStore = Pick<
  InMemoryStoreService,
  "warehouses" | "logOperation" | "persist"
>;
type RepairAudit = Pick<
  SystemAuditLogService,
  "beginCriticalIntent" | "completeCriticalOperation"
>;

export interface DefaultWarehouseRepairResult {
  auditCompleted: boolean;
  persistenceDurabilityConfirmed: boolean;
}

export const applyDefaultWarehouseRepair = (
  store: RepairStore,
  auditLog: RepairAudit,
  now: () => number = Date.now
): DefaultWarehouseRepairResult => {
  const operation = auditLog.beginCriticalIntent({
    method: "SYSTEM",
    path: AUDIT_PATH,
    metadata: {
      action: ACTION,
      dataPlane: "live"
    }
  });
  let persistenceDurabilityConfirmed = true;

  try {
    const result = ensureDefaultWarehouse(store.warehouses);

    store.logOperation({
      category: "inventory",
      type: ACTION,
      status: "success",
      actor: {
        type: "system",
        name: "真实数据维护"
      },
      primarySubject: {
        type: "warehouse",
        id: result.warehouse.code,
        label: result.warehouse.name
      },
      metadata: {
        dataPlane: "live",
        warehouseCode: result.warehouse.code,
        undoState: "not_undoable"
      }
    });

    try {
      store.persist();
    } catch (error) {
      if (error instanceof PersistedStateWriteError && error.committed) {
        persistenceDurabilityConfirmed = false;
      } else {
        throw error;
      }
    }
  } catch (error) {
    auditLog.completeCriticalOperation(operation, {
      method: "SYSTEM",
      path: AUDIT_PATH,
      statusCode: 500,
      durationMs: Math.max(0, now() - operation.startedAt),
      outcome: "failed",
      metadata: {
        action: ACTION,
        dataPlane: "live"
      }
    });
    throw error;
  }

  const auditCompleted = auditLog.completeCriticalOperation(operation, {
    method: "SYSTEM",
    path: AUDIT_PATH,
    statusCode: 200,
    durationMs: Math.max(0, now() - operation.startedAt),
    outcome: "completed",
    metadata: {
      action: ACTION,
      dataPlane: "live"
    }
  });

  return {
    auditCompleted,
    persistenceDurabilityConfirmed
  };
};

const main = () => {
  const runtimePaths = resolveRuntimeStoragePaths();

  assertRuntimePathsSafe({
    dataFile: runtimePaths.dataFile,
    systemLogFile: runtimePaths.systemLogFile,
    uploadDir: runtimePaths.uploadDir,
    backupDir: runtimePaths.backupDir,
    financialLeaseFile: runtimePaths.financialLeaseFile
  });

  if (runtimePaths.dataPlane !== "live") {
    throw new Error("默认仓库修复命令只能在 VM_DATA_PLANE=live 时执行。");
  }

  if (process.argv.length !== 3 || process.argv[2] !== CONFIRMATION) {
    console.error(
      `已阻止改写真实数据。请先完成并校验备份，再显式追加 ${CONFIRMATION}。`
    );
    process.exit(2);
  }

  const financialWriter = acquireFinancialSingleWriterForMaintenance();

  try {
    const store = new InMemoryStoreService();
    const identity = store.getRuntimeDataPlaneIdentity();

    if (
      identity.dataPlane !== "live" ||
      identity.initializationSource !== "live-bootstrap"
    ) {
      throw new Error("仅允许修复已完成受控初始化的真实数据平面。");
    }

    assertLivePlatformTenantConfiguration(store.platformTenants);

    if (findActiveWarehouse(store.warehouses)) {
      console.log("已存在启用的本地仓库，无需重复修复。");
      return;
    }

    if (store.warehouses.length > 0) {
      throw new Error("检测到仓库记录但均已停用，已拒绝自动改变仓库运营状态。");
    }

    const result = applyDefaultWarehouseRepair(store, new SystemAuditLogService());

    if (!result.auditCompleted) {
      console.error(
        "默认本地仓库已补建，但完成审计记录失败；请修复审计介质并重启服务，不要重复执行修复命令。"
      );
      process.exitCode = 1;
      return;
    }

    if (!result.persistenceDurabilityConfirmed) {
      console.error(
        "默认本地仓库已补建并写入完成审计，但数据目录同步未确认；请校验运行数据并重启服务，不要重复执行修复命令。"
      );
      process.exitCode = 1;
      return;
    }

    console.log("默认本地仓库已补建并完成审计记录。");
  } finally {
    financialWriter.release();
  }
};

const executedDirectly =
  typeof process.argv[1] === "string" &&
  resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));

if (executedDirectly) {
  try {
    main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
