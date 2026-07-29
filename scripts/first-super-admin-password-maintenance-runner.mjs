import { dirname, resolve } from "node:path";
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { runBackofficePasswordMaintenanceRunner } from "./backoffice-password-maintenance-runner.mjs";

const currentFilePath = fileURLToPath(import.meta.url);
const repositoryRoot = realpathSync(resolve(dirname(currentFilePath), ".."));
const passwordInitializationScriptPath = resolve(
  repositoryRoot,
  "apps",
  "api",
  "src",
  "scripts",
  "initialize-first-super-admin-password.ts"
);

try {
  runBackofficePasswordMaintenanceRunner({
    operation: "服务商超级管理员首次密码维护",
    passwordScriptPath: passwordInitializationScriptPath,
    backupLabel: "pre-first-super-admin-password"
  });
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
