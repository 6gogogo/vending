import { InMemoryStoreService } from "../common/store/in-memory-store.service.js";
import { resolveRuntimeDataPlane } from "../common/config/runtime-data-plane.js";
import { resolveRuntimeStoragePaths } from "../common/store/persistence.js";
import { assertRuntimePathsSafe } from "../common/store/runtime-path-safety.js";
import { assertFirstSuperAdminPasswordTarget } from "../modules/auth/first-super-admin-password.js";
import { assertFirstBackofficePasswordMaintenanceServiceContext } from "./first-backoffice-password-maintenance-context.js";
import { assertInteractiveLocalPasswordTerminal } from "./local-tty-password-input.js";

/**
 * 在实际输入密码前复用正式维护路径做只读验证；不读取密码、不取得写租约、不写运行数据或审计日志。
 */
export const assertFirstSuperAdminPasswordMaintenancePreflight = (
  operation: string,
  {
    onCheckpoint = () => undefined
  }: {
    onCheckpoint?: (checkpoint: string) => void;
  } = {}
) => {
  assertInteractiveLocalPasswordTerminal(operation);
  onCheckpoint("VNC 本机终端");
  assertFirstBackofficePasswordMaintenanceServiceContext();
  onCheckpoint("受控维护服务上下文");

  const dataPlane = resolveRuntimeDataPlane();
  const runtimePaths = resolveRuntimeStoragePaths();
  assertRuntimePathsSafe({
    dataFile: runtimePaths.dataFile,
    systemLogFile: runtimePaths.systemLogFile,
    uploadDir: runtimePaths.uploadDir,
    backupDir: runtimePaths.backupDir,
    financialLeaseFile: runtimePaths.financialLeaseFile
  });
  onCheckpoint("运行平面与存储路径");

  // InMemoryStoreService 在此仅 hydrate；不调用 persist 或 flush。
  assertFirstSuperAdminPasswordTarget(new InMemoryStoreService());
  onCheckpoint("唯一服务商超级管理员账号");

  return { dataPlane };
};
