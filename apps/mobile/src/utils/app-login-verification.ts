import type { VerificationProvider } from "@vm/shared-types";

import { isVerificationCode } from "./verification-code";

export interface AppLoginVerificationPresentation {
  guideText: string;
  codeHelper: string;
  canRequestCode: boolean;
}

const loadingPresentation: AppLoginVerificationPresentation = {
  guideText: "确认验证方式后填写验证码完成身份识别",
  codeHelper: "正在确认验证方式",
  canRequestCode: false
};

const manualPresentation: AppLoginVerificationPresentation = {
  guideText: "向实例管理员获取一次性验证码后输入",
  codeHelper: "由实例管理员签发后输入",
  canRequestCode: false
};

const providerPresentation: AppLoginVerificationPresentation = {
  guideText: "获取验证码完成身份识别",
  codeHelper: "勾选下方协议后发送",
  canRequestCode: true
};

const pnvsPresentation: AppLoginVerificationPresentation = {
  guideText: "获取短信验证码登录；已有管理员签发的应急验证码也可直接输入",
  codeHelper: "短信发送后输入，应急验证码可直接使用",
  canRequestCode: true
};

export const resolveAppLoginVerificationPresentation = (
  provider: VerificationProvider | undefined
): AppLoginVerificationPresentation => {
  if (provider === undefined) {
    return loadingPresentation;
  }

  return provider === "manual"
    ? manualPresentation
    : provider === "aliyun_pnvs"
      ? pnvsPresentation
      : providerPresentation;
};

export const isAppLoginVerificationCode = (
  code: string,
  provider: VerificationProvider | undefined
) =>
  provider === "manual"
    ? /^\d{6}$/u.test(code.trim())
    : isVerificationCode(code);
