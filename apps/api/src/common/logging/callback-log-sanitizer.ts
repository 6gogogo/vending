import { createHash } from "node:crypto";

import type {
  CallbackLogRecord,
  CallbackLogPayloadSummary,
  CallbackReplayFingerprint
} from "@vm/shared-types";

const VOLATILE_CALLBACK_KEYS = new Set([
  "sign",
  "nonceStr",
  "timestamp",
  "timeStamp",
  "callbackTimestamp",
  "callbackTime"
]);
const SHA256_FINGERPRINT_PATTERN = /^[a-f0-9]{64}$/;

const asRecord = (value: unknown): Record<string, unknown> | undefined =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;

const readString = (value: unknown) =>
  typeof value === "string" && value.trim() ? value.trim() : undefined;

const readFiniteNumber = (value: unknown) =>
  typeof value === "number" && Number.isFinite(value) ? value : undefined;

const readFingerprint = (value: unknown) => {
  const candidate = readString(value);
  return candidate && SHA256_FINGERPRINT_PATTERN.test(candidate) ? candidate : undefined;
};

const fingerprint = (value: unknown) =>
  createHash("sha256").update(JSON.stringify(value) ?? "null").digest("hex");

const normalizeBusinessPayload = (value: unknown): unknown => {
  if (Array.isArray(value)) {
    return value.map((entry) => normalizeBusinessPayload(entry));
  }

  const record = asRecord(value);

  if (!record) {
    return value;
  }

  return Object.fromEntries(
    Object.entries(record)
      .filter(([key]) => !VOLATILE_CALLBACK_KEYS.has(key))
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => [key, normalizeBusinessPayload(entry)])
  );
};

const buildBusinessKey = (type: string, payload: Record<string, unknown>) => {
  if (type === "door-status") {
    const eventId = readString(payload.eventId);
    const status = readString(payload.status);
    return eventId && status ? `${eventId}:${status}` : undefined;
  }

  if (type === "payment-success") {
    const orderNo = readString(payload.orderNo);
    const transactionId = readString(payload.transactionId);
    return orderNo && transactionId ? `${orderNo}:${transactionId}` : undefined;
  }

  return readString(payload.orderNo);
};

export const summarizeCallbackPayload = (payload: unknown): CallbackLogPayloadSummary => {
  const record = asRecord(payload);

  if (!record) {
    return {};
  }

  const detail = Array.isArray(record.detail) ? record.detail : undefined;
  const totalQuantity = detail?.reduce((sum, item) => {
    const quantity = asRecord(item) ? readFiniteNumber(asRecord(item)?.quantity) : undefined;
    return sum + (quantity ?? 0);
  }, 0);
  const deviceCode = readString(record.deviceCode);
  const eventId = readString(record.eventId);
  const status = readString(record.status);
  const amount = readFiniteNumber(record.amount);

  return {
    ...(deviceCode ? { deviceCode } : {}),
    ...(eventId ? { eventId } : {}),
    ...(status ? { status } : {}),
    ...(amount !== undefined ? { amount } : {}),
    ...(detail ? { itemCount: detail.length, totalQuantity } : {}),
    ...(readString(record.notifyUrl) ? { hasNotifyUrl: true } : {}),
    ...(readString(record.noticeUrl) ? { hasNoticeUrl: true } : {})
  };
};

export const createCallbackReplayFingerprint = (
  type: string,
  payload: unknown
): CallbackReplayFingerprint => {
  const record = asRecord(payload) ?? {};
  const nonce = readString(record.nonceStr);
  const clientId = readString(record.clientId) ?? "";
  const businessKey = buildBusinessKey(type, record);

  return {
    payloadFingerprint: fingerprint(normalizeBusinessPayload(record)),
    ...(nonce ? { nonceFingerprint: fingerprint([nonce, clientId]) } : {}),
    ...(businessKey ? { businessKeyFingerprint: fingerprint([type, businessKey]) } : {})
  };
};

const isCallbackLogPayloadSummary = (value: unknown): value is CallbackLogPayloadSummary => {
  const record = asRecord(value);

  if (!record) {
    return false;
  }

  return Object.entries(record).every(([key, entry]) => {
    if (["deviceCode", "eventId", "status"].includes(key)) {
      return typeof entry === "string";
    }

    if (["amount", "itemCount", "totalQuantity"].includes(key)) {
      return typeof entry === "number" && Number.isFinite(entry);
    }

    if (["hasNotifyUrl", "hasNoticeUrl"].includes(key)) {
      return entry === true;
    }

    return false;
  });
};

const readReplayFingerprint = (value: unknown): CallbackReplayFingerprint | undefined => {
  const record = asRecord(value);
  const payloadFingerprint = readFingerprint(record?.payloadFingerprint);

  if (!payloadFingerprint) {
    return undefined;
  }

  const nonceFingerprint = readFingerprint(record?.nonceFingerprint);
  const businessKeyFingerprint = readFingerprint(record?.businessKeyFingerprint);

  return {
    payloadFingerprint,
    ...(nonceFingerprint ? { nonceFingerprint } : {}),
    ...(businessKeyFingerprint ? { businessKeyFingerprint } : {})
  };
};

const isCallbackReplayFingerprint = (value: unknown) => {
  const record = asRecord(value);

  if (!record || !readFingerprint(record.payloadFingerprint)) {
    return false;
  }

  return Object.entries(record).every(([key, entry]) => {
    if (key === "payloadFingerprint") {
      return Boolean(readFingerprint(entry));
    }

    if (key === "nonceFingerprint" || key === "businessKeyFingerprint") {
      return Boolean(readFingerprint(entry));
    }

    return false;
  });
};

export const sanitizeCallbackLogRecord = (value: unknown): CallbackLogRecord | undefined => {
  const record = asRecord(value);
  const id = readString(record?.id);
  const type = readString(record?.type);
  const receivedAt = readString(record?.receivedAt);

  if (!id || !type || !receivedAt) {
    return undefined;
  }

  return {
    id,
    type,
    receivedAt,
    payload: summarizeCallbackPayload(record?.payload),
    replay: readReplayFingerprint(record?.replay) ?? createCallbackReplayFingerprint(type, record?.payload)
  };
};

export const isCallbackLogRecordSanitized = (value: unknown) => {
  const record = asRecord(value);

  return Boolean(
    readString(record?.id) &&
      readString(record?.type) &&
      readString(record?.receivedAt) &&
      isCallbackLogPayloadSummary(record?.payload) &&
      isCallbackReplayFingerprint(record?.replay)
  );
};

export const sanitizeOperationLogCallbackMetadata = (
  metadata: Record<string, unknown> | undefined
) => {
  if (!metadata || !Object.prototype.hasOwnProperty.call(metadata, "callbackPayload")) {
    return metadata;
  }

  return {
    ...metadata,
    callbackPayload: summarizeCallbackPayload(metadata.callbackPayload)
  };
};

export const isOperationLogCallbackMetadataSanitized = (
  metadata: Record<string, unknown> | undefined
) => {
  if (!metadata || !Object.prototype.hasOwnProperty.call(metadata, "callbackPayload")) {
    return true;
  }

  return isCallbackLogPayloadSummary(metadata.callbackPayload);
};
