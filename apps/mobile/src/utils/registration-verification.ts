import type { VerificationProvider } from "@vm/shared-types";

export interface RegistrationVerificationPresentation {
  canSubmitSelfService: boolean;
  title: string;
  detail: string;
}

const loadingPresentation: RegistrationVerificationPresentation = {
  canSubmitSelfService: false,
  title: "正在确认注册方式",
  detail: "请稍候，系统会先确认当前实例是否开放自助注册。"
};

const manualPresentation: RegistrationVerificationPresentation = {
  canSubmitSelfService: false,
  title: "请联系实例管理员建档",
  detail:
    "当前实例使用人工验证码。管理员会先完成账号建档和审核，再为已启用账号签发一次性登录码；本页不会发送短信或提交自助注册申请。"
};

const providerPresentation: RegistrationVerificationPresentation = {
  canSubmitSelfService: true,
  title: "提交注册申请",
  detail: "填写必要资料并完成验证码核验后，工作人员会进行审核。"
};

export const resolveRegistrationVerificationPresentation = (
  provider: VerificationProvider | undefined
): RegistrationVerificationPresentation => {
  if (provider === undefined) {
    return loadingPresentation;
  }

  return provider === "manual" ? manualPresentation : providerPresentation;
};
