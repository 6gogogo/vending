import { InMemoryStoreService } from "../common/store/in-memory-store.service.js";
import { acquireFinancialSingleWriterForMaintenance } from "../common/coordination/financial-single-writer-runtime.js";
import { SystemAuditLogService } from "../common/store/system-audit-log.service.js";
import {
  assertFirstBackofficePasswordTarget,
  initializeFirstBackofficePassword
} from "../modules/auth/first-backoffice-password.js";
import { assertFirstBackofficePasswordMaintenancePreflight } from "./first-backoffice-password-maintenance-preflight.js";
import { readConfirmedPassword } from "./local-tty-password-input.js";

const main = async () => {
  if (process.argv.length !== 2) {
    throw new Error("本命令不接受参数；新密码只能从服务器 VNC 本机终端安全输入。");
  }

  // 在输入密码前做只读预检，避免账号已被修改时让操作员无谓输入机密。
  const { dataPlane } = assertFirstBackofficePasswordMaintenancePreflight(
    "首次后台密码"
  );
  // 先取得写租约，避免租约不可用时仍要求操作员输入机密。
  const financialWriter = acquireFinancialSingleWriterForMaintenance();

  try {
    const password = await readConfirmedPassword({
      prompt: "为 admin 设置首次后台密码（输入不回显）：",
      confirmationPrompt: "再次输入同一密码确认："
    });
    const store = new InMemoryStoreService();
    // 取得租约后再次检查，防止预检与实际写入之间被其他维护操作抢先修改。
    assertFirstBackofficePasswordTarget(store);

    const auditLog = new SystemAuditLogService();
    const operation = auditLog.beginCriticalIntent({
      method: "SYSTEM",
      path: "/internal/backoffice/initialize-first-password",
      metadata: {
        action: "initialize-first-backoffice-password",
        username: "admin",
        dataPlane,
        inputMethod: "local-tty"
      }
    });

    try {
      const result = initializeFirstBackofficePassword(store, password);
      store.persist();

      if (
        !auditLog.completeCriticalOperation(operation, {
          method: "SYSTEM",
          path: "/internal/backoffice/initialize-first-password",
          statusCode: 200,
          durationMs: Math.max(0, Date.now() - operation.startedAt),
          outcome: "completed",
          metadata: {
            action: "initialize-first-backoffice-password",
            username: result.credential.username,
            dataPlane,
            inputMethod: "local-tty",
            revokedSessionCount: result.revokedSessionCount
          }
        })
      ) {
        throw new Error("首次后台密码初始化完成记录写入失败；请保留现场并检查系统审计日志。");
      }

      console.log("admin 首次后台密码已初始化；默认密码已失效。请重新启动 API 后使用新密码登录。");
    } catch (error) {
      auditLog.completeCriticalOperation(operation, {
        method: "SYSTEM",
        path: "/internal/backoffice/initialize-first-password",
        statusCode: 500,
        durationMs: Math.max(0, Date.now() - operation.startedAt),
        outcome: "failed",
        metadata: {
          action: "initialize-first-backoffice-password",
          username: "admin",
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
