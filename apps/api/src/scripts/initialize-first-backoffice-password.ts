import { InMemoryStoreService } from "../common/store/in-memory-store.service.js";
import { resolveRuntimeDataPlane } from "../common/config/runtime-data-plane.js";
import { acquireFinancialSingleWriterForMaintenance } from "../common/coordination/financial-single-writer-runtime.js";
import { resolveRuntimeStoragePaths } from "../common/store/persistence.js";
import { assertRuntimePathsSafe } from "../common/store/runtime-path-safety.js";
import { SystemAuditLogService } from "../common/store/system-audit-log.service.js";
import {
  assertFirstBackofficePasswordTarget,
  initializeFirstBackofficePassword
} from "../modules/auth/first-backoffice-password.js";
import { assertFirstBackofficePasswordMaintenanceServiceContext } from "./first-backoffice-password-maintenance-context.js";

const assertInteractiveTerminal = () => {
  if (!process.stdin.isTTY || !process.stdout.isTTY || typeof process.stdin.setRawMode !== "function") {
    throw new Error("首次后台密码只能在服务器 VNC 本机交互终端中输入，不能经 SSH、管道或命令参数传入。");
  }
};

const readHiddenLine = (prompt: string) =>
  new Promise<string>((resolve, reject) => {
    const previousRawMode = process.stdin.isRaw;
    let value = "";

    const cleanup = () => {
      process.stdin.off("data", onData);
      process.stdin.setRawMode(previousRawMode);
      process.stdin.pause();
    };

    const finish = (result: string) => {
      cleanup();
      process.stdout.write("\n");
      resolve(result);
    };

    const fail = (error: Error) => {
      cleanup();
      process.stdout.write("\n");
      reject(error);
    };

    const onData = (chunk: Buffer) => {
      for (const character of chunk.toString("utf8")) {
        if (character === "\u0003") {
          fail(new Error("已取消首次后台密码初始化。"));
          return;
        }

        if (character === "\r" || character === "\n") {
          finish(value);
          return;
        }

        if (character === "\b" || character === "\u007f") {
          value = value.slice(0, -1);
          continue;
        }

        if (character >= " ") {
          value += character;
        }
      }
    };

    process.stdout.write(prompt);
    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.on("data", onData);
  });

const readConfirmedPassword = async () => {
  const password = await readHiddenLine("为 admin 设置首次后台密码（输入不回显）：");
  const confirmation = await readHiddenLine("再次输入同一密码确认：");

  if (password !== confirmation) {
    throw new Error("两次输入的密码不一致，未修改任何数据。");
  }

  return password;
};

const main = async () => {
  if (process.argv.length !== 2) {
    throw new Error("本命令不接受参数；新密码只能从服务器 VNC 本机终端安全输入。");
  }

  assertInteractiveTerminal();
  assertFirstBackofficePasswordMaintenanceServiceContext();

  const dataPlane = resolveRuntimeDataPlane();

  const runtimePaths = resolveRuntimeStoragePaths();
  assertRuntimePathsSafe({
    dataFile: runtimePaths.dataFile,
    systemLogFile: runtimePaths.systemLogFile,
    uploadDir: runtimePaths.uploadDir,
    backupDir: runtimePaths.backupDir,
    financialLeaseFile: runtimePaths.financialLeaseFile
  });

  // 在输入密码前做只读预检，避免账号已被修改时让操作员无谓输入机密。
  assertFirstBackofficePasswordTarget(new InMemoryStoreService());
  const password = await readConfirmedPassword();
  const financialWriter = acquireFinancialSingleWriterForMaintenance();

  try {
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
