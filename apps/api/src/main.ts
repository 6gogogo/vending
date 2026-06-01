import "reflect-metadata";

import { mkdirSync } from "node:fs";
import { NestFactory } from "@nestjs/core";
import { ConfigService } from "@nestjs/config";
import type { NestExpressApplication } from "@nestjs/platform-express";

import { AppModule } from "./app.module";
import { assertProductionSafety, isProductionRuntime } from "./common/config/production-safety";
import { resolveUploadDir } from "./common/store/persistence";
import { InMemoryStoreService } from "./common/store/in-memory-store.service";

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

async function bootstrap() {
  const app = await NestFactory.create<NestExpressApplication>(AppModule);
  const configService = app.get(ConfigService);
  const store = app.get(InMemoryStoreService);
  assertProductionSafety(configService, store);

  const configuredCorsOrigins = parseCorsOrigins(configService.get<string>("CORS_ORIGINS"));
  app.enableCors({
    origin: configuredCorsOrigins.length > 0 ? configuredCorsOrigins : !isProductionRuntime(),
    credentials: false
  });
  app.set("trust proxy", 1);

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
    prefix: "/uploads"
  });

  const port = Number(process.env.PORT ?? 4000);
  await app.listen(port);

  console.log(`接口服务已启动：http://localhost:${port}/api`);
}

bootstrap();
