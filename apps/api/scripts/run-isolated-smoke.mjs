import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const apiRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const taskName = process.argv[2];
const taskScripts = Object.freeze({
  defensive: "src/scripts/smoke-defensive-integrity.ts",
  inventory: "src/scripts/smoke-inventory-batch-changes.ts"
});
const taskScript = taskScripts[taskName];

if (process.argv.length !== 3 || !taskScript) {
  throw new Error("仅允许执行 inventory 或 defensive 隔离烟测。");
}

const deploymentScopedKey = (key) =>
  /^(?:VM_|API_DATA_FILE$|UPLOAD_DIR$|SYSTEM_LOG_FILE$|API_BACKUP_DIR$|FINANCIAL_|SMARTVM_|PAYMENT_|WECHAT_|ALIPAY_|ALIYUN_|OPENAI_|DATABASE_URL$|PUBLIC_BASE_URL$|CORS_ORIGINS$|PORT$|API_HOST$|TRUST_PROXY_HOPS$|NODE_ENV$|APP_ENV$)/iu.test(
    key
  );

const environment = Object.fromEntries(
  Object.entries(process.env).filter(([key]) => !deploymentScopedKey(key))
);
environment.VM_TEST_ISOLATED_ENV = "1";

const result = spawnSync(
  process.execPath,
  [resolve(apiRoot, "..", "..", "node_modules", "tsx", "dist", "cli.mjs"), resolve(apiRoot, taskScript)],
  {
    cwd: apiRoot,
    env: environment,
    stdio: "inherit"
  }
);

if (result.error) {
  throw result.error;
}

process.exitCode = result.status ?? 1;
