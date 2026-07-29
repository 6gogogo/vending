import { runBackofficePasswordMaintenance } from "./run-first-backoffice-password-maintenance.mjs";

const firstSuperAdminPasswordMaintenancePreflightOperation = Object.freeze({
  operation: "服务商超级管理员首次密码维护预检",
  runnerFileName: "first-super-admin-password-maintenance-preflight-runner.mjs",
  dropInName: "99-first-super-admin-password-maintenance-preflight.conf",
  lockFileName: "vending-first-super-admin-password-maintenance-preflight.lock",
  failureMessage: "服务商超级管理员首次密码维护预检未通过；未读取密码且未执行密码更新。",
  successMessage:
    "服务商超级管理员首次密码维护预检通过；未读取密码、未创建备份、未执行密码更新，API 已恢复并通过本机健康检查。"
});

void runBackofficePasswordMaintenance(firstSuperAdminPasswordMaintenancePreflightOperation).catch(
  (error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
);
