import { runBackofficePasswordMaintenance } from "./run-first-backoffice-password-maintenance.mjs";

const firstSuperAdminPasswordMaintenanceOperation = Object.freeze({
  operation: "服务商超级管理员首次密码维护",
  runnerFileName: "first-super-admin-password-maintenance-runner.mjs",
  dropInName: "98-first-super-admin-password-maintenance.conf",
  lockFileName: "vending-first-super-admin-password-maintenance.lock",
  failureMessage: "服务商超级管理员首次密码维护未完成；密码未成功初始化或前置校验失败。",
  successMessage: "服务商超级管理员首次密码维护完成，API 已恢复并通过本机健康检查。"
});

void runBackofficePasswordMaintenance(firstSuperAdminPasswordMaintenanceOperation).catch(
  (error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
);
