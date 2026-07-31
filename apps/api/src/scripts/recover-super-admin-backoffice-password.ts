import { InMemoryStoreService } from "../common/store/in-memory-store.service.js";
import { resolveRuntimeDataPlane } from "../common/config/runtime-data-plane.js";
import { acquireFinancialSingleWriterForMaintenance } from "../common/coordination/financial-single-writer-runtime.js";
import { resolveRuntimeStoragePaths } from "../common/store/persistence.js";
import { assertRuntimePathsSafe } from "../common/store/runtime-path-safety.js";
import { SystemAuditLogService } from "../common/store/system-audit-log.service.js";
import {
  assertSuperAdminBackofficePasswordRecoveryTarget,
  recoverSuperAdminBackofficePassword
} from "../modules/auth/first-super-admin-password.js";
import { assertBackofficePasswordMaintenanceServiceContext } from "./first-backoffice-password-maintenance-context.js";
import {
  assertInteractiveLocalPasswordTerminal,
  readConfirmedPassword,
  readHiddenLine
} from "./local-tty-password-input.js";

const assertRecoveryConfirmation = async () => {
  const confirmation = await readHiddenLine(
    "输入 RESET SUPER ADMIN 确认恢复唯一服务商超级管理员（输入不回显）："
  );

  if (confirmation !== "RESET SUPER ADMIN") {
    throw new Error("恢复确认文本不匹配，未修改任何数据。");
  }
};

const main = async () => {
  if (process.argv.length !== 2) {
    throw new Error("本命令不接受参数；恢复密码只能从服务器 VNC 本机终端安全输入。");
  }

  assertInteractiveLocalPasswordTerminal("服务商超级管理员密码恢复");
  assertBackofficePasswordMaintenanceServiceContext();

  const dataPlane = resolveRuntimeDataPlane();
  const runtimePaths = resolveRuntimeStoragePaths();
  assertRuntimePathsSafe({
    dataFile: runtimePaths.dataFile,
    systemLogFile: runtimePaths.systemLogFile,
    uploadDir: runtimePaths.uploadDir,
    backupDir: runtimePaths.backupDir,
    financialLeaseFile: runtimePaths.financialLeaseFile
  });

  // 先做只读预检，避免目标身份不唯一时索取任何确认或口令。
  assertSuperAdminBackofficePasswordRecoveryTarget(new InMemoryStoreService());
  // 先取得写租约，避免租约不可用时仍要求操作员输入确认或机密。
  const financialWriter = acquireFinancialSingleWriterForMaintenance();

  try {
    await assertRecoveryConfirmation();
    const password = await readConfirmedPassword({
      prompt: "为唯一服务商超级管理员设置恢复密码（输入不回显）：",
      confirmationPrompt: "再次输入同一恢复密码确认："
    });
    const store = new InMemoryStoreService();
    // 取得单写租约后再次校验，避免预检和写入之间的目标状态变化。
    assertSuperAdminBackofficePasswordRecoveryTarget(store);

    const auditLog = new SystemAuditLogService();
    const operation = auditLog.beginCriticalIntent({
      method: "SYSTEM",
      path: "/internal/backoffice/recover-super-admin-password",
      metadata: {
        action: "recover-super-admin-backoffice-password",
        dataPlane,
        recoveryMethod: "local-tty"
      }
    });

    try {
      const result = recoverSuperAdminBackofficePassword(store, password);
      store.persist();

      if (
        !auditLog.completeCriticalOperation(operation, {
          method: "SYSTEM",
          path: "/internal/backoffice/recover-super-admin-password",
          statusCode: 200,
          durationMs: Math.max(0, Date.now() - operation.startedAt),
          outcome: "completed",
          metadata: {
            action: "recover-super-admin-backoffice-password",
            dataPlane,
            recoveryMethod: "local-tty",
            revokedSessionCount: result.revokedSessionCount
          }
        })
      ) {
        throw new Error(
          "服务商超级管理员密码恢复完成记录写入失败；请保留现场并检查系统审计日志。"
        );
      }

      console.log(
        "服务商超级管理员密码已恢复；全部旧会话已撤销。请等待 API 恢复后使用新密码登录。"
      );
    } catch (error) {
      auditLog.completeCriticalOperation(operation, {
        method: "SYSTEM",
        path: "/internal/backoffice/recover-super-admin-password",
        statusCode: 500,
        durationMs: Math.max(0, Date.now() - operation.startedAt),
        outcome: "failed",
        metadata: {
          action: "recover-super-admin-backoffice-password",
          dataPlane,
          recoveryMethod: "local-tty"
        }
      });
      throw error;
    }
  } finally {
    financialWriter.release();
  }
};

void main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
