const MAX_AUDIT_DEPTH = 6;
const MAX_AUDIT_STRING_LENGTH = 4_000;
const MAX_AUDIT_ARRAY_ITEMS = 50;
const MAX_AUDIT_OBJECT_KEYS = 80;

const secretKeys = new Set([
  "apikey",
  "authorization",
  "authcode",
  "buyerid",
  "buyerlogonid",
  "buyeropenid",
  "buyeruserid",
  "clientid",
  "clientsecret",
  "cookie",
  "credential",
  "invitecode",
  "key",
  "otp",
  "otpcode",
  "package",
  "payeralipayuserid",
  "payeridentityhandle",
  "payeropenid",
  "paysign",
  "prepayid",
  "passcode",
  "passwd",
  "password",
  "previewcode",
  "privatekey",
  "quoteid",
  "recoverycode",
  "refreshtoken",
  "secret",
  "sign",
  "signature",
  "signingkey",
  "smscode",
  "token",
  "verificationcode"
]);

const phoneKeys = new Set(["mobile", "mobilephone", "phone", "phonenumber", "telephone", "tel"]);
const identityKeys = new Set([
  "certificatenumber",
  "certno",
  "idcard",
  "idcardnumber",
  "identitynumber"
]);

const isSecretKey = (normalizedKey: string) =>
  secretKeys.has(normalizedKey) ||
  ["authorization", "cookie", "credential", "password", "secret", "token"].some((fragment) =>
    normalizedKey.includes(fragment)
  ) ||
  ["accesskey", "apikey", "encryptionkey", "privatekey", "signingkey"].some((suffix) =>
    normalizedKey.endsWith(suffix) || normalizedKey.startsWith(suffix)
  );

const normalizeKey = (key: string) => key.replace(/[^a-zA-Z0-9]/g, "").toLowerCase();

const maskPhone = (value: string) =>
  value.replace(/(^|\D)(1\d{2})\d{4}(\d{4})(?!\d)/g, "$1$2****$3");

const maskIdentityNumber = (value: string) => {
  if (value.length <= 8) {
    return "[redacted]";
  }

  return `${value.slice(0, 4)}********${value.slice(-4)}`;
};

const maskEmail = (value: string) =>
  value.replace(
    /([a-zA-Z0-9._%+-])([a-zA-Z0-9._%+-]*)(@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,})/g,
    (_match, first: string, middle: string, domain: string) =>
      `${first}${middle ? "***" : ""}${domain}`
  );

const maskEmbeddedIdentityNumbers = (value: string) =>
  value
    .replace(
      /(^|\D)([1-8]\d{5}(?:(?:18|19|20)\d{2})(?:0[1-9]|1[0-2])(?:0[1-9]|[12]\d|3[01])\d{3}[\dXx])(?!\d)/g,
      (_match, prefix: string, identityNumber: string) =>
        `${prefix}${identityNumber.slice(0, 4)}**********${identityNumber.slice(-4)}`
    )
    .replace(
      /(^|\D)([1-8]\d{5}\d{2}(?:0[1-9]|1[0-2])(?:0[1-9]|[12]\d|3[01])\d{3})(?!\d)/g,
      (_match, prefix: string, identityNumber: string) =>
        `${prefix}${identityNumber.slice(0, 4)}*******${identityNumber.slice(-4)}`
    );

const maskEmbeddedSecrets = (value: string) =>
  value
    .replace(/\bBearer\s+[^\s,;]+/gi, "Bearer [redacted]")
    .replace(/\bsk-[a-zA-Z0-9_-]{8,}\b/g, "[redacted]")
    .replace(
      /\b((?:api[_ -]?key|access[_ -]?token|refresh[_ -]?token|password|secret)\s*[:=]\s*)["']?[^\s"',;]+/gi,
      "$1[redacted]"
    );

const maskEmbeddedPersonalData = (value: string) =>
  maskEmbeddedSecrets(maskEmail(maskPhone(maskEmbeddedIdentityNumbers(value))));

const sanitizeUrl = (value: string) => {
  let parsed: URL;

  try {
    parsed = new URL(value);
  } catch {
    return maskEmbeddedPersonalData(value);
  }

  for (const key of Array.from(parsed.searchParams.keys())) {
    const normalized = normalizeKey(key);
    const currentValue = parsed.searchParams.get(key) ?? "";

    if (isSecretKey(normalized)) {
      parsed.searchParams.set(key, "[redacted]");
    } else if (phoneKeys.has(normalized)) {
      parsed.searchParams.set(key, maskPhone(currentValue));
    }
  }

  return maskEmbeddedPersonalData(parsed.toString());
};

const sanitizeString = (value: string, normalizedKey?: string) => {
  let sanitized = normalizedKey?.endsWith("url") ? sanitizeUrl(value) : maskEmbeddedPersonalData(value);

  if (identityKeys.has(normalizedKey ?? "")) {
    sanitized = maskIdentityNumber(sanitized);
  }

  if (sanitized.length > MAX_AUDIT_STRING_LENGTH) {
    return `${sanitized.slice(0, MAX_AUDIT_STRING_LENGTH)}...[truncated ${sanitized.length - MAX_AUDIT_STRING_LENGTH} chars]`;
  }

  return sanitized;
};

const sanitizeValue = (
  value: unknown,
  depth: number,
  seen: WeakSet<object>,
  normalizedKey?: string
): unknown => {
  if (value === undefined || value === null) {
    return value;
  }

  // `code` 同时用于短信验证码和通用 API 状态码；只隐藏像验证码的字符串，保留 200/SUCCESS 等审计语义。
  if (
    normalizedKey === "code" &&
    typeof value === "string" &&
    /^\d{4,8}$/.test(value.trim())
  ) {
    return "[redacted]";
  }

  if (isSecretKey(normalizedKey ?? "")) {
    return "[redacted]";
  }

  if (typeof value === "string") {
    if (phoneKeys.has(normalizedKey ?? "")) {
      return maskPhone(value);
    }

    return sanitizeString(value, normalizedKey);
  }

  if (typeof value === "number" || typeof value === "boolean") {
    return value;
  }

  if (depth >= MAX_AUDIT_DEPTH) {
    return "[truncated: max depth]";
  }

  if (typeof value !== "object") {
    return sanitizeString(String(value), normalizedKey);
  }

  if (seen.has(value)) {
    return "[circular]";
  }

  seen.add(value);

  if (Array.isArray(value)) {
    const items = value
      .slice(0, MAX_AUDIT_ARRAY_ITEMS)
      .map((item) => sanitizeValue(item, depth + 1, seen));

    if (value.length > MAX_AUDIT_ARRAY_ITEMS) {
      items.push(`[truncated: ${value.length - MAX_AUDIT_ARRAY_ITEMS} more items]`);
    }

    seen.delete(value);
    return items;
  }

  const result: Record<string, unknown> = {};
  const entries = Object.entries(value as Record<string, unknown>);

  for (const [index, [key, nestedValue]] of entries.entries()) {
    if (index >= MAX_AUDIT_OBJECT_KEYS) {
      result.__truncated__ = `${entries.length - MAX_AUDIT_OBJECT_KEYS} more keys`;
      break;
    }

    result[key] = sanitizeValue(nestedValue, depth + 1, seen, normalizeKey(key));
  }

  seen.delete(value);
  return result;
};

export const sanitizeAuditLogEntry = <T>(entry: T): T =>
  sanitizeValue(entry, 0, new WeakSet<object>()) as T;
