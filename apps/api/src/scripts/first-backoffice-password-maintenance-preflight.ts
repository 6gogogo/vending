import { InMemoryStoreService } from "../common/store/in-memory-store.service.js";
import { resolveRuntimeDataPlane } from "../common/config/runtime-data-plane.js";
import { resolveRuntimeStoragePaths } from "../common/store/persistence.js";
import { assertRuntimePathsSafe } from "../common/store/runtime-path-safety.js";
import { assertFirstBackofficePasswordTarget } from "../modules/auth/first-backoffice-password.js";
import { assertFirstBackofficePasswordMaintenanceServiceContext } from "./first-backoffice-password-maintenance-context.js";
import { assertInteractiveLocalPasswordTerminal } from "./local-tty-password-input.js";

/**
 * 在实际输入密码前复用同一条受管维护路径完成只读验证。
 * 此 helper 不读取密码、不取得金融单写租约，也不直接写入运行数据或审计日志。
 */
export const assertFirstBackofficePasswordMaintenancePreflight = (
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

  // InMemoryStoreService 在此仅从已持久化状态 hydrate；不调用 persist 或 flush。
  assertFirstBackofficePasswordTarget(new InMemoryStoreService());
  onCheckpoint("默认 admin 初始化目标");

  return { dataPlane };
};
