import { BadRequestException, Inject, Injectable, InternalServerErrorException } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import * as Dysmsapi20170525 from "@alicloud/dysmsapi20170525";

import { InMemoryStoreService } from "../../common/store/in-memory-store.service";

type VerificationProvider = "mock" | "aliyun";
type Constructor<T = unknown> = new (...args: any[]) => T;
type AliyunResponse = { body?: Record<string, unknown> };

interface AliyunSmsClient {
  requiredPhoneCode(request: unknown): Promise<AliyunResponse>;
  validPhoneCode(request: unknown): Promise<AliyunResponse>;
}

interface AliyunSmsRuntime {
  SmsClient: Constructor<AliyunSmsClient>;
  RequiredPhoneCodeRequest: Constructor;
  ValidPhoneCodeRequest: Constructor;
}

interface VerificationCodeResult {
  phone: string;
  expiresInSeconds: number;
  provider: VerificationProvider;
  previewCode?: string;
}

const mainlandPhonePattern = /^1\d{10}$/;
const verificationCodePattern = /^\d{4,8}$/;

const dysmsapiExports =
  ((Dysmsapi20170525 as { default?: unknown }).default as Record<string, unknown> | undefined) ??
  (Dysmsapi20170525 as unknown as Record<string, unknown>);

const SmsClient = (dysmsapiExports.default ?? dysmsapiExports) as Constructor;
const RequiredPhoneCodeRequest = (dysmsapiExports.RequiredPhoneCodeRequest ??
  (dysmsapiExports.models as Record<string, unknown> | undefined)?.RequiredPhoneCodeRequest) as
  | Constructor
  | undefined;
const ValidPhoneCodeRequest = (dysmsapiExports.ValidPhoneCodeRequest ??
  (dysmsapiExports.models as Record<string, unknown> | undefined)?.ValidPhoneCodeRequest) as
  | Constructor
  | undefined;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

const resolveAliyunSmsRuntime = (): AliyunSmsRuntime => {
  if (
    typeof SmsClient !== "function" ||
    typeof RequiredPhoneCodeRequest !== "function" ||
    typeof ValidPhoneCodeRequest !== "function"
  ) {
    throw new InternalServerErrorException("短信验证码服务依赖未正确安装。");
  }

  return {
    SmsClient: SmsClient as Constructor<AliyunSmsClient>,
    RequiredPhoneCodeRequest,
    ValidPhoneCodeRequest
  };
};

@Injectable()
export class VerificationCodeService {
  constructor(
    @Inject(ConfigService) private readonly configService: ConfigService,
    @Inject(InMemoryStoreService) private readonly store: InMemoryStoreService
  ) {}

  async requestCode(phone: string): Promise<VerificationCodeResult> {
    const normalizedPhone = this.normalizePhone(phone);
    const remainingCooldownSeconds = this.getRemainingCooldownSeconds(normalizedPhone);

    if (remainingCooldownSeconds > 0) {
      throw new BadRequestException(`验证码已发送，请在 ${remainingCooldownSeconds}s 后重试。`);
    }

    if (this.getProvider() === "aliyun") {
      await this.requestAliyunCode(normalizedPhone);
      this.store.rememberVerificationRequest(normalizedPhone);
      return {
        phone: normalizedPhone,
        expiresInSeconds: 300,
        provider: "aliyun"
      };
    }

    const code = this.store.issueVerificationCode(normalizedPhone);
    return {
      phone: normalizedPhone,
      expiresInSeconds: 300,
      provider: "mock",
      previewCode: this.isPreviewEnabled() ? code : undefined
    };
  }

  async verifyCode(phone: string, code: string): Promise<boolean> {
    const normalizedPhone = this.normalizePhone(phone);
    const normalizedCode = this.normalizeVerificationCode(code);

    if (this.getProvider() === "aliyun") {
      return this.verifyAliyunCode(normalizedPhone, normalizedCode);
    }

    return this.store.verifyCode(normalizedPhone, normalizedCode);
  }

  getRuntimeConfig() {
    const provider = this.getProvider();

    return {
      provider,
      previewEnabled: provider === "mock" && this.isPreviewEnabled()
    };
  }

  private getProvider(): VerificationProvider {
    const raw = (this.configService.get<string>("VERIFICATION_CODE_PROVIDER") ?? "mock")
      .trim()
      .toLowerCase();

    return raw === "aliyun" ? "aliyun" : "mock";
  }

  private isPreviewEnabled() {
    const raw = this.configService.get<string>("VERIFICATION_CODE_PREVIEW_ENABLED");

    if (raw === undefined) {
      return this.getProvider() === "mock";
    }

    return ["1", "true", "yes", "on"].includes(raw.trim().toLowerCase());
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

  private createAliyunClient() {
    const accessKeyId = this.configService.get<string>("ALIYUN_SMS_ACCESS_KEY_ID")?.trim();
    const accessKeySecret = this.configService
      .get<string>("ALIYUN_SMS_ACCESS_KEY_SECRET")
      ?.trim();
    const regionId =
      this.configService.get<string>("ALIYUN_SMS_REGION_ID")?.trim() || "cn-hangzhou";
    const endpoint =
      this.configService.get<string>("ALIYUN_SMS_ENDPOINT")?.trim() || "dysmsapi.aliyuncs.com";

    if (!accessKeyId || !accessKeySecret) {
      throw new InternalServerErrorException("短信验证码服务未完成配置。");
    }

    const runtime = resolveAliyunSmsRuntime();

    return new runtime.SmsClient({
      accessKeyId,
      accessKeySecret,
      regionId,
      endpoint
    });
  }

  private getRemainingCooldownSeconds(phone: string) {
    const resendAvailableAt = this.store.verificationCodes.get(phone)?.resendAvailableAt;

    if (!resendAvailableAt) {
      return 0;
    }

    const remainingMs = new Date(resendAvailableAt).getTime() - Date.now();
    return remainingMs > 0 ? Math.ceil(remainingMs / 1000) : 0;
  }

  private async requestAliyunCode(phone: string) {
    try {
      const runtime = resolveAliyunSmsRuntime();
      const client = this.createAliyunClient();
      const request = new runtime.RequiredPhoneCodeRequest({
        phoneNo: phone
      });
      const response = await client.requiredPhoneCode(request);
      const body = isRecord(response) && isRecord(response.body) ? response.body : {};

      if (!(body.code === "OK" || body.success === true)) {
        throw new Error(
          typeof body.message === "string" && body.message ? body.message : "短信验证码发送失败。"
        );
      }
    } catch (error) {
      throw this.wrapAliyunError(error, "短信验证码发送失败。");
    }
  }

  private async verifyAliyunCode(phone: string, code: string) {
    try {
      const runtime = resolveAliyunSmsRuntime();
      const client = this.createAliyunClient();
      const request = new runtime.ValidPhoneCodeRequest({
        phoneNo: phone,
        certifyCode: code
      });
      const response = await client.validPhoneCode(request);
      const body = isRecord(response) && isRecord(response.body) ? response.body : {};
      return Boolean((body.code === "OK" || body.success === true) && body.data);
    } catch (error) {
      throw this.wrapAliyunError(error, "短信验证码校验失败。");
    }
  }

  private wrapAliyunError(error: unknown, fallback: string) {
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
