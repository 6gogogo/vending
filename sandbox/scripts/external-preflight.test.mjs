import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { checkSms, parseEnvFile } from "./external-preflight.mjs";

test("后加载配置的显式空值会清除早期文件中的旧接入参数", () => {
  const temporaryDirectory = mkdtempSync(
    join(tmpdir(), "vending-external-preflight-")
  );

  try {
    const earlierFile = join(temporaryDirectory, "earlier.env");
    const activeFile = join(temporaryDirectory, "active.env");
    writeFileSync(
      earlierFile,
      [
        "SMARTVM_BASE_URL=https://smartvm.example.com",
        "SMARTVM_CLIENT_ID=old-client",
        "SMARTVM_KEY=old-key",
        ""
      ].join("\n"),
      "utf8"
    );
    writeFileSync(
      activeFile,
      [
        "SMARTVM_MODE=disabled",
        "SMARTVM_BASE_URL=",
        "SMARTVM_CLIENT_ID=",
        "SMARTVM_KEY=",
        ""
      ].join("\n"),
      "utf8"
    );

    const merged = {
      ...parseEnvFile(earlierFile),
      ...parseEnvFile(activeFile)
    };

    assert.equal(merged.SMARTVM_MODE, "disabled");
    assert.equal(merged.SMARTVM_BASE_URL, "");
    assert.equal(merged.SMARTVM_CLIENT_ID, "");
    assert.equal(merged.SMARTVM_KEY, "");
  } finally {
    rmSync(temporaryDirectory, { recursive: true, force: true });
  }
});

test("生产预检拒绝把后台签发人工码配置成短信主通道", async () => {
  const section = await checkSms(
    {
      VERIFICATION_CODE_PROVIDER: "manual",
      VERIFICATION_CODE_PREVIEW_ENABLED: "false"
    },
    { sendSms: false }
  );

  assert.equal(section.status, "fail");
  assert.match(
    JSON.stringify(section),
    /VERIFICATION_CODE_PROVIDER=aliyun_pnvs.*人工验证码仅作为应急保底/u
  );
});
