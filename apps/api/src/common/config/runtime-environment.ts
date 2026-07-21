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
