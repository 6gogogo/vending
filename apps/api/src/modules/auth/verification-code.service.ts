import { BadRequestException, Inject, Injectable, InternalServerErrorException } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import SmsClient from "@alicloud/dysmsapi20170525";
import { Config as AliyunOpenApiConfig } from "@alicloud/openapi-core/dist/utils";
import { RequiredPhoneCodeRequest } from "@alicloud/dysmsapi20170525/dist/models/RequiredPhoneCodeRequest";
import { RequiredPhoneCodeResponseBody } from "@alicloud/dysmsapi20170525/dist/models/RequiredPhoneCodeResponseBody";
import { ValidPhoneCodeRequest } from "@alicloud/dysmsapi20170525/dist/models/ValidPhoneCodeRequest";
import { ValidPhoneCodeResponseBody } from "@alicloud/dysmsapi20170525/dist/models/ValidPhoneCodeResponseBody";

import { InMemoryStoreService } from "../../common/store/in-memory-store.service";

type VerificationProvider = "mock" | "aliyun";

interface VerificationCodeResult {
  phone: string;
  expiresInSeconds: number;
  provider: VerificationProvider;
  previewCode?: string;
}

const mainlandPhonePattern = /^1\d{10}$/;
const verificationCodePattern = /^\d{4,8}$/;

@Injectable()
export class VerificationCodeService {
  constructor(
    @Inject(ConfigService) private readonly configService: ConfigService,
    @Inject(InMemoryStoreService) private readonly store: InMemoryStoreService
  ) {}

  async requestCode(phone: string): Promise<VerificationCodeResult> {
    const normalizedPhone = this.normalizePhone(phone);

    if (this.getProvider() === "aliyun") {
      await this.requestAliyunCode(normalizedPhone);
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

    if (
      typeof SmsClient !== "function" ||
      typeof RequiredPhoneCodeRequest !== "function" ||
      typeof ValidPhoneCodeRequest !== "function"
    ) {
      throw new InternalServerErrorException("短信验证码服务依赖未正确安装。");
    }

    return new SmsClient(
      new AliyunOpenApiConfig({
      accessKeyId,
      accessKeySecret,
      regionId,
      endpoint
      })
    );
  }

  private async requestAliyunCode(phone: string) {
    try {
      const client = this.createAliyunClient();
      const request = new RequiredPhoneCodeRequest({
        phoneNo: phone
      });
      const response = await client.requiredPhoneCode(request);
      const body: RequiredPhoneCodeResponseBody = response?.body ?? new RequiredPhoneCodeResponseBody();

      if (!(body.code === "OK" || body.success === true)) {
        throw new Error(body.message || "短信验证码发送失败。");
      }
    } catch (error) {
      throw this.wrapAliyunError(error, "短信验证码发送失败。");
    }
  }

  private async verifyAliyunCode(phone: string, code: string) {
    try {
      const client = this.createAliyunClient();
      const request = new ValidPhoneCodeRequest({
        phoneNo: phone,
        certifyCode: code
      });
      const response = await client.validPhoneCode(request);
      const body: ValidPhoneCodeResponseBody = response?.body ?? new ValidPhoneCodeResponseBody();
      return Boolean((body.code === "OK" || body.success === true) && body.data);
    } catch (error) {
      throw this.wrapAliyunError(error, "短信验证码校验失败。");
    }
  }

  private wrapAliyunError(error: unknown, fallback: string) {
    if (error instanceof BadRequestException || error instanceof InternalServerErrorException) {
      return error;
    }

    if (error instanceof Error) {
      return new BadRequestException(error.message || fallback);
    }

    return new BadRequestException(fallback);
  }
}
