import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { ServiceUnavailableException } from "@nestjs/common";
import type { ConfigService } from "@nestjs/config";

import { SystemAuditLogService } from "../src/common/store/system-audit-log.service.js";
import { OpenAiCompatibleService } from "../src/modules/ai-insights/openai-compatible.service.js";

test("生产 AI 配置审计意图失败时，不写入配置文件或进程环境", () => {
  const directory = mkdtempSync(join(tmpdir(), "vm-openai-config-audit-"));
  const envFilePath = join(directory, ".env");
  const originalContent = "OPENAI_BASE_URL=https://api.openai.com/v1\nOPENAI_MODEL=existing-model\n";
  writeFileSync(envFilePath, originalContent, "utf8");
  const runtimeValues = new Map<string, string>([
    ["OPENAI_BASE_URL", "https://api.openai.com/v1"],
    ["OPENAI_MODEL", "existing-model"]
  ]);
  const configService = {
    get: (key: string) => runtimeValues.get(key)
  } as unknown as ConfigService;
  const auditLog = new SystemAuditLogService({
    appendAuditLog: () => {
      throw new Error("private-audit-write-failed");
    },
    reportFailure: () => undefined
  });
  const service = new OpenAiCompatibleService(configService, auditLog, { envFilePath });
  const previous = {
    APP_ENV: process.env.APP_ENV,
    OPENAI_BASE_URL: process.env.OPENAI_BASE_URL,
    OPENAI_MODEL: process.env.OPENAI_MODEL,
    OPENAI_API_KEY: process.env.OPENAI_API_KEY
  };
  process.env.APP_ENV = "production";

  try {
    assert.throws(
      () =>
        service.saveConfig({
          baseUrl: "https://api.openai.com/v1",
          model: "audit-model",
          apiKey: "private-api-key-marker"
        }),
      (error: unknown) =>
        error instanceof ServiceUnavailableException && error.getStatus() === 503
    );
    assert.equal(readFileSync(envFilePath, "utf8"), originalContent);
    assert.equal(process.env.OPENAI_BASE_URL, previous.OPENAI_BASE_URL);
    assert.equal(process.env.OPENAI_MODEL, previous.OPENAI_MODEL);
    assert.equal(process.env.OPENAI_API_KEY, previous.OPENAI_API_KEY);
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
    rmSync(directory, { recursive: true, force: true });
  }
});

test("生产 AI 外发审计意图失败时，不发送模型请求", async () => {
  const runtimeValues = new Map<string, string>([
    ["OPENAI_API_KEY", "configured-key"],
    ["OPENAI_BASE_URL", "https://api.openai.com/v1"],
    ["OPENAI_MODEL", "configured-model"]
  ]);
  const configService = {
    get: (key: string) => runtimeValues.get(key)
  } as unknown as ConfigService;
  const auditLog = new SystemAuditLogService({
    appendAuditLog: () => {
      throw new Error("private-audit-write-failed");
    },
    reportFailure: () => undefined
  });
  const service = new OpenAiCompatibleService(configService, auditLog);
  const originalFetch = globalThis.fetch;
  const previousAppEnv = process.env.APP_ENV;
  let fetchCalls = 0;
  globalThis.fetch = (async () => {
    fetchCalls += 1;
    return new Response("{}", { status: 200 });
  }) as typeof fetch;
  process.env.APP_ENV = "production";

  try {
    await assert.rejects(
      service.completeJson({
        task: "audit-intent-test",
        systemPrompt: "system",
        userPrompt: "user"
      }),
      (error: unknown) =>
        error instanceof ServiceUnavailableException && error.getStatus() === 503
    );
    assert.equal(fetchCalls, 0);
  } finally {
    globalThis.fetch = originalFetch;
    if (previousAppEnv === undefined) {
      delete process.env.APP_ENV;
    } else {
      process.env.APP_ENV = previousAppEnv;
    }
  }
});
