import { createHash, randomUUID } from "node:crypto";

import type { SmartVmCredentials } from "@vm/shared-types";

export type SmartVmPayload = Record<string, unknown>;

const normalizeValue = (value: unknown) => {
  if (value === undefined || value === null || value === "") {
    return undefined;
  }

  if (typeof value === "object") {
    return JSON.stringify(value);
  }

  return String(value);
};

export const createNonce = () => randomUUID().replace(/-/g, "").slice(0, 16);

export const signSmartVmPayload = (payload: SmartVmPayload, credentials: SmartVmCredentials) => {
  const sortedEntries = Object.entries(payload)
    .map(([key, value]) => [key, normalizeValue(value)] as const)
    .filter((entry): entry is readonly [string, string] => entry[1] !== undefined)
    .sort((left, right) => left[0].localeCompare(right[0]));

  const stringToSign = sortedEntries.map(([key, value]) => `${key}=${value}`).join("&");
  const digest = createHash("md5")
    .update(`${stringToSign}&key=${credentials.key}`)
    .digest("hex")
    .toUpperCase();

  return digest;
};

export const withSmartVmSignature = <T extends SmartVmPayload>(payload: T, credentials: SmartVmCredentials) => {
  const nonceStr = createNonce();
  const unsignedPayload = {
    ...payload,
    clientId: credentials.clientId,
    nonceStr
  };

  return {
    ...unsignedPayload,
    sign: signSmartVmPayload(unsignedPayload, credentials)
  };
};

export const verifySmartVmSignature = (
  payload: SmartVmPayload & { sign?: string; clientId?: string; nonceStr?: string },
  credentials: SmartVmCredentials
) => {
  const { sign, ...unsignedPayload } = payload;
  return sign === signSmartVmPayload(unsignedPayload, credentials);
};
