import { BadRequestException, Inject, Injectable, InternalServerErrorException } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { timingSafeEqual } from "node:crypto";
import Dypnsapi20170525Module, {
  CheckSmsVerifyCodeRequest,
  SendSmsVerifyCodeRequest
} from "@alicloud/dypnsapi20170525";
import { $OpenApiUtil } from "@alicloud/openapi-core";
import type { VerificationProvider } from "@vm/shared-types";

import { isProductionRuntime } from "../../common/config/production-safety";
import { resolveFullSimulationExternalMode } from "../../common/config/full-simulation-mode";
import { assertConfiguredRuntimeDataPlaneVerificationPolicy } from "../../common/config/runtime-data-plane-policy";
import { InMemoryStoreService } from "../../common/store/in-memory-store.service";
import type { VerificationPurpose } from "../../common/store/persistence";

interface VerificationCodeResult {
  phone: string;
  expiresInSeconds: number;
  provider: VerificationProvider;
  previewCode?: string;
}

const mainlandPhonePattern = /^1\d{10}$/;
const verificationCodePattern = /^\d{4,8}$/;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

type Dypnsapi20170525Constructor = typeof Dypnsapi20170525Module;

const resolveDypnsapi20170525Constructor = (
  moduleValue: unknown
): Dypnsapi20170525Constructor => {
  const constructor =
    typeof moduleValue === "function"
      ? moduleValue
      : isRecord(moduleValue)
        ? moduleValue.default
        : undefined;

  if (typeof constructor !== "function") {
    throw new InternalServerErrorException("短信验证码 SDK 初始化失败。");
  }

  return constructor as Dypnsapi20170525Constructor;
};

@Injectable()
export class VerificationCodeService {
  constructor(
    @Inject(ConfigService) private readonly configService: ConfigService,
    @Inject(InMemoryStoreService) private readonly store: InMemoryStoreService
  ) {}

  async requestCode(
    phone: string,
    purpose: VerificationPurpose = "general"
  ): Promise<VerificationCodeResult> {
    const normalizedPhone = this.normalizePhone(phone);
    const normalizedPurpose = this.normalizePurpose(purpose);
    this.assertCanRequestCode(normalizedPhone, normalizedPurpose);

    const provider = this.getProvider();

    if (provider === "aliyun_pnvs") {
      await this.requestAliyunPnvsCode(normalizedPhone, normalizedPurpose);
      this.store.rememberVerificationRequest(normalizedPhone, normalizedPurpose);
      return {
        phone: normalizedPhone,
        expiresInSeconds: 300,
        provider: "aliyun_pnvs"
      };
    }

    if (provider === "manual") {
      this.store.rememberVerificationRequest(normalizedPhone, normalizedPurpose);
      return {
        phone: normalizedPhone,
        expiresInSeconds: 300,
        provider: "manual"
      };
    }

    const code = this.store.issueVerificationCode(normalizedPhone, normalizedPurpose);
    return {
      phone: normalizedPhone,
      expiresInSeconds: 300,
      provider: "mock",
      previewCode: this.isPreviewEnabled() ? code : undefined
    };
  }

  async verifyCode(
    phone: string,
    code: string,
    purpose: VerificationPurpose = "general"
  ): Promise<boolean> {
    const normalizedPhone = this.normalizePhone(phone);
    const normalizedCode = this.normalizeVerificationCode(code);
    const normalizedPurpose = this.normalizePurpose(purpose);

    const provider = this.getProvider();

    if (provider === "aliyun_pnvs") {
      if (!this.store.canAttemptVerification(normalizedPhone, normalizedPurpose)) {
        return false;
      }

      const verified = await this.verifyAliyunPnvsCode(
        normalizedPhone,
        normalizedCode,
        normalizedPurpose
      );

      if (verified) {
        // 以本地一次性状态成功消费为最终结果，避免并发校验同时获得登录资格。
        return this.store.consumeVerificationRequest(normalizedPhone, normalizedPurpose);
      } else {
        this.store.recordVerificationFailure(normalizedPhone, normalizedPurpose);
      }

      return false;
    }

    if (provider === "manual") {
      if (!this.store.canAttemptVerification(normalizedPhone, normalizedPurpose)) {
        return false;
      }

      if (this.matchesManualVerificationCode(normalizedCode)) {
        return this.store.consumeVerificationRequest(normalizedPhone, normalizedPurpose);
      }

      this.store.recordVerificationFailure(normalizedPhone, normalizedPurpose);
      return false;
    }

    return this.store.verifyCode(normalizedPhone, normalizedCode, normalizedPurpose);
  }

  getRuntimeConfig() {
    const provider = this.getProvider();

    return {
      provider,
      previewEnabled: provider === "mock" && this.isPreviewEnabled()
    };
  }

  private getProvider(): VerificationProvider {
    this.assertRuntimeDataPlaneVerificationPolicy();
    const fullSimulationMode = resolveFullSimulationExternalMode("verification", {
      VM_DATA_PLANE: this.configService.get<string>("VM_DATA_PLANE"),
      VM_SIMULATION_PROFILE: this.configService.get<string>("VM_SIMULATION_PROFILE"),
      VM_FULL_SIMULATION_ENABLED: this.configService.get<string>("VM_FULL_SIMULATION_ENABLED"),
      VM_FULL_SIMULATION_VERIFICATION_MODE: this.configService.get<string>(
        "VM_FULL_SIMULATION_VERIFICATION_MODE"
      )
    });

    if (fullSimulationMode) {
      return fullSimulationMode === "real"
        ? "aliyun_pnvs"
        : fullSimulationMode === "manual"
          ? "manual"
          : "mock";
    }

    const raw = (this.configService.get<string>("VERIFICATION_CODE_PROVIDER") ?? "mock")
      .trim()
      .toLowerCase();

    let provider: VerificationProvider;

    if (!raw || raw === "mock") {
      provider = "mock";
    } else if (raw === "aliyun_pnvs") {
      provider = "aliyun_pnvs";
    } else {
      throw new InternalServerErrorException(
        "VERIFICATION_CODE_PROVIDER 只能设置为 mock 或 aliyun_pnvs。"
      );
    }

    return provider;
  }

  private isPreviewEnabled() {
    const raw = this.configService.get<string>("VERIFICATION_CODE_PREVIEW_ENABLED");

    if (!raw || !["1", "true", "yes", "on"].includes(raw.trim().toLowerCase())) {
      return false;
    }

    return (
      !isProductionRuntime() &&
      !this.isLiveDataPlane() &&
      this.isLocalPublicBaseUrl() &&
      this.isLoopbackApiHost()
    );
  }

  private isLoopbackApiHost() {
    const rawHost = this.configService.get<string>("API_HOST")?.trim();

    if (!rawHost) {
      // 非生产环境未显式配置时，main.ts 默认只监听回环地址。
      return true;
    }

    return ["localhost", "127.0.0.1", "::1", "[::1]"].includes(rawHost.toLowerCase());
  }

  private isLocalPublicBaseUrl() {
    const raw = this.configService.get<string>("PUBLIC_BASE_URL")?.trim();

    if (!raw) {
      return false;
    }

    try {
      const url = new URL(raw);
      return ["localhost", "127.0.0.1", "::1", "[::1]"].includes(url.hostname.toLowerCase());
    } catch {
      return false;
    }
  }

  private assertRuntimeDataPlaneVerificationPolicy() {
    try {
      assertConfiguredRuntimeDataPlaneVerificationPolicy({
        VM_DATA_PLANE: this.configService.get<string>("VM_DATA_PLANE"),
        VM_DATA_ROOT: this.configService.get<string>("VM_DATA_ROOT"),
        VM_DATA_PLANE_ID: this.configService.get<string>("VM_DATA_PLANE_ID"),
        VM_SIMULATION_PROFILE: this.configService.get<string>("VM_SIMULATION_PROFILE"),
        VM_FULL_SIMULATION_ENABLED: this.configService.get<string>("VM_FULL_SIMULATION_ENABLED"),
        VM_FULL_SIMULATION_VERIFICATION_MODE: this.configService.get<string>(
          "VM_FULL_SIMULATION_VERIFICATION_MODE"
        ),
        VERIFICATION_CODE_PROVIDER: this.configService.get<string>(
          "VERIFICATION_CODE_PROVIDER"
        ),
        VERIFICATION_CODE_PREVIEW_ENABLED: this.configService.get<string>(
          "VERIFICATION_CODE_PREVIEW_ENABLED"
        ),
        VERIFICATION_CODE_MANUAL_VALUE: this.configService.get<string>(
          "VERIFICATION_CODE_MANUAL_VALUE"
        ),
        ALIYUN_PNVS_ACCESS_KEY_ID: this.configService.get<string>(
          "ALIYUN_PNVS_ACCESS_KEY_ID"
        ),
        ALIYUN_PNVS_ACCESS_KEY_SECRET: this.configService.get<string>(
          "ALIYUN_PNVS_ACCESS_KEY_SECRET"
        ),
        ALIYUN_PNVS_SIGN_NAME: this.configService.get<string>(
          "ALIYUN_PNVS_SIGN_NAME"
        ),
        ALIYUN_PNVS_TEMPLATE_CODE: this.configService.get<string>(
          "ALIYUN_PNVS_TEMPLATE_CODE"
        ),
        ALIYUN_PNVS_SCHEME_NAME_APP_LOGIN: this.configService.get<string>(
          "ALIYUN_PNVS_SCHEME_NAME_APP_LOGIN"
        ),
        ALIYUN_PNVS_SCHEME_NAME_REGISTER: this.configService.get<string>(
          "ALIYUN_PNVS_SCHEME_NAME_REGISTER"
        ),
        ALIYUN_PNVS_SCHEME_NAME_GENERAL: this.configService.get<string>(
          "ALIYUN_PNVS_SCHEME_NAME_GENERAL"
        ),
        ALIYUN_PNVS_SCHEME_NAME_PASSWORD_RESET: this.configService.get<string>(
          "ALIYUN_PNVS_SCHEME_NAME_PASSWORD_RESET"
        )
      });
    } catch (error) {
      throw new InternalServerErrorException(
        error instanceof Error ? error.message : "验证码数据平面配置无效。"
      );
    }
  }

  private isLiveDataPlane() {
    const store = this.store as unknown as {
      isLiveDataPlane?: () => boolean;
    };

    if (typeof store.isLiveDataPlane === "function") {
      return store.isLiveDataPlane();
    }

    return this.configService.get<string>("VM_DATA_PLANE")?.trim().toLowerCase() === "live";
  }

  private matchesManualVerificationCode(code: string) {
    const configuredCode =
      this.configService.get<string>("VERIFICATION_CODE_MANUAL_VALUE")?.trim() ?? "";

    if (!verificationCodePattern.test(configuredCode)) {
      throw new InternalServerErrorException(
        "全真模拟手动验证码必须通过 VERIFICATION_CODE_MANUAL_VALUE 设置为 4 至 8 位数字。"
      );
    }

    const expected = Buffer.from(configuredCode, "utf8");
    const received = Buffer.from(code, "utf8");

    return expected.length === received.length && timingSafeEqual(expected, received);
  }

  private normalizePhone(phone: string) {
    const normalizedPhone = String(phone ?? "").trim();

    if (!mainlandPhonePattern.test(normalizedPhone)) {
      throw new BadRequestException("请输入 11 位手机号。");
    }

    return normalizedPhone;
  }

  private normalizeVerificationCode(code: string) {
    const normalizedCode = String(code ?? "").trim();

    if (!verificationCodePattern.test(normalizedCode)) {
      throw new BadRequestException("请输入正确的验证码。");
    }

    return normalizedCode;
  }

  private normalizePurpose(purpose: VerificationPurpose): VerificationPurpose {
    if (purpose === "app-login" || purpose === "register" || purpose === "password-reset") {
      return purpose;
    }

    return "general";
  }

  private assertCanRequestCode(phone: string, purpose: VerificationPurpose) {
    const existing = this.store.getVerificationRecord(phone, purpose);
    const nextAvailableAt = existing?.resendAvailableAt
      ? new Date(existing.resendAvailableAt).getTime()
      : 0;

    if (nextAvailableAt > Date.now()) {
      throw new BadRequestException("验证码发送过于频繁，请稍后再试。");
    }
  }

  private createAliyunPnvsClient() {
    const accessKeyId = this.configService.get<string>("ALIYUN_PNVS_ACCESS_KEY_ID")?.trim();
    const accessKeySecret = this.configService
      .get<string>("ALIYUN_PNVS_ACCESS_KEY_SECRET")
      ?.trim();
    const regionId =
      this.configService.get<string>("ALIYUN_PNVS_REGION_ID")?.trim() || "cn-hangzhou";
    const endpoint =
      this.configService.get<string>("ALIYUN_PNVS_ENDPOINT")?.trim() || "dypnsapi.aliyuncs.com";

    if (!accessKeyId || !accessKeySecret) {
      throw new InternalServerErrorException("短信验证码服务未完成配置。");
    }

    const config = new $OpenApiUtil.Config({
      accessKeyId,
      accessKeySecret,
    });
    config.regionId = regionId;
    config.endpoint = endpoint;

    const Dypnsapi20170525 = resolveDypnsapi20170525Constructor(
      Dypnsapi20170525Module as unknown
    );
    return new Dypnsapi20170525(config);
  }

  private async requestAliyunPnvsCode(phone: string, purpose: VerificationPurpose) {
    try {
      const schemeName = this.getAliyunPnvsSchemeName(purpose);
      const request = new SendSmsVerifyCodeRequest({
        phoneNumber: phone,
        countryCode: "86",
        ...(schemeName ? { schemeName } : {}),
        signName: this.requireAliyunPnvsConfig("ALIYUN_PNVS_SIGN_NAME"),
        templateCode: this.requireAliyunPnvsConfig("ALIYUN_PNVS_TEMPLATE_CODE"),
        templateParam: JSON.stringify({ code: "##code##" }),
        returnVerifyCode: false,
        codeLength: 6,
        codeType: 1,
        validTime: 300,
        interval: 60,
        duplicatePolicy: 1,
        autoRetry: 0
      });
      const response = await this.createAliyunPnvsClient().sendSmsVerifyCode(request);
      const body = isRecord(response.body) ? response.body : ({} as Record<string, unknown>);

      if (!(body.code === "OK" || body.success === true)) {
        throw new Error(
          typeof body.message === "string" && body.message ? body.message : "短信验证码发送失败。"
        );
      }
    } catch (error) {
      throw this.wrapAliyunPnvsError(error, "短信验证码发送失败。");
    }
  }

  private async verifyAliyunPnvsCode(
    phone: string,
    code: string,
    purpose: VerificationPurpose
  ) {
    try {
      const schemeName = this.getAliyunPnvsSchemeName(purpose);
      const request = new CheckSmsVerifyCodeRequest({
        phoneNumber: phone,
        countryCode: "86",
        ...(schemeName ? { schemeName } : {}),
        verifyCode: code
      });
      const response = await this.createAliyunPnvsClient().checkSmsVerifyCode(request);
      const body = isRecord(response.body) ? response.body : ({} as Record<string, unknown>);
      const model = isRecord(body.model) ? body.model : undefined;
      return Boolean(
        (body.code === "OK" || body.success === true) && model?.verifyResult === "PASS"
      );
    } catch (error) {
      throw this.wrapAliyunPnvsError(error, "短信验证码校验失败。");
    }
  }

  private getAliyunPnvsSchemeName(purpose: VerificationPurpose) {
    const key =
      purpose === "app-login"
        ? "ALIYUN_PNVS_SCHEME_NAME_APP_LOGIN"
        : purpose === "register"
          ? "ALIYUN_PNVS_SCHEME_NAME_REGISTER"
          : purpose === "password-reset"
            ? "ALIYUN_PNVS_SCHEME_NAME_PASSWORD_RESET"
            : "ALIYUN_PNVS_SCHEME_NAME_GENERAL";
    return this.configService.get<string>(key)?.trim() || undefined;
  }

  private requireAliyunPnvsConfig(key: string) {
    const value = this.configService.get<string>(key)?.trim();

    if (!value) {
      throw new InternalServerErrorException("短信验证码服务未完成配置。");
    }

    return value;
  }

  private wrapAliyunPnvsError(error: unknown, fallback: string) {
    if (error instanceof BadRequestException || error instanceof InternalServerErrorException) {
      return error;
    }

    const detail = isRecord(error)
      ? isRecord(error.data)
        ? error.data.Recommend ??
          error.data.Message ??
          error.data.message ??
          error.message
        : error.message
      : undefined;

    if (error instanceof Error) {
      return new BadRequestException((typeof detail === "string" && detail) || error.message || fallback);
    }

    return new BadRequestException((typeof detail === "string" && detail) || fallback);
  }
}
