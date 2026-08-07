import { acquireFinancialSingleWriterForMaintenance } from "../common/coordination/financial-single-writer-runtime.js";
import { assertLivePlatformTenantConfiguration } from "../common/config/runtime-data-plane.js";
import {
  ensureDefaultWarehouse,
  findActiveWarehouse
} from "../common/store/default-warehouse.js";
import { InMemoryStoreService } from "../common/store/in-memory-store.service.js";
import { resolveRuntimeStoragePaths } from "../common/store/persistence.js";
import { assertRuntimePathsSafe } from "../common/store/runtime-path-safety.js";
import { SystemAuditLogService } from "../common/store/system-audit-log.service.js";

const CONFIRMATION = "--confirm-backed-up-live-data";
const ACTION = "repair-missing-default-warehouse";
const AUDIT_PATH = "/internal/live-data/repair-missing-default-warehouse";

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

    const auditLog = new SystemAuditLogService();
    const operation = auditLog.beginCriticalIntent({
      method: "SYSTEM",
      path: AUDIT_PATH,
      metadata: {
        action: ACTION,
        dataPlane: "live"
      }
    });

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
      store.persist();

      if (
        !auditLog.completeCriticalOperation(operation, {
          method: "SYSTEM",
          path: AUDIT_PATH,
          statusCode: 200,
          durationMs: Math.max(0, Date.now() - operation.startedAt),
          outcome: "completed",
          metadata: {
            action: ACTION,
            dataPlane: "live"
          }
        })
      ) {
        throw new Error("默认仓库修复完成审计记录失败。");
      }

      console.log("默认本地仓库已补建并完成审计记录。");
    } catch (error) {
      auditLog.completeCriticalOperation(operation, {
        method: "SYSTEM",
        path: AUDIT_PATH,
        statusCode: 500,
        durationMs: Math.max(0, Date.now() - operation.startedAt),
        outcome: "failed",
        metadata: {
          action: ACTION,
          dataPlane: "live"
        }
      });
      throw error;
    }
  } finally {
    financialWriter.release();
  }
};

try {
  main();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
