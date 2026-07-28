import { InMemoryStoreService } from "../common/store/in-memory-store.service.js";
import { acquireFinancialSingleWriterForMaintenance } from "../common/coordination/financial-single-writer-runtime.js";
import { SystemAuditLogService } from "../common/store/system-audit-log.service.js";
import {
  assertAdminBackofficePasswordMaintenanceTarget,
  assertCurrentAdminBackofficePassword,
  assertFirstBackofficePasswordTarget,
  changeAdminBackofficePasswordWithCurrentPassword,
  isAdminBackofficePasswordAwaitingInitialization,
  initializeFirstBackofficePassword
} from "../modules/auth/first-backoffice-password.js";
import { assertFirstBackofficePasswordMaintenancePreflight } from "./first-backoffice-password-maintenance-preflight.js";
import { readConfirmedPassword, readHiddenLine } from "./local-tty-password-input.js";

const main = async () => {
  if (process.argv.length !== 2) {
    throw new Error("本命令不接受参数；新密码只能从服务器 VNC 本机终端安全输入。");
  }

  // 在输入密码前做只读预检，避免账号无效或运行上下文不安全时让操作员无谓输入机密。
  const { dataPlane } = assertFirstBackofficePasswordMaintenancePreflight("admin 后台密码维护");
  // 先取得写租约，避免租约不可用时仍要求操作员输入机密。
  const financialWriter = acquireFinancialSingleWriterForMaintenance();

  try {
    const store = new InMemoryStoreService();
    // 取得租约后再次检查，防止预检与实际写入之间被其他维护操作抢先修改。
    const target = assertAdminBackofficePasswordMaintenanceTarget(store);
    const needsInitialization = isAdminBackofficePasswordAwaitingInitialization(target);
    const action = needsInitialization
      ? "initialize-first-backoffice-password"
      : "change-admin-backoffice-password-with-current-password";
    const path = needsInitialization
      ? "/internal/backoffice/initialize-first-password"
      : "/internal/backoffice/change-password-with-current-password";
    let password: string;
    let currentPassword: string | undefined;

    if (needsInitialization) {
      password = await readConfirmedPassword({
        prompt: "为 admin 设置首次后台密码（输入不回显）：",
        confirmationPrompt: "再次输入同一密码确认："
      });
      assertFirstBackofficePasswordTarget(store);
    } else {
      currentPassword = await readHiddenLine("输入当前 admin 密码以验证（输入不回显）：");
      // 先验证当前密码；不通过时不会再索取新密码，也不会写入任何数据。
      assertCurrentAdminBackofficePassword(store, currentPassword);
      password = await readConfirmedPassword({
        prompt: "当前密码验证通过。输入新的 admin 密码（输入不回显）：",
        confirmationPrompt: "再次输入同一新密码确认："
      });
    }

    const auditLog = new SystemAuditLogService();
    const operation = auditLog.beginCriticalIntent({
      method: "SYSTEM",
      path,
      metadata: {
        action,
        username: "admin",
        dataPlane,
        inputMethod: needsInitialization ? "local-tty" : "local-tty-current-password"
      }
    });

    try {
      const result = needsInitialization
        ? initializeFirstBackofficePassword(store, password)
        : changeAdminBackofficePasswordWithCurrentPassword(
            store,
            currentPassword ?? "",
            password
          );
      store.persist();

      if (
        !auditLog.completeCriticalOperation(operation, {
          method: "SYSTEM",
          path,
          statusCode: 200,
          durationMs: Math.max(0, Date.now() - operation.startedAt),
          outcome: "completed",
          metadata: {
            action,
            username: result.credential.username,
            dataPlane,
            inputMethod: needsInitialization ? "local-tty" : "local-tty-current-password",
            revokedSessionCount: result.revokedSessionCount
          }
        })
      ) {
        throw new Error("admin 后台密码维护完成记录写入失败；请保留现场并检查系统审计日志。");
      }

      console.log(
        needsInitialization
          ? "admin 首次后台密码已初始化；默认密码已失效。请重新启动 API 后使用新密码登录。"
          : "admin 当前密码已验证并更新；全部旧会话已撤销。请重新启动 API 后使用新密码登录。"
      );
    } catch (error) {
      auditLog.completeCriticalOperation(operation, {
        method: "SYSTEM",
        path,
        statusCode: 500,
        durationMs: Math.max(0, Date.now() - operation.startedAt),
        outcome: "failed",
        metadata: {
          action,
          username: "admin",
          dataPlane,
          inputMethod: needsInitialization ? "local-tty" : "local-tty-current-password"
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
