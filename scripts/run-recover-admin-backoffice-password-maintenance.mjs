import { runBackofficePasswordMaintenance } from "./run-first-backoffice-password-maintenance.mjs";

const adminBackofficePasswordRecoveryOperation = Object.freeze({
  operation: "admin 后台密码恢复",
  runnerFileName: "recover-admin-backoffice-password-maintenance-runner.mjs",
  dropInName: "96-admin-backoffice-password-recovery.conf",
  lockFileName: "vending-admin-backoffice-password-recovery.lock",
  failureMessage: "admin 后台密码恢复未完成；密码未恢复或前置校验失败。",
  successMessage: "admin 后台密码恢复完成，API 已恢复并通过本机健康检查。"
});

void runBackofficePasswordMaintenance(
  adminBackofficePasswordRecoveryOperation
).catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
