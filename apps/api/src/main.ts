import "reflect-metadata";

import { mkdirSync } from "node:fs";
import { NestFactory } from "@nestjs/core";
import type { NestExpressApplication } from "@nestjs/platform-express";

import { AppModule } from "./app.module";
import { resolveUploadDir } from "./common/store/persistence";

async function bootstrap() {
  const app = await NestFactory.create<NestExpressApplication>(AppModule, {
    cors: true
  });

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
