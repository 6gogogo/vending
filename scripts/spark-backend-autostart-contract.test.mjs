import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const readRepoFile = (relativePath) =>
  readFile(new URL(`../${relativePath}`, import.meta.url), "utf8");

test("Spark 后端单元具备断电恢复所需的无限重试与用户目标启用合同", async () => {
  const [apiUnit, webUnit] = await Promise.all([
    readRepoFile("deploy/systemd/vending-api-candidate.service"),
    readRepoFile("deploy/systemd/vending-public-web.service"),
  ]);

  for (const [name, unit] of [
    ["API", apiUnit],
    ["公网 Web", webUnit],
  ]) {
    assert.match(unit, /^StartLimitIntervalSec=0$/mu, `${name} 不得因启动重试次数耗尽而永久停机`);
    assert.match(unit, /^Restart=always$/mu, `${name} 在进程正常退出时也必须由 systemd 拉起`);
    assert.match(unit, /^RestartSec=5$/mu);
    assert.match(unit, /^WantedBy=default\.target$/mu, `${name} 必须进入用户默认启动目标`);
    assert.doesNotMatch(unit, /^User=/mu, `${name} 是用户单元，不得再声明系统级 User`);
    assert.match(unit, /^RestrictAddressFamilies=AF_INET AF_INET6 AF_UNIX$/mu);
  }

  assert.match(
    apiUnit,
    /^ExecStart=\/home\/fivegogogo\/\.nvm\/versions\/node\/v22\.22\.2\/bin\/npm run start:api:built$/mu,
  );
  assert.match(
    webUnit,
    /^ExecStart=\/home\/fivegogogo\/\.nvm\/versions\/node\/v22\.22\.2\/bin\/npm run start:public-web$/mu,
  );
});

test("安装器关闭式核验 linger、启用状态、健康端点并提供自动回滚", async () => {
  const [installer, verifier] = await Promise.all([
    readRepoFile("deploy/scripts/install-spark-backend-autostart.sh"),
    readRepoFile("deploy/scripts/verify-spark-backend-autostart.sh"),
  ]);

  assert.match(installer, /Linger=yes/);
  assert.match(installer, /systemctl --user enable/);
  assert.match(installer, /DropInPaths/);
  assert.match(installer, /90-smartvm-notify-origin\.conf/);
  assert.match(installer, /SMARTVM_ALLOWED_NOTIFY_ORIGINS=https/);
  assert.match(installer, /validate_main_unit_environment_contract/);
  assert.match(installer, /\[\[:space:\]\]\*\(Environment\|EnvironmentFile/);
  assert.match(installer, /UnitFileState/);
  assert.match(installer, /enable --runtime/);
  assert.match(installer, /active \| inactive/);
  assert.doesNotMatch(installer, /inactive \| failed \| activating \| deactivating/);
  assert.match(installer, /原配置回滚不完整/);
  assert.match(installer, /rollback/);
  assert.match(installer, /verify-spark-backend-autostart\.sh/);

  assert.match(verifier, /vending-api-candidate\.service/);
  assert.match(verifier, /vending-public-web\.service/);
  assert.match(verifier, /wg-quick@wg-mc\.service/);
  assert.match(verifier, /127\.0\.0\.1:8100\/api\/health/);
  assert.match(verifier, /127\.0\.0\.1:8100\/api\/health\/production-readiness/);
  assert.match(verifier, /10\.66\.66\.2:5795\/api\/health/);
  assert.match(verifier, /https:\/\/vending\.5gogogo\.top\/api\/health\/production-readiness/);
  assert.match(verifier, /StartLimitIntervalUSec/);
  assert.doesNotMatch(verifier, /0 \| 0us \| infinity/);
  assert.match(verifier, /403/);
});
