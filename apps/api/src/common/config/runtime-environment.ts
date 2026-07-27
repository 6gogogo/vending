import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";

export const TEST_ISOLATED_ENV_KEY = "VM_TEST_ISOLATED_ENV";

type RuntimeEnvironment = Partial<
  Pick<NodeJS.ProcessEnv, "NODE_ENV" | "APP_ENV" | typeof TEST_ISOLATED_ENV_KEY>
>;

const normalizeRuntimeName = (value?: string) => value?.trim().toLowerCase();

export const isProductionRuntime = (environment: RuntimeEnvironment = process.env) =>
  [environment.NODE_ENV, environment.APP_ENV].some(
    (value) => normalizeRuntimeName(value) === "production"
  );

/**
 * 仅由 API 测试启动器设置。隔离测试不能读取开发机或部署机的 .env，
 * 否则测试可能意外复用真实数据平面或半配置的全真模拟档。
 */
export const isTestEnvironmentIsolated = (environment: RuntimeEnvironment = process.env) =>
  environment[TEST_ISOLATED_ENV_KEY]?.trim() === "1";

export const envFilesDeclareProductionRuntime = (
  paths: readonly string[],
  cwd = process.cwd()
) =>
  paths.some((path) => {
    const filePath = isAbsolute(path) ? path : resolve(cwd, path);

    if (!existsSync(filePath)) {
      return false;
    }

    const content = readFileSync(filePath, "utf8").replace(/^\uFEFF/, "");
    return content.split(/\r?\n/).some((line) =>
      /^\s*(?:export\s+)?(?:NODE_ENV|APP_ENV)\s*=\s*(?:["']production["']|production)\s*(?:#.*)?$/i.test(
        line
      )
    );
  });

/**
 * 全真模拟的运行配置必须完整自洽；不能在 ConfigModule 初始化时继续混入
 * `.env.example` 中的旧路径配置，否则隔离根目录门禁会失效。
 */
export const envFilesDeclareFullSimulationProfile = (
  paths: readonly string[],
  cwd = process.cwd()
) =>
  paths.some((path) => {
    const filePath = isAbsolute(path) ? path : resolve(cwd, path);

    if (!existsSync(filePath)) {
      return false;
    }

    const content = readFileSync(filePath, "utf8").replace(/^\uFEFF/, "");
    return content.split(/\r?\n/).some((line) =>
      /^\s*(?:export\s+)?VM_SIMULATION_PROFILE\s*=\s*(?:["']full["']|full)\s*(?:#.*)?$/i.test(
        line
      )
    );
  });
