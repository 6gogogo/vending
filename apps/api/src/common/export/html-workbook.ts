const SPREADSHEET_FORMULA_PREFIX = /^[\s\u0000-\u001f\u007f-\u009f\u200b-\u200d\u2060\ufeff]*[=+\-@]/u;

const escapeHtml = (value: string) =>
  value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");

/**
 * HTML 版 XLS 单元格需要同时防 HTML 注入和表格公式注入。
 * 数值保持数值语义；字符串若以公式触发字符开头，则先加单引号强制按文本打开。
 */
export const toSafeSpreadsheetCell = (value: unknown) => {
  if (value === undefined || value === null) {
    return "";
  }

  const text = String(value);
  const neutralized =
    typeof value === "string" && SPREADSHEET_FORMULA_PREFIX.test(text) ? `'${text}` : text;

  return escapeHtml(neutralized);
};

export const toSafeFilenameSegment = (value: unknown, fallback = "export") => {
  const normalized = String(value ?? "")
    .normalize("NFKC")
    .replace(/[\u0000-\u001f\u007f<>:"/\\|?*]/g, "-")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^[.\- ]+|[.\- ]+$/g, "")
    .slice(0, 80);

  return normalized || fallback;
};
