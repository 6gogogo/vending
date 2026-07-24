import { randomUUID } from "node:crypto";
import { existsSync, lstatSync, readdirSync } from "node:fs";

import { InMemoryStoreService } from "../common/store/in-memory-store.service.js";
import {
  createEmptyPersistedState,
  readPersistedStateWithMetadata,
  resolveRuntimeStoragePaths,
  writePersistedState
} from "../common/store/persistence.js";
import { resolveRuntimeDataPlane } from "../common/config/runtime-data-plane.js";
import { acquireFinancialSingleWriterForMaintenance } from "../common/coordination/financial-single-writer-runtime.js";
import { SystemAuditLogService } from "../common/store/system-audit-log.service.js";
import { hashAdminPassword } from "../modules/auth/admin-password.utils.js";
import { assertRuntimePathsSafe } from "../common/store/runtime-path-safety.js";

const MIN_INITIAL_PASSWORD_LENGTH = 12;
const usernamePattern = /^[a-z0-9][a-z0-9._-]{2,63}$/;
const mainlandPhonePattern = /^1\d{10}$/;

const readRequiredSetting = (key: string) => {
  const value = process.env[key]?.trim();

  if (!value) {
    throw new Error(`缺少受控初始化配置：${key}`);
  }

  return value;
};

const dataPlane = resolveRuntimeDataPlane();

if (dataPlane !== "live") {
  throw new Error("真实初始化命令只能在 VM_DATA_PLANE=live 时执行。");
}

if (!process.argv.includes("--confirm-live-initialization")) {
  console.error("已阻止初始化真实数据平面。确需创建纯净真实库，请显式追加 --confirm-live-initialization。");
  process.exit(2);
}

const username = readRequiredSetting("VM_INITIAL_SUPER_ADMIN_USERNAME").toLowerCase();
const password = readRequiredSetting("VM_INITIAL_SUPER_ADMIN_PASSWORD");
const phone = readRequiredSetting("VM_INITIAL_SUPER_ADMIN_PHONE");
const name = readRequiredSetting("VM_INITIAL_SUPER_ADMIN_NAME");

if (!usernamePattern.test(username)) {
  throw new Error("初始超级管理员用户名必须是 3 至 64 位小写字母、数字、点、下划线或连字符。");
}

if (password.length < MIN_INITIAL_PASSWORD_LENGTH) {
  throw new Error(`初始超级管理员密码至少需要 ${MIN_INITIAL_PASSWORD_LENGTH} 位。`);
}

if (!mainlandPhonePattern.test(phone)) {
  throw new Error("初始超级管理员手机号必须是 11 位中国大陆手机号。");
}

if ([...name].length > 100) {
  throw new Error("初始超级管理员名称不能超过 100 个字符。");
}

const runtimePaths = resolveRuntimeStoragePaths();
const dataFile = runtimePaths.dataFile;

assertRuntimePathsSafe({
  dataFile: runtimePaths.dataFile,
  systemLogFile: runtimePaths.systemLogFile,
  uploadDir: runtimePaths.uploadDir,
  backupDir: runtimePaths.backupDir,
  financialLeaseFile: runtimePaths.financialLeaseFile
});

/**
 * 真正的首次初始化只能落在一个没有遗留审计、上传、备份或租约的根目录中。若存在这些
 * 派生文件，无法证明它们属于待初始化的 live 库，必须改走受控恢复流程，不能静默混用。
 */
const assertLiveRootIsCleanForInitialization = () => {
  const root = runtimePaths.root;

  if (!root) {
    throw new Error("真实初始化缺少受控数据根目录。");
  }

  if (!existsSync(root)) {
    return;
  }

  const rootStat = lstatSync(root);

  if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) {
    throw new Error("真实数据根目录必须是普通目录，不能是文件或符号链接。");
  }

  const unexpectedEntries = readdirSync(root).filter((entry) => entry !== "store.json");

  if (unexpectedEntries.length > 0) {
    throw new Error("真实数据根目录含有遗留文件，已拒绝混用历史审计、上传、备份或租约。");
  }
};

const assertExistingLiveBootstrapStateIsEmpty = (
  state: NonNullable<ReturnType<typeof readPersistedStateWithMetadata>>["state"]
) => {
  if (state.initializationSource !== "live-bootstrap-pending") {
    throw new Error("真实数据平面已完成或未处于受控待初始化状态；初始化命令不会覆盖现有真实数据。");
  }

  const nonEmptyCollections = Object.entries(state)
    .filter(([, value]) => Array.isArray(value) && value.length > 0)
    .map(([key]) => key);

  if (nonEmptyCollections.length > 0) {
    throw new Error(
      `真实数据平面待初始化状态仍含历史记录（${nonEmptyCollections.join("、")}），已拒绝静默清除。`
    );
  }
};

assertLiveRootIsCleanForInitialization();

if (existsSync(dataFile)) {
  const dataFileStat = lstatSync(dataFile);

  if (dataFileStat.isSymbolicLink() || !dataFileStat.isFile()) {
    throw new Error("真实数据文件必须是普通文件，不能是目录或符号链接。");
  }
}

const financialWriter = acquireFinancialSingleWriterForMaintenance();

try {
  const existing = readPersistedStateWithMetadata();

  if (!existing) {
    writePersistedState(createEmptyPersistedState("live"));
  } else {
    assertExistingLiveBootstrapStateIsEmpty(existing.state);
  }

  const store = new InMemoryStoreService();
  const snapshot = store.snapshot();
  const hasExistingLiveBusinessData = Object.values(snapshot).some(
    (value) => Array.isArray(value) && value.length > 0
  );

  if (hasExistingLiveBusinessData) {
    throw new Error("真实数据平面已含有业务或账号数据；初始化命令不会覆盖现有真实数据。");
  }

  const auditLog = new SystemAuditLogService();
  const operation = auditLog.beginCriticalIntent({
    method: "SYSTEM",
    path: "/internal/live-data/initialize",
    metadata: {
      action: "initialize-live-data",
      dataPlane: "live"
    }
  });

  try {
    store.initializeLivePlatformTenant();

    const userId = `live-super-admin-${randomUUID()}`;
    const passwordHash = hashAdminPassword(password);

    store.users.unshift({
      id: userId,
      role: "admin",
      phone,
      name,
      status: "active",
      regionName: "系统管理",
      neighborhood: "系统管理",
      tags: ["hidden-backoffice", "super-admin"],
      mobileProfileCompleted: false
    });
    store.upsertBackofficeCredential({
      userId,
      username,
      role: "super_admin",
      passwordSalt: passwordHash.salt,
      passwordHash: passwordHash.hash,
      usesDefaultPassword: false,
      passwordUpdatedAt: new Date().toISOString()
    });
    store.logOperation({
      category: "admin",
      type: "initialize-live-super-admin",
      status: "success",
      actor: {
        type: "system",
        name: "真实数据平面初始化"
      },
      primarySubject: {
        type: "user",
        id: userId,
        label: name
      },
      metadata: {
        dataPlane: "live",
        username,
        undoState: "not_undoable"
      }
    });
    store.completeLiveDataPlaneBootstrap();
    store.persist();

    if (
      !auditLog.completeCriticalOperation(operation, {
        method: "SYSTEM",
        path: "/internal/live-data/initialize",
        statusCode: 201,
        durationMs: Math.max(0, Date.now() - operation.startedAt),
        outcome: "completed",
        metadata: {
          action: "initialize-live-data",
          dataPlane: "live"
        }
      })
    ) {
      throw new Error("真实初始化完成审计记录失败。");
    }
  } catch (error) {
    auditLog.completeCriticalOperation(operation, {
      method: "SYSTEM",
      path: "/internal/live-data/initialize",
      statusCode: 500,
      durationMs: Math.max(0, Date.now() - operation.startedAt),
      outcome: "failed",
      metadata: {
        action: "initialize-live-data",
        dataPlane: "live"
      }
    });
    throw error;
  }
} finally {
  financialWriter.release();
}

// 仅输出无敏感状态，不输出用户名、手机号、路径、密码或密钥材料。
console.log("真实数据平面已创建纯净库并完成首个超级管理员受控初始化。");
