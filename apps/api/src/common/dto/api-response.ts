import type { ApiEnvelope } from "@vm/shared-types";

export const ok = <T>(data: T, message = "成功"): ApiEnvelope<T> => ({
  code: 200,
  message,
  data
});

export const fail = <T>(code: number, message: string, data: T): ApiEnvelope<T> => ({
  code,
  message,
  data
});
