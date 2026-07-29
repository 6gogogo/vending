import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";

import {
  preflightPublicAppAcceptance,
  runPublicAppAcceptance
} from "./public-app-acceptance.mjs";
import {
  assertHiddenInputAvailable,
  assertNoArguments,
  assertVncLocalInteractiveSession,
  readHiddenLine
} from "./vnc-local-session.mjs";

const operation = "受控公网 App 验收";
const currentFilePath = fileURLToPath(import.meta.url);
const safeFailureStages = new Set([
  "核验公网模拟配置",
  "后台管理员登录",
  "核验后台验收权限",
  "核验预约开关",
  "核验可用模拟库存",
  "创建自建验收夹具",
  "设置自建预约规则",
  "签发一次性人工验证码",
  "App 人工码登录",
  "核验 App 会话",
  "核验 App 预约开关",
  "核验 App 可见柜机",
  "核验 App 柜机详情",
  "创建 App 预约",
  "核验 App 当前预约",
  "拒绝人工码重放",
  "核验人工码已消费",
  "取消本次预约",
  "保留未取消预约的验收夹具",
  "注销移动验收会话",
  "撤销未消费人工验证码",
  "删除自建验收夹具",
  "停用自建验收规则",
  "注销后台验收会话"
]);

export const printPublicAppAcceptanceFailure = (error, output = process.stderr) => {
  if (error?.message === `${operation}不接受任何参数。`) {
    output.write(`${operation}不接受任何参数。\n`);
    return;
  }

  if (error?.message === "受控公网 App 验收只能由已封存的本机运行器启动。") {
    output.write("受控公网 App 验收只能由已封存的本机运行器启动。\n");
    return;
  }

  const stage = typeof error?.stage === "string" && safeFailureStages.has(error.stage)
    ? error.stage
    : undefined;
  const recoveryReference =
    typeof error?.recoveryReference === "string" && /^[a-f0-9-]{16,64}$/u.test(error.recoveryReference)
      ? error.recoveryReference
      : undefined;
  const status =
    Number.isInteger(error?.status) && error.status >= 100 && error.status <= 599
      ? error.status
      : undefined;
  output.write(
    stage
      ? `${operation}未完成：步骤“${stage}”未通过（${
          status === undefined ? "未取得可确认的 HTTP 状态" : `HTTP ${status}`
        }）；不会输出输入内容。${
          recoveryReference ? `请记录非敏感运行参考号：${recoveryReference}。` : ""
        }\n`
      : `${operation}未完成：前置校验或受控接口步骤未通过；不会输出输入内容。\n`
  );
};

export const executePublicAppAcceptance = async () => {
  assertNoArguments(process.argv.slice(2), operation);

  assertVncLocalInteractiveSession();
  assertHiddenInputAvailable();
  await preflightPublicAppAcceptance({
    report: ({ stage, outcome }) => {
      const label = outcome === "passed" ? "通过" : "未通过";
      process.stdout.write(`验收步骤：${stage}（${label}）。\n`);
    }
  });
  process.stdout.write(
    "将只走已有 HTTPS 业务接口，自动生成并清理本次测试夹具；不操作库存、柜机、支付或系统设置。操作审计会保留。\n"
  );

  const adminPassword = await readHiddenLine("请输入后台管理员密码（不回显）：");
  const manualCode = await readHiddenLine("请输入本次 6 位人工验证码（不回显）：");
  const result = await runPublicAppAcceptance({
    inputs: { adminPassword, manualCode },
    report: ({ stage, outcome }) => {
      const label = outcome === "passed" ? "通过" : "未通过";
      process.stdout.write(`验收步骤：${stage}（${label}）。\n`);
    }
  });

  if (
    result.publicIngressVerified &&
    result.manualCodeReplayRejected &&
    result.reservationCancelled &&
    result.fixtureRemoved
  ) {
    process.stdout.write("受控公网 App 验收完成：HTTPS API 权限、人工码单次消费与预约链路均已通过，夹具已清理。\n");
    return;
  }

  throw new Error("受控公网 App 验收结果不完整。");
};

const isDirectExecution =
  process.argv[1] && realpathSync(process.argv[1]) === realpathSync(currentFilePath);

if (isDirectExecution) {
  try {
    assertNoArguments(process.argv.slice(2), operation);
    printPublicAppAcceptanceFailure(
      new Error("受控公网 App 验收只能由已封存的本机运行器启动。")
    );
  } catch (error) {
    printPublicAppAcceptanceFailure(error);
  }
  process.exitCode = 1;
}
