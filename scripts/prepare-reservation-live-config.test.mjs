import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

const scriptPath = resolve("scripts/prepare-reservation-live-config.mjs");

const parseAssignments = (content) =>
  new Map(
    content
      .split(/\r?\n/u)
      .map((line) => line.match(/^([A-Z][A-Z0-9_]*)=(.*)$/u))
      .filter(Boolean)
      .map((match) => [match[1], match[2]])
  );

test("预约制正式配置只继承获准集成并强制关闭支付与短信", (t) => {
  const directory = mkdtempSync(join(tmpdir(), "vm-live-config-"));
  const sourceEnv = join(directory, "source.env");
  const targetEnv = join(directory, "target.env");
  const dataRoot = join(directory, "live-data");
  const sourceContent = [
    "PORT=8100",
    "API_HOST=127.0.0.1",
    "PUBLIC_BASE_URL=https://vending.example.com",
    "CORS_ORIGINS=https://vending.example.com",
    "SMARTVM_BASE_URL=https://smartvm.example.com",
    "SMARTVM_CLIENT_ID=smartvm-client-private-marker",
    "SMARTVM_KEY=smartvm-key-private-marker",
    "AMAP_WEB_KEY=amap-web-marker",
    "AMAP_SECURITY_JS_CODE=amap-security-marker",
    "OPENAI_API_KEY=openai-private-marker",
    "OPENAI_BASE_URL=https://model.example.com/v1",
    "VM_DATA_PLANE=simulation",
    "VM_DATA_ROOT=old-simulation-root",
    "API_DATA_FILE=old-store.json",
    "PAYMENT_MODE=mock",
    "WECHAT_PAY_API_V3_KEY=wechat-private-marker",
    "ALIYUN_PNVS_ACCESS_KEY_SECRET=pnvs-private-marker",
    "VERIFICATION_CODE_PROVIDER=mock",
    "SMARTVM_ALLOW_UNSIGNED_CALLBACKS=true",
    "SMARTVM_AUTO_FORWARD_SETTLEMENT_PAYMENT_SUCCESS=true",
    "SMARTVM_TEST_DEVICE_CODE=should-not-copy"
  ].join("\n");
  writeFileSync(sourceEnv, `${sourceContent}\n`, { encoding: "utf8", mode: 0o600 });
  chmodSync(sourceEnv, 0o600);
  t.after(() => rmSync(directory, { recursive: true, force: true }));

  const args = [
    scriptPath,
    `--source-env=${sourceEnv}`,
    `--target-env=${targetEnv}`,
    `--data-root=${dataRoot}`,
    "--data-plane-id=xiaoguidai-live",
    "--tenant-name=小柜大爱"
  ];
  const first = spawnSync(process.execPath, args, {
    cwd: resolve("."),
    encoding: "utf8"
  });

  assert.equal(first.status, 0, `${first.stdout}\n${first.stderr}`);
  assert.doesNotMatch(
    `${first.stdout}\n${first.stderr}`,
    /private-marker|amap-web-marker|amap-security-marker|openai-private-marker|小柜大爱/u
  );
  const targetContent = readFileSync(targetEnv, "utf8");
  const values = parseAssignments(targetContent);
  assert.equal(values.get("NODE_ENV"), "production");
  assert.equal(values.get("APP_ENV"), "production");
  assert.equal(values.get("VM_DATA_PLANE"), "live");
  assert.equal(values.get("VM_DATA_ROOT"), dataRoot.replaceAll("\\", "/"));
  assert.equal(values.get("VM_DATA_PLANE_ID"), "xiaoguidai-live");
  assert.equal(values.get("VM_PLATFORM_TENANT_NAME"), "小柜大爱");
  assert.equal(values.get("VM_RESERVATION_ONLY_PICKUP"), "true");
  assert.equal(values.get("PORT"), "8100");
  assert.equal(values.get("PAYMENT_MODE"), "disabled");
  assert.equal(values.get("PAYMENT_MOCK_ENABLED"), "false");
  assert.equal(values.get("PAYMENT_RECONCILIATION_ENABLED"), "false");
  assert.equal(values.get("VERIFICATION_CODE_PROVIDER"), "manual");
  assert.equal(values.get("VERIFICATION_CODE_PREVIEW_ENABLED"), "false");
  assert.equal(values.get("SMARTVM_CLIENT_ID"), "smartvm-client-private-marker");
  assert.equal(values.get("SMARTVM_KEY"), "smartvm-key-private-marker");
  assert.equal(values.get("AMAP_WEB_KEY"), "amap-web-marker");
  assert.equal(values.get("AMAP_SECURITY_JS_CODE"), "amap-security-marker");
  assert.equal(values.get("OPENAI_API_KEY"), "openai-private-marker");
  assert.equal(values.get("SMARTVM_ALLOW_UNSIGNED_CALLBACKS"), "false");
  assert.equal(
    values.get("SMARTVM_AUTO_FORWARD_SETTLEMENT_PAYMENT_SUCCESS"),
    "false"
  );
  assert.equal(values.get("WECHAT_PAY_API_V3_KEY"), "");
  assert.equal(values.get("ALIYUN_PNVS_ACCESS_KEY_SECRET"), "");
  assert.equal(values.has("API_DATA_FILE"), false);
  assert.equal(values.has("SMARTVM_TEST_DEVICE_CODE"), false);
  if (process.platform !== "win32") {
    assert.equal(statSync(targetEnv).mode & 0o777, 0o600);
  }

  const originalTarget = targetContent;
  const second = spawnSync(process.execPath, args, {
    cwd: resolve("."),
    encoding: "utf8"
  });
  assert.notEqual(second.status, 0);
  assert.match(`${second.stdout}\n${second.stderr}`, /目标配置已存在/u);
  assert.equal(readFileSync(targetEnv, "utf8"), originalTarget);
});
