export interface PlatformTenantDraftForValidation {
  code: string;
  name: string;
  contactPhone?: string;
  firstAdmin: {
    name: string;
    phone: string;
    username: string;
    password: string;
  };
}

export interface PlatformTenantUpdateDraftForValidation {
  name: string;
  status: "active" | "trial" | "paused";
  instanceUrl?: string;
  contactPhone?: string;
}

const tenantCodePattern = /^[a-z0-9][a-z0-9-]{1,49}$/u;
const phonePattern = /^1\d{10}$/u;

export const validatePlatformTenantDraft = (
  draft: PlatformTenantDraftForValidation
): string | undefined => {
  const code = draft.code.trim().toLowerCase();
  const name = draft.name.trim();
  const contactPhone = draft.contactPhone?.trim() ?? "";
  const firstAdminName = draft.firstAdmin.name.trim();
  const firstAdminPhone = draft.firstAdmin.phone.trim();
  const username = draft.firstAdmin.username.trim();

  if (!tenantCodePattern.test(code)) {
    return "实例编码需为 2 至 50 位小写字母、数字或连字符。";
  }

  if (!name || [...name].length > 100 || /[\r\n]/u.test(name)) {
    return "实例名称需为 1 至 100 个字符的单行文本。";
  }

  if (contactPhone && !phonePattern.test(contactPhone)) {
    return "实例联系人手机号格式不正确。";
  }

  if (
    !firstAdminName ||
    [...firstAdminName].length > 100 ||
    /[\r\n]/u.test(firstAdminName)
  ) {
    return "首管理员姓名需为 1 至 100 个字符的单行文本。";
  }

  if (!phonePattern.test(firstAdminPhone)) {
    return "首管理员手机号格式不正确。";
  }

  if (!username || username.length > 100 || /[\r\n]/u.test(username)) {
    return "首管理员后台账号格式不正确。";
  }

  if (draft.firstAdmin.password.trim().length < 12) {
    return "首管理员后台密码至少需要 12 位。";
  }

  return undefined;
};

export const validatePlatformTenantUpdateDraft = (
  draft: PlatformTenantUpdateDraftForValidation
): string | undefined => {
  const name = draft.name.trim();
  const contactPhone = draft.contactPhone?.trim() ?? "";
  const instanceUrl = draft.instanceUrl?.trim() ?? "";

  if (!name || [...name].length > 100 || /[\r\n]/u.test(name)) {
    return "实例名称需为 1 至 100 个字符的单行文本。";
  }

  if (!["active", "trial", "paused"].includes(draft.status)) {
    return "请选择有效的实例状态。";
  }

  if (contactPhone && !phonePattern.test(contactPhone)) {
    return "实例联系人手机号格式不正确。";
  }

  if (instanceUrl) {
    try {
      const parsed = new URL(instanceUrl);
      if (
        (parsed.protocol !== "https:" && parsed.protocol !== "http:") ||
        parsed.username ||
        parsed.password ||
        parsed.search ||
        parsed.hash
      ) {
        return "实例地址必须是不含账号、查询参数或片段的 HTTP(S) URL。";
      }
    } catch {
      return "实例地址必须是有效的完整 URL。";
    }
  }

  return undefined;
};

export const isManualVerificationCode = (value: string) => /^\d{6}$/u.test(value);

export const manualCodeFromRandomValue = (value: number) => {
  const unsignedValue = Math.trunc(value) >>> 0;
  return String(100_000 + (unsignedValue % 900_000));
};
