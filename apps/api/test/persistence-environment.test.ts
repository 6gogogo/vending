import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const testDir = dirname(fileURLToPath(import.meta.url));
const apiRoot = resolve(testDir, "..");
const tsxCli = resolve(apiRoot, "../../node_modules/tsx/dist/cli.mjs");
const resolverChild = resolve(testDir, "fixtures/resolve-api-data-file-child.ts");

test("运行时路径在读取配置前加载实际 .env，并优先于示例文件", (t) => {
  const workspaceRoot = mkdtempSync(join(tmpdir(), "vm-persistence-env-"));
  t.after(() => rmSync(workspaceRoot, { recursive: true, force: true }));

  const resolverCases = [
    {
      resolver: "data",
      environmentKey: "API_DATA_FILE",
      expectedPath: join(workspaceRoot, "candidate-store.json")
    },
    {
      resolver: "uploads",
      environmentKey: "UPLOAD_DIR",
      expectedPath: join(workspaceRoot, "candidate-uploads")
    },
    {
      resolver: "system-log",
      environmentKey: "SYSTEM_LOG_FILE",
      expectedPath: join(workspaceRoot, "candidate-system-audit.ndjson")
    },
    {
      resolver: "backups",
      environmentKey: "API_BACKUP_DIR",
      expectedPath: join(workspaceRoot, "candidate-backups")
    },
    {
      resolver: "writer-lease",
      environmentKey: "FINANCIAL_SINGLE_WRITER_LEASE_FILE",
      expectedPath: join(workspaceRoot, "candidate-writer.lock")
    }
  ].map((resolverCase) => ({
    ...resolverCase,
    expectedPath: resolverCase.expectedPath.replaceAll("\\", "/"),
    examplePath: join(workspaceRoot, `example-${resolverCase.resolver}`).replaceAll(
      "\\",
      "/"
    )
  }));
  writeFileSync(
    join(workspaceRoot, "package.json"),
    '{"name":"@vm/api"}\n',
    "utf8"
  );
  writeFileSync(
    join(workspaceRoot, ".env"),
    `${resolverCases
      .map(({ environmentKey, expectedPath }) => `${environmentKey}=${expectedPath}`)
      .join("\n")}\n`,
    "utf8"
  );
  writeFileSync(
    join(workspaceRoot, ".env.example"),
    `${resolverCases
      .map(({ environmentKey, examplePath }) => `${environmentKey}=${examplePath}`)
      .join("\n")}\n`,
    "utf8"
  );

  const environment: NodeJS.ProcessEnv = {
    ...process.env,
    APP_ENV: "test",
    NODE_ENV: "test"
  };
  for (const { environmentKey } of resolverCases) {
    delete environment[environmentKey];
  }

  for (const { resolver, expectedPath } of resolverCases) {
    const result = spawnSync(
      process.execPath,
      [tsxCli, resolverChild, workspaceRoot, resolver],
      {
        cwd: apiRoot,
        encoding: "utf8",
        env: environment
      }
    );

    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    assert.equal(result.stdout, expectedPath, resolver);
  }
});
