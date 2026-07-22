import "reflect-metadata";

import { mkdirSync } from "node:fs";
import { NestFactory } from "@nestjs/core";
import { ConfigModule, ConfigService } from "@nestjs/config";
import type { NestExpressApplication } from "@nestjs/platform-express";

import { AppModule } from "./app.module";
import { assertProductionSafety, isProductionRuntime } from "./common/config/production-safety";
import { FinancialSingleWriterService } from "./common/coordination/financial-single-writer.service";
import { acquireFinancialSingleWriterForApiBootstrap } from "./common/coordination/financial-single-writer-runtime";
import { resolveTrustProxySetting } from "./common/config/http-runtime";
import {
  resolveApiBackupDir,
  resolveApiDataFile,
  resolveFinancialSingleWriterLeaseFile,
  resolveSystemLogFile,
  resolveUploadDir
} from "./common/store/persistence";
import { assertRuntimePathsSafe } from "./common/store/runtime-path-safety";
import { InMemoryStoreService } from "./common/store/in-memory-store.service";
import {
  SystemAuditLogService,
  type CriticalAuditOperation
} from "./common/store/system-audit-log.service";
import { PaymentsService } from "./modules/payments/payments.service";

const parseCorsOrigins = (raw?: string) =>
  raw?.split(",").map((origin) => origin.trim()).filter(Boolean) ?? [];

const normalizeBodyParserError = (
  error: unknown,
  _request: unknown,
  response: { status: (code: number) => { json: (body: unknown) => void } },
  next: (error?: unknown) => void
) => {
  const maybeParseError = error as { type?: string; status?: number; body?: unknown };

  if (maybeParseError.type === "entity.parse.failed" || maybeParseError.status === 400 && "body" in maybeParseError) {
    response.status(400).json({
      code: 400,
      message: "请求体格式错误。",
      data: null
    });
    return;
  }

  next(error);
};

const setApiSecurityHeaders = (
  request: { path?: string },
  response: { setHeader: (name: string, value: string) => void },
  next: () => void
) => {
  response.setHeader("X-Content-Type-Options", "nosniff");
  response.setHeader("X-Frame-Options", "DENY");
  response.setHeader("Referrer-Policy", "no-referrer");
  response.setHeader("Permissions-Policy", "camera=(), microphone=(), geolocation=()");

  if (request.path === "/api" || request.path?.startsWith("/api/")) {
    response.setHeader("Cache-Control", "no-store");
  }

  next();
};

async function bootstrap() {
  // AppModule 的 ConfigModule.forRoot 会先加载 .env；租约随后必须早于 Nest DI/Store 构造取得。
  await ConfigModule.envVariablesLoaded;
  if (isProductionRuntime()) {
    assertRuntimePathsSafe({
      dataFile: resolveApiDataFile(),
      systemLogFile: resolveSystemLogFile(),
      uploadDir: resolveUploadDir(),
      backupDir: resolveApiBackupDir(),
      financialLeaseFile: resolveFinancialSingleWriterLeaseFile()
    });
  }
  const preAcquiredFinancialWriter =
    acquireFinancialSingleWriterForApiBootstrap();
  let app: NestExpressApplication | undefined;
  let financialSingleWriter: FinancialSingleWriterService | undefined;
  let systemAuditLog: SystemAuditLogService | undefined;
  let startupAuditOperation: CriticalAuditOperation | undefined;
  let startupAuditCompleted = false;

  try {
    app = await NestFactory.create<NestExpressApplication>(AppModule);
    const configService = app.get(ConfigService);
    const resolvedFinancialSingleWriter = app.get(
      FinancialSingleWriterService
    );
    financialSingleWriter = resolvedFinancialSingleWriter;
    resolvedFinancialSingleWriter.adoptPreAcquiredRuntime(
      preAcquiredFinancialWriter
    );
    const store = app.get(InMemoryStoreService);
    const resolvedSystemAuditLog = app.get(SystemAuditLogService);
    systemAuditLog = resolvedSystemAuditLog;
    if (isProductionRuntime()) {
      startupAuditOperation = resolvedSystemAuditLog.initialize();
      if (!startupAuditOperation) {
        throw new Error("系统审计日志启动意图未建立。");
      }
    }
    assertProductionSafety(configService, store, resolvedSystemAuditLog);
    store.flushBootstrapPersistence();
    app.enableShutdownHooks();

    const configuredCorsOrigins = parseCorsOrigins(configService.get<string>("CORS_ORIGINS"));
    const localCorsOrigins = [
      "http://127.0.0.1:5173",
      "http://localhost:5173",
      "http://127.0.0.1:5174",
      "http://localhost:5174"
    ];
    app.enableCors({
      origin: configuredCorsOrigins.length > 0
        ? configuredCorsOrigins
        : isProductionRuntime()
          ? []
          : localCorsOrigins,
      credentials: false
    });
    // 仅在明确知道前方代理层数时信任转发头，避免公网直连时伪造 X-Forwarded-For 绕过限流。
    app.set("trust proxy", resolveTrustProxySetting(configService.get<string>("TRUST_PROXY_HOPS")));
    app.use(setApiSecurityHeaders);

    const captureRawBody = (request: { rawBody?: string }, _response: unknown, buffer: Buffer) => {
      request.rawBody = buffer.toString("utf8");
    };
    app.useBodyParser("json", { limit: "1mb", verify: captureRawBody });
    app.useBodyParser("urlencoded", { extended: true, limit: "256kb", verify: captureRawBody });
    app.use(normalizeBodyParserError);

    app.setGlobalPrefix("api");

    const uploadDir = resolveUploadDir();
    mkdirSync(uploadDir, { recursive: true });
    app.useStaticAssets(uploadDir, {
      prefix: "/uploads",
      setHeaders: (response) => {
        response.setHeader("X-Content-Type-Options", "nosniff");
        response.setHeader("Content-Security-Policy", "default-src 'none'; sandbox");
        response.setHeader("Cache-Control", "public, max-age=31536000, immutable");
      }
    });

    const port = Number(process.env.PORT ?? 4000);
    const host = configService.get<string>("API_HOST")?.trim() || (isProductionRuntime() ? "0.0.0.0" : "127.0.0.1");
    await app.listen(port, host);
    if (startupAuditOperation) {
      if (!resolvedSystemAuditLog.completeStartup(startupAuditOperation)) {
        throw new Error("系统审计日志启动完成记录失败。");
      }
      startupAuditCompleted = true;
    }

    const displayHost = host === "0.0.0.0" ? "127.0.0.1" : host;
    console.log(`接口服务已启动：http://${displayHost}:${port}/api（监听 ${host}）`);
    for (const line of app.get(PaymentsService).formatPaymentDiagnosticsForLog()) {
      console.log(line);
    }
  } catch (error) {
    if (startupAuditOperation && !startupAuditCompleted) {
      try {
        systemAuditLog?.failStartup(startupAuditOperation);
      } catch {
        systemAuditLog?.recordFailure();
      }
    }

    try {
      await app?.close();
    } finally {
      financialSingleWriter?.release();
      preAcquiredFinancialWriter.release();
    }
    throw error;
  }
}

bootstrap().catch((error) => {
  console.error(error instanceof Error ? error.message : "接口服务启动失败。");
  process.exitCode = 1;
});
