import { dirname, resolve } from "node:path";
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { runBackofficePasswordMaintenanceRunner } from "./backoffice-password-maintenance-runner.mjs";

const currentFilePath = fileURLToPath(import.meta.url);
const repositoryRoot = realpathSync(resolve(dirname(currentFilePath), ".."));
const passwordRecoveryScriptPath = resolve(
  repositoryRoot,
  "apps",
  "api",
  "src",
  "scripts",
  "recover-admin-backoffice-password.ts"
);

try {
  runBackofficePasswordMaintenanceRunner({
    operation: "admin 后台密码恢复",
    passwordScriptPath: passwordRecoveryScriptPath,
    backupLabel: "pre-admin-backoffice-password-recovery"
  });
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
