import { dirname, resolve } from "node:path";
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { runFirstBackofficePasswordMaintenanceRunner } from "./backoffice-password-maintenance-runner.mjs";

const currentFilePath = fileURLToPath(import.meta.url);
const repositoryRoot = realpathSync(resolve(dirname(currentFilePath), ".."));
const passwordInitializationScriptPath = resolve(
  repositoryRoot,
  "apps",
  "api",
  "src",
  "scripts",
  "initialize-first-backoffice-password.ts"
);

const main = () => {
  runFirstBackofficePasswordMaintenanceRunner({
    operation: "admin 后台密码维护",
    passwordScriptPath: passwordInitializationScriptPath,
    backupLabel: "pre-first-backoffice-password"
  });
};

try {
  main();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
