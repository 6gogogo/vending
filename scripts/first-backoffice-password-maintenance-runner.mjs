import { spawnSync } from "node:child_process";
import { lstatSync, realpathSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { resolveTypeScriptMaintenanceCommand } from "./first-backoffice-password-maintenance.mjs";

const currentFilePath = fileURLToPath(import.meta.url);
const repositoryRoot = realpathSync(resolve(dirname(currentFilePath), ".."));
const tsxCliPath = resolve(repositoryRoot, "node_modules", "tsx", "dist", "cli.mjs");
const apiTsconfigPath = resolve(repositoryRoot, "apps", "api", "tsconfig.json");
const maintenanceScriptPath = resolve(
  repositoryRoot,
  "apps",
  "api",
  "src",
  "scripts",
  "runtime-data-maintenance.ts"
);
const passwordInitializationScriptPath = resolve(
  repositoryRoot,
  "apps",
  "api",
  "src",
  "scripts",
  "initialize-first-backoffice-password.ts"
);

const assertInteractiveTerminal = () => {
  if (!process.stdin.isTTY || !process.stdout.isTTY || !process.stderr.isTTY) {
    throw new Error("首次后台密码维护只能由服务器 VNC 本机交互终端启动。");
  }
};

const assertTrustedRepositoryFile = (filePath, name) => {
  let currentPath = filePath;
  let expectsFile = true;

  for (;;) {
    const metadata = lstatSync(currentPath);
    const expectedType = expectsFile ? metadata.isFile() : metadata.isDirectory();

    if (
      !expectedType ||
      metadata.isSymbolicLink() ||
      metadata.uid !== process.getuid() ||
      (metadata.mode & 0o022) !== 0
    ) {
      throw new Error(`${name} 及其受管目录链必须归服务用户所有，且不能被组或其他用户写入。`);
    }

    if (currentPath === repositoryRoot) {
      return;
    }

    const parentPath = dirname(currentPath);
    if (parentPath === currentPath) {
      throw new Error(`${name} 未位于受管工作树内。`);
    }

    currentPath = parentPath;
    expectsFile = false;
  }
};

const runTypeScriptScript = (scriptPath, args = []) => {
  const result = spawnSync(
    process.execPath,
    resolveTypeScriptMaintenanceCommand({
      tsxCliPath,
      tsconfigPath: apiTsconfigPath,
      scriptPath,
      args
    }),
    {
      cwd: repositoryRoot,
      stdio: "inherit"
    }
  );

  if (result.error) {
    throw result.error;
  }

  if (result.status !== 0) {
    throw new Error(`受控维护步骤失败：${scriptPath}`);
  }
};

const main = () => {
  if (process.argv.length !== 2) {
    throw new Error("首次后台密码维护运行器不接受任何参数。");
  }

  if (process.platform !== "linux") {
    throw new Error("首次后台密码维护运行器只能在 Spark Linux 主机运行。");
  }

  assertInteractiveTerminal();

  if (realpathSync(process.cwd()) !== repositoryRoot) {
    throw new Error("维护运行器必须从 API 服务当前工作目录启动。");
  }

  assertTrustedRepositoryFile(tsxCliPath, "tsx 运行器");
  assertTrustedRepositoryFile(apiTsconfigPath, "API TypeScript 配置");
  assertTrustedRepositoryFile(maintenanceScriptPath, "运行数据维护脚本");
  assertTrustedRepositoryFile(passwordInitializationScriptPath, "首次后台密码初始化脚本");

  runTypeScriptScript(maintenanceScriptPath, ["verify"]);
  runTypeScriptScript(maintenanceScriptPath, [
    "backup",
    "--label",
    "pre-first-backoffice-password",
    "--keep",
    "30"
  ]);
  runTypeScriptScript(maintenanceScriptPath, ["verify", "--latest"]);
  runTypeScriptScript(passwordInitializationScriptPath);
};

try {
  main();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
