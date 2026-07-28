import { assertFirstBackofficePasswordMaintenancePreflight } from "./first-backoffice-password-maintenance-preflight.js";

const main = () => {
  if (process.argv.length !== 2) {
    throw new Error("本命令不接受参数；admin 后台密码维护预检不读取任何密码。");
  }

  assertFirstBackofficePasswordMaintenancePreflight("admin 后台密码维护预检", {
    onCheckpoint: (checkpoint) => console.log(`预检通过：${checkpoint}`)
  });
  console.log(
    "admin 后台密码维护预检通过：未读取密码、未取得维护写租约、未创建备份、未执行密码更新。"
  );
};

try {
  main();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
