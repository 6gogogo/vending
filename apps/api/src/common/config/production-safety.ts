import { BadRequestException } from "@nestjs/common";
import type { ConfigService } from "@nestjs/config";

import type { InMemoryStoreService } from "../store/in-memory-store.service";

const truthyValues = new Set(["1", "true", "yes", "on"]);
const falseyValues = new Set(["0", "false", "no", "off"]);

const isTruthy = (value: string | undefined) =>
  truthyValues.has(value?.trim().toLowerCase() ?? "");

const isFalsey = (value: string | undefined) =>
  falseyValues.has(value?.trim().toLowerCase() ?? "");

const readConfig = (configService: ConfigService, key: string) =>
  configService.get<string>(key)?.trim();

const requireConfig = (configService: ConfigService, key: string) => {
  const value = readConfig(configService, key);

  if (!value) {
    throw new BadRequestException(`生产环境缺少必填配置：${key}`);
  }

  return value;
};

const assertPublicHttpsUrl = (value: string, key: string) => {
  let parsed: URL;

  try {
    parsed = new URL(value);
  } catch {
    throw new BadRequestException(`生产环境 ${key} 必须是有效 URL。`);
  }

  if (parsed.protocol !== "https:") {
    throw new BadRequestException(`生产环境 ${key} 必须使用 HTTPS。`);
  }

  if (["localhost", "127.0.0.1", "0.0.0.0"].includes(parsed.hostname)) {
    throw new BadRequestException(`生产环境 ${key} 不能指向本机地址。`);
  }
};

export const isProductionRuntime = () =>
  (process.env.NODE_ENV ?? process.env.APP_ENV ?? "").trim().toLowerCase() === "production";

export const assertProductionSafety = (
  configService: ConfigService,
  store: InMemoryStoreService
) => {
  if (!isProductionRuntime()) {
    return;
  }

  const publicBaseUrl = requireConfig(configService, "PUBLIC_BASE_URL");
  assertPublicHttpsUrl(publicBaseUrl, "PUBLIC_BASE_URL");

  const corsOrigins = requireConfig(configService, "CORS_ORIGINS");
  for (const origin of corsOrigins.split(",").map((entry) => entry.trim()).filter(Boolean)) {
    assertPublicHttpsUrl(origin, "CORS_ORIGINS");
  }

  const verificationProvider = requireConfig(configService, "VERIFICATION_CODE_PROVIDER");
  if (verificationProvider !== "aliyun") {
    throw new BadRequestException("生产环境必须使用真实短信验证码服务。");
  }

  if (isTruthy(readConfig(configService, "VERIFICATION_CODE_PREVIEW_ENABLED"))) {
    throw new BadRequestException("生产环境不能开启验证码预览。");
  }

  for (const key of ["SMARTVM_BASE_URL", "SMARTVM_CLIENT_ID", "SMARTVM_KEY"]) {
    requireConfig(configService, key);
  }

  if (isTruthy(readConfig(configService, "SMARTVM_ALLOW_UNSIGNED_CALLBACKS"))) {
    throw new BadRequestException("生产环境不能允许未签名 SmartVM 回调。");
  }

  if (isTruthy(readConfig(configService, "ALLOW_UNSIGNED_SMARTVM_CALLBACKS"))) {
    throw new BadRequestException("生产环境不能允许未签名 SmartVM 回调。");
  }

  if (!isFalsey(readConfig(configService, "PAYMENT_MOCK_ENABLED"))) {
    throw new BadRequestException("生产环境必须显式设置 PAYMENT_MOCK_ENABLED=false。");
  }

  if (isTruthy(readConfig(configService, "ALLOW_DEFAULT_BACKOFFICE_LOGIN"))) {
    throw new BadRequestException("生产环境不能允许默认后台密码登录。");
  }

  const defaultCredentials = [
    ...store.adminCredentials
      .filter((credential) => credential.usesDefaultPassword)
      .map((credential) => credential.username),
    ...store.backofficeCredentials
      .filter((credential) => credential.usesDefaultPassword)
      .map((credential) => credential.username)
  ];

  if (defaultCredentials.length > 0) {
    throw new BadRequestException(
      `生产环境仍存在默认后台密码账号：${defaultCredentials.join("、")}`
    );
  }
};
