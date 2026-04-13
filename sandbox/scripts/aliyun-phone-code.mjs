import * as Dysmsapi20170525 from "@alicloud/dysmsapi20170525";

import "./helpers.mjs";

const packageExports = Dysmsapi20170525.default ?? Dysmsapi20170525;
const SmsClient = packageExports.default ?? packageExports;
const RequiredPhoneCodeRequest = packageExports.RequiredPhoneCodeRequest;
const ValidPhoneCodeRequest = packageExports.ValidPhoneCodeRequest;

if (
  typeof SmsClient !== "function" ||
  typeof RequiredPhoneCodeRequest !== "function" ||
  typeof ValidPhoneCodeRequest !== "function"
) {
  throw new Error("阿里云短信 SDK 加载失败，请检查 @alicloud/dysmsapi20170525 的安装结果。");
}

const defaultAliyunSmsConfig = {
  regionId: "cn-hangzhou",
  endpoint: "dysmsapi.aliyuncs.com"
};

const mainlandPhonePattern = /^(?:\+?86)?1\d{10}$/;
const verificationCodePattern = /^\d{4,8}$/;

const normalizePhoneNumber = (phoneNumber) => {
  const digitsOnly = String(phoneNumber ?? "").replace(/[^\d+]/g, "");

  if (!digitsOnly) {
    return "";
  }

  if (digitsOnly.startsWith("+86")) {
    return digitsOnly.slice(3);
  }

  if (digitsOnly.startsWith("0086")) {
    return digitsOnly.slice(4);
  }

  if (digitsOnly.startsWith("86") && digitsOnly.length === 13) {
    return digitsOnly.slice(2);
  }

  return digitsOnly;
};

const maskPhoneNumber = (phoneNumber) => {
  const normalized = normalizePhoneNumber(phoneNumber);

  if (normalized.length < 7) {
    return normalized;
  }

  return `${normalized.slice(0, 3)}****${normalized.slice(-4)}`;
};

const getAliyunSmsConfig = () => ({
  accessKeyId: process.env.ALIYUN_SMS_ACCESS_KEY_ID?.trim() ?? "",
  accessKeySecret: process.env.ALIYUN_SMS_ACCESS_KEY_SECRET?.trim() ?? "",
  regionId: process.env.ALIYUN_SMS_REGION_ID?.trim() || defaultAliyunSmsConfig.regionId,
  endpoint: process.env.ALIYUN_SMS_ENDPOINT?.trim() || defaultAliyunSmsConfig.endpoint
});

const ensureAliyunSmsConfig = () => {
  const config = getAliyunSmsConfig();

  if (!config.accessKeyId || !config.accessKeySecret) {
    throw new Error(
      "必须提供 ALIYUN_SMS_ACCESS_KEY_ID 和 ALIYUN_SMS_ACCESS_KEY_SECRET，才能调用阿里云短信验证码服务。"
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

const createSmsClient = () => {
  const config = ensureAliyunSmsConfig();

  return new SmsClient({
    accessKeyId: config.accessKeyId,
    accessKeySecret: config.accessKeySecret,
    regionId: config.regionId,
    endpoint: config.endpoint
  });
};

const normalizeSendResponse = (phoneNumber, response) => {
  const body = response?.body ?? {};
  const success = body.code === "OK" || body.success === true;

  return {
    phoneNumber: maskPhoneNumber(phoneNumber),
    success,
    requestId: body.requestId ?? "",
    responseCode: body.code ?? "",
    message: body.message ?? "",
    traceId: body.data ?? ""
  };
};

const normalizeVerifyResponse = (phoneNumber, response) => {
  const body = response?.body ?? {};
  const verified = Boolean(body.data);
  const success = (body.code === "OK" || body.success === true) && verified;

  return {
    phoneNumber: maskPhoneNumber(phoneNumber),
    success,
    verified,
    requestId: body.requestId ?? "",
    responseCode: body.code ?? "",
    message: body.message ?? ""
  };
};

const wrapAliyunSmsError = (error) => {
  const detail =
    error?.data?.Recommend ??
    error?.data?.Message ??
    error?.data?.message ??
    error?.message;

  return new Error(detail ? `阿里云短信服务调用失败：${detail}` : "阿里云短信服务调用失败。");
};

export const requestPhoneCode = async (phoneNumber) => {
  const normalizedPhoneNumber = validateMainlandPhoneNumber(phoneNumber);
  const client = createSmsClient();

  try {
    const request = new RequiredPhoneCodeRequest({
      phoneNo: normalizedPhoneNumber
    });
    const response = await client.requiredPhoneCode(request);
    return normalizeSendResponse(normalizedPhoneNumber, response);
  } catch (error) {
    throw wrapAliyunSmsError(error);
  }
};

export const verifyPhoneCode = async (phoneNumber, verificationCode) => {
  const normalizedPhoneNumber = validateMainlandPhoneNumber(phoneNumber);
  const normalizedVerificationCode = validateVerificationCode(verificationCode);
  const client = createSmsClient();

  try {
    const request = new ValidPhoneCodeRequest({
      phoneNo: normalizedPhoneNumber,
      certifyCode: normalizedVerificationCode
    });
    const response = await client.validPhoneCode(request);
    return normalizeVerifyResponse(normalizedPhoneNumber, response);
  } catch (error) {
    throw wrapAliyunSmsError(error);
  }
};
