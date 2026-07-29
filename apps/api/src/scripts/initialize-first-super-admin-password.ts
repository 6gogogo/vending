import { InMemoryStoreService } from "../common/store/in-memory-store.service.js";
import { acquireFinancialSingleWriterForMaintenance } from "../common/coordination/financial-single-writer-runtime.js";
import { SystemAuditLogService } from "../common/store/system-audit-log.service.js";
import {
  assertFirstSuperAdminPasswordTarget,
  initializeFirstSuperAdminPassword
} from "../modules/auth/first-super-admin-password.js";
import { assertFirstSuperAdminPasswordMaintenancePreflight } from "./first-super-admin-password-maintenance-preflight.js";
import { readConfirmedPassword } from "./local-tty-password-input.js";

const main = async () => {
  if (process.argv.length !== 2) {
    throw new Error("本命令不接受参数；首次密码只能从服务器 VNC 本机终端安全输入。");
  }

  // 在输入密码前先完成只读预检，避免不安全或无效状态下索取机密。
  const { dataPlane } = assertFirstSuperAdminPasswordMaintenancePreflight(
    "服务商超级管理员首次密码维护"
  );
  // 先取得写租约，租约不可用时不索取任何密码。
  const financialWriter = acquireFinancialSingleWriterForMaintenance();

  try {
    const store = new InMemoryStoreService();
    // 取得租约后再次检查，防止预检与实际写入之间的状态漂移。
    assertFirstSuperAdminPasswordTarget(store);
    const password = await readConfirmedPassword({
      prompt: "为服务商超级管理员设置首次后台密码（输入不回显）：",
      confirmationPrompt: "再次输入同一密码确认："
    });
    assertFirstSuperAdminPasswordTarget(store);

    const auditLog = new SystemAuditLogService();
    const operation = auditLog.beginCriticalIntent({
      method: "SYSTEM",
      path: "/internal/backoffice/initialize-first-super-admin-password",
      metadata: {
        action: "initialize-first-super-admin-password",
        dataPlane,
        inputMethod: "local-tty"
      }
    });

    try {
      const result = initializeFirstSuperAdminPassword(store, password);
      store.persist();

      if (
        !auditLog.completeCriticalOperation(operation, {
          method: "SYSTEM",
          path: "/internal/backoffice/initialize-first-super-admin-password",
          statusCode: 200,
          durationMs: Math.max(0, Date.now() - operation.startedAt),
          outcome: "completed",
          metadata: {
            action: "initialize-first-super-admin-password",
            dataPlane,
            inputMethod: "local-tty",
            revokedSessionCount: result.revokedSessionCount
          }
        })
      ) {
        throw new Error("服务商超级管理员首次改密完成记录写入失败；请保留现场并检查系统审计日志。");
      }

      console.log(
        "服务商超级管理员首次后台密码已初始化；默认密码已失效。请重新启动 API 后使用新密码登录。"
      );
    } catch (error) {
      auditLog.completeCriticalOperation(operation, {
        method: "SYSTEM",
        path: "/internal/backoffice/initialize-first-super-admin-password",
        statusCode: 500,
        durationMs: Math.max(0, Date.now() - operation.startedAt),
        outcome: "failed",
        metadata: {
          action: "initialize-first-super-admin-password",
          dataPlane,
          inputMethod: "local-tty"
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
