import { runBackofficePasswordMaintenance } from "./run-first-backoffice-password-maintenance.mjs";

const superAdminBackofficePasswordRecoveryOperation = Object.freeze({
  operation: "服务商超级管理员密码恢复",
  runnerFileName: "recover-super-admin-backoffice-password-maintenance-runner.mjs",
  dropInName: "94-super-admin-backoffice-password-recovery.conf",
  lockFileName: "vending-super-admin-backoffice-password-recovery.lock",
  failureMessage: "服务商超级管理员密码恢复未完成；密码未恢复或前置校验失败。",
  successMessage: "服务商超级管理员密码恢复完成，API 已恢复并通过本机健康检查。"
});

void runBackofficePasswordMaintenance(
  superAdminBackofficePasswordRecoveryOperation
).catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
