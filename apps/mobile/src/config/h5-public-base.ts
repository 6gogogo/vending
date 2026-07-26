const defaultMobileH5PublicBase = "/";

export const resolveMobileH5PublicBase = (configuredBase?: string) => {
  const normalizedBase = String(configuredBase ?? "").trim();

  if (!normalizedBase) {
    return defaultMobileH5PublicBase;
  }

  if (
    !normalizedBase.startsWith("/") ||
    normalizedBase.startsWith("//") ||
    !normalizedBase.endsWith("/") ||
    /[?#]/.test(normalizedBase)
  ) {
    throw new Error("移动 H5 发布基路径必须是以单个 / 开头并以 / 结尾的绝对路径");
  }

  return normalizedBase;
};
