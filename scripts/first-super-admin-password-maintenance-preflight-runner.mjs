import { dirname, resolve } from "node:path";
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { runFirstBackofficePasswordMaintenancePreflightRunner } from "./backoffice-password-maintenance-runner.mjs";

const currentFilePath = fileURLToPath(import.meta.url);
const repositoryRoot = realpathSync(resolve(dirname(currentFilePath), ".."));
const preflightScriptPath = resolve(
  repositoryRoot,
  "apps",
  "api",
  "src",
  "scripts",
  "verify-first-super-admin-password-maintenance.ts"
);

try {
  runFirstBackofficePasswordMaintenancePreflightRunner({
    operation: "服务商超级管理员首次密码维护预检",
    preflightScriptPath
  });
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
