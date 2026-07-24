import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";

type RuntimeEnvironment = Partial<Pick<NodeJS.ProcessEnv, "NODE_ENV" | "APP_ENV">>;

const normalizeRuntimeName = (value?: string) => value?.trim().toLowerCase();

export const isProductionRuntime = (environment: RuntimeEnvironment = process.env) =>
  [environment.NODE_ENV, environment.APP_ENV].some(
    (value) => normalizeRuntimeName(value) === "production"
  );

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
