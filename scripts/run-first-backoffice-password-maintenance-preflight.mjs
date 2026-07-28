import { runBackofficePasswordMaintenance } from "./run-first-backoffice-password-maintenance.mjs";

const firstBackofficePasswordMaintenancePreflightOperation = Object.freeze({
  operation: "admin 后台密码维护预检",
  runnerFileName: "first-backoffice-password-maintenance-preflight-runner.mjs",
  dropInName: "97-first-backoffice-password-maintenance-preflight.conf",
  lockFileName: "vending-first-backoffice-password-maintenance-preflight.lock",
  failureMessage: "admin 后台密码维护预检未通过；未读取密码且未执行密码更新。",
  successMessage:
    "admin 后台密码维护预检通过；未读取密码、未创建备份、未执行密码更新，API 已恢复并通过本机健康检查。"
});

void runBackofficePasswordMaintenance(
  firstBackofficePasswordMaintenancePreflightOperation
).catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
