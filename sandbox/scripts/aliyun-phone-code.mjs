import Dypnsapi20170525, {
  CheckSmsVerifyCodeRequest,
  SendSmsVerifyCodeRequest
} from "@alicloud/dypnsapi20170525";
import { $OpenApiUtil } from "@alicloud/openapi-core";

import "./helpers.mjs";

const defaultAliyunPnvsConfig = {
  regionId: "cn-hangzhou",
  endpoint: "dypnsapi.aliyuncs.com"
};

const mainlandPhonePattern = /^(?:\+?86)?1\d{10}$/;
const verificationCodePattern = /^\d{4,8}$/;

const normalizePhoneNumber = (phoneNumber) => {
  const digitsOnly = String(phoneNumber ?? "").replace(/[^\d+]/g, "");

  if (digitsOnly.startsWith("+86")) return digitsOnly.slice(3);
  if (digitsOnly.startsWith("0086")) return digitsOnly.slice(4);
  if (digitsOnly.startsWith("86") && digitsOnly.length === 13) return digitsOnly.slice(2);
  return digitsOnly;
};

const maskPhoneNumber = (phoneNumber) => {
  const normalized = normalizePhoneNumber(phoneNumber);
  return normalized.length < 7
    ? normalized
    : `${normalized.slice(0, 3)}****${normalized.slice(-4)}`;
};

const getAliyunPnvsConfig = () => ({
  accessKeyId: process.env.ALIYUN_PNVS_ACCESS_KEY_ID?.trim() ?? "",
  accessKeySecret: process.env.ALIYUN_PNVS_ACCESS_KEY_SECRET?.trim() ?? "",
  regionId: process.env.ALIYUN_PNVS_REGION_ID?.trim() || defaultAliyunPnvsConfig.regionId,
  endpoint: process.env.ALIYUN_PNVS_ENDPOINT?.trim() || defaultAliyunPnvsConfig.endpoint,
  signName: process.env.ALIYUN_PNVS_SIGN_NAME?.trim() ?? "",
  templateCode: process.env.ALIYUN_PNVS_TEMPLATE_CODE?.trim() ?? "",
  schemeName: process.env.SANDBOX_PNVS_SCHEME_NAME?.trim() ?? ""
});

const ensureAliyunPnvsConfig = () => {
  const config = getAliyunPnvsConfig();

  if (
    !config.accessKeyId ||
    !config.accessKeySecret ||
    !config.signName ||
    !config.templateCode ||
    !config.schemeName
  ) {
    throw new Error(
      "PNVS sandbox 需要 ALIYUN_PNVS_ACCESS_KEY_ID、ALIYUN_PNVS_ACCESS_KEY_SECRET、ALIYUN_PNVS_SIGN_NAME、ALIYUN_PNVS_TEMPLATE_CODE 和显式 SANDBOX_PNVS_SCHEME_NAME。"
    );
  }

  return config;
};

const validateMainlandPhoneNumber = (phoneNumber) => {
  const normalized = normalizePhoneNumber(phoneNumber);

  if (!mainlandPhonePattern.test(normalized)) {
    throw new Error("手机号格式不正确，请传入 11 位中国大陆手机号。");
  }

  return normalized;
};

const validateVerificationCode = (verificationCode) => {
  const normalized = String(verificationCode ?? "").trim();

  if (!verificationCodePattern.test(normalized)) {
    throw new Error("验证码格式不正确，请传入 4 到 8 位数字验证码。");
  }

  return normalized;
};

const createPnvsClient = () => {
  const config = ensureAliyunPnvsConfig();
  const openApiConfig = new $OpenApiUtil.Config({
    accessKeyId: config.accessKeyId,
    accessKeySecret: config.accessKeySecret
  });
  openApiConfig.regionId = config.regionId;
  openApiConfig.endpoint = config.endpoint;
  return {
    client: new Dypnsapi20170525(openApiConfig),
    config
  };
};

const normalizeResponse = (phoneNumber, response, verified = false) => {
  const body = response?.body ?? {};
  return {
    phoneNumber: maskPhoneNumber(phoneNumber),
    success: body.code === "OK" || body.success === true,
    verified,
    requestId: body.requestId ?? "",
    responseCode: body.code ?? "",
    message: body.message ?? ""
  };
};

const wrapAliyunPnvsError = (error) => {
  const detail =
    error?.data?.Recommend ??
    error?.data?.Message ??
    error?.data?.message ??
    error?.message;
  return new Error(detail ? `阿里云 PNVS 调用失败：${detail}` : "阿里云 PNVS 调用失败。");
};

export const requestPhoneCode = async (phoneNumber) => {
  const normalizedPhoneNumber = validateMainlandPhoneNumber(phoneNumber);
  const { client, config } = createPnvsClient();

  try {
    const response = await client.sendSmsVerifyCode(
      new SendSmsVerifyCodeRequest({
        phoneNumber: normalizedPhoneNumber,
        countryCode: "86",
        schemeName: config.schemeName,
        signName: config.signName,
        templateCode: config.templateCode,
        templateParam: JSON.stringify({ code: "##code##" }),
        returnVerifyCode: false,
        codeLength: 6,
        codeType: 1,
        validTime: 300,
        interval: 60,
        duplicatePolicy: 1,
        autoRetry: 0
      })
    );
    return normalizeResponse(normalizedPhoneNumber, response);
  } catch (error) {
    throw wrapAliyunPnvsError(error);
  }
};

export const verifyPhoneCode = async (phoneNumber, verificationCode) => {
  const normalizedPhoneNumber = validateMainlandPhoneNumber(phoneNumber);
  const normalizedVerificationCode = validateVerificationCode(verificationCode);
  const { client, config } = createPnvsClient();

  try {
    const response = await client.checkSmsVerifyCode(
      new CheckSmsVerifyCodeRequest({
        phoneNumber: normalizedPhoneNumber,
        countryCode: "86",
        schemeName: config.schemeName,
        verifyCode: normalizedVerificationCode
      })
    );
    const verified = response.body?.model?.verifyResult === "PASS";
    return normalizeResponse(normalizedPhoneNumber, response, verified);
  } catch (error) {
    throw wrapAliyunPnvsError(error);
  }
};
