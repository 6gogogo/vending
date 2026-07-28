import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";

const repositoryRoot = resolve(import.meta.dirname, "..");
const readSource = (relativePath) => readFileSync(resolve(repositoryRoot, relativePath), "utf8");

test("root 安装器固定系统 PATH、私有运行目录、固定 sudo 启动器和回滚", () => {
  const source = readSource("deploy/public-app-acceptance/install-root-owned-runtime.sh");

  assert.match(source, /PATH=\/usr\/sbin:\/usr\/bin:\/sbin:\/bin/u);
  assert.match(source, /INSTALL_ROOT=\$INSTALL_PARENT\/v1/u);
  assert.match(source, /WRAPPER_PATH=\/usr\/local\/sbin\/vending-public-app-acceptance-root/u);
  assert.match(source, /SUDOERS_PATH=\/etc\/sudoers\.d\/vending-public-app-acceptance/u);
  assert.match(source, /assert_root_controlled_directory_chain \/usr\/local\/sbin/u);
  assert.match(source, /assert_root_controlled_directory_chain \/etc\/sudoers\.d/u);
  assert.match(source, /assert_root_controlled_directory_chain "\$\(\/usr\/bin\/dirname -- "\$file_path"\)"/u);
  assert.match(source, /\/usr\/bin\/git -C "\$REPOSITORY_ROOT" status --porcelain/u);
  assert.match(source, /source_commit=\$\(\/usr\/bin\/git -C "\$REPOSITORY_ROOT" rev-parse --verify HEAD\)/u);
  assert.match(source, /-m 700 "\$INSTALL_PARENT"/u);
  assert.match(source, /-m 600 "\$REPOSITORY_ROOT\/scripts\/run-public-app-acceptance\.mjs"/u);
  assert.match(source, /-m 750 "\$SOURCE_DIR\/v1\/vending-public-app-acceptance"/u);
  assert.match(source, /-m 440 "\$SOURCE_DIR\/v1\/vending-public-app-acceptance\.sudoers"/u);
  assert.match(source, /rollback_committed_install/u);
  assert.match(source, /runtime_committed=1/u);
  assert.match(source, /wrapper_committed=1/u);
  assert.match(source, /sudoers_committed=1/u);
  assert.match(source, /runtime_committed=1\s+if ! \/usr\/bin\/mv -- "\$STAGING_ROOT" "\$INSTALL_ROOT"/u);
  assert.match(source, /wrapper_committed=1\s+if ! \/usr\/bin\/mv -- "\$STAGING_WRAPPER" "\$WRAPPER_PATH"/u);
  assert.match(source, /sudoers_committed=1\s+if ! \/usr\/bin\/mv -- "\$STAGING_SUDOERS" "\$SUDOERS_PATH"/u);
  assert.match(source, /trap cleanup_on_exit EXIT/u);
  assert.match(source, /\/usr\/sbin\/visudo -cf/u);
  assert.doesNotMatch(source, /\bcat\s*>/u);
});

test("固定启动器清空环境、使用系统 Node，并且 sudo 规则禁止参数", () => {
  const wrapper = readSource("deploy/public-app-acceptance/v1/vending-public-app-acceptance");
  const sudoers = readSource("deploy/public-app-acceptance/v1/vending-public-app-acceptance.sudoers");
  const bootstrap = readSource("deploy/public-app-acceptance/v1/vending-public-app-acceptance-bootstrap.mjs");

  assert.match(wrapper, /\/usr\/bin\/env -i/u);
  assert.match(wrapper, /\/usr\/bin\/node/u);
  assert.match(wrapper, /\/usr\/bin\/id -u/u);
  assert.match(sudoers, /fivegogogo ALL=\(root\) \/usr\/local\/sbin\/vending-public-app-acceptance-root ""/u);
  assert.match(bootstrap, /dropToServiceUser\(\{ identity: resolveServiceUserIdentity\(\) \}\)/u);
  assert.match(bootstrap, /module\.printPublicAppAcceptanceFailure\(error\)/u);
});
