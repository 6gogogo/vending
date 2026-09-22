import { spawn } from "node:child_process";
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// 仅用于本地设计验收：独立模拟数据、回环监听，不读取部署配置。
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const dataRoot = resolve(root, ".codex-run/admin-redesign-preview");
mkdirSync(dataRoot, { recursive: true });
const env = Object.fromEntries(Object.entries(process.env).filter(([key]) =>
  !/^(VM_|VITE_|API_|UPLOAD_|SYSTEM_LOG_|FINANCIAL_|SMARTVM_|PAYMENT_|WECHAT_|ALIPAY_|ALIYUN_|OPENAI_|VERIFICATION_|ALLOW_DEFAULT_|DATABASE_URL$|PUBLIC_BASE_URL$|CORS_ORIGINS$|PORT$|NODE_ENV$|APP_ENV$|TRUST_PROXY_)/i.test(key)
));
Object.assign(env, {
  NODE_ENV: "development", APP_ENV: "development", VM_TEST_ISOLATED_ENV: "1",
  VM_DATA_PLANE: "simulation", VM_SIMULATION_PROFILE: "standard",
  API_DATA_FILE: resolve(dataRoot, "store.json"),
  SYSTEM_LOG_FILE: resolve(dataRoot, "audit.ndjson"),
  UPLOAD_DIR: resolve(dataRoot, "uploads"), API_BACKUP_DIR: resolve(dataRoot, "backups"),
  FINANCIAL_SINGLE_WRITER_LEASE_FILE: resolve(dataRoot, "writer.lock"),
  FINANCIAL_SINGLE_WRITER_ENABLED: "false", PAYMENT_RECONCILIATION_ENABLED: "false",
  PAYMENT_MODE: "mock", PAYMENT_MOCK_ENABLED: "true", VERIFICATION_CODE_PROVIDER: "mock",
  ALLOW_DEFAULT_BACKOFFICE_LOGIN: "true", VM_RESERVATION_ONLY_PICKUP: "true",
  API_HOST: "127.0.0.1", PORT: "4188", PUBLIC_BASE_URL: "http://127.0.0.1:4188",
  CORS_ORIGINS: "http://127.0.0.1:5188,http://localhost:5188",
  VITE_API_BASE_URL: "http://127.0.0.1:4188/api", VITE_ALLOW_REMOTE_API_IN_LOCAL_DEV: "false"
});
const children = [
  spawn(process.execPath, [resolve(root, "node_modules/tsx/dist/cli.mjs"), "src/main.ts"], { cwd: resolve(root, "apps/api"), env, stdio: "inherit" }),
  spawn(process.execPath, [resolve(root, "node_modules/vite/bin/vite.js"), "--host", "127.0.0.1", "--port", "5188", "--strictPort"], { cwd: resolve(root, "apps/admin-web"), env, stdio: "inherit" })
];
let stopping = false;
const stop = (code = 0) => {
  if (stopping) return;
  stopping = true;
  children.forEach(child => child.kill());
  process.exitCode = code;
};
children.forEach(child => {
  child.on("error", error => { console.error(error.message); stop(1); });
  child.on("exit", code => stop(code ?? 1));
});
process.on("SIGINT", () => stop());
process.on("SIGTERM", () => stop());
console.log("本地验收：http://127.0.0.1:5188；模拟账号：admin / admin");
