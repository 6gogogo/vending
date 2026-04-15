import type {
  CabinetOpenResult,
  DeviceGoods,
  SmartVmCredentials,
  SmartVmPaymentPayload,
  SmartVmRefundPayload
} from "@vm/shared-types";

import { withSmartVmSignature, type SmartVmPayload } from "./signature";

interface SmartVmClientOptions {
  baseUrl: string;
  credentials: SmartVmCredentials;
  fetchImpl?: typeof fetch;
  onExchange?: (payload: {
    path: string;
    requestUrl: string;
    requestBody: SmartVmPayload;
    statusCode: number;
    responseBody: unknown;
    ok: boolean;
  }) => void;
}

export class SmartVmRequestError extends Error {
  constructor(
    message: string,
    public readonly statusCode: number,
    public readonly path: string,
    public readonly requestBody: SmartVmPayload,
    public readonly responseBody: unknown
  ) {
    super(message);
  }
}

export class SmartVmClient {
  private readonly baseUrl: string;
  private readonly credentials: SmartVmCredentials;
  private readonly fetchImpl: typeof fetch;
  private readonly onExchange?: SmartVmClientOptions["onExchange"];

  constructor({ baseUrl, credentials, fetchImpl = fetch, onExchange }: SmartVmClientOptions) {
    this.baseUrl = baseUrl.replace(/\/$/, "");
    this.credentials = credentials;
    this.fetchImpl = fetchImpl;
    this.onExchange = onExchange;
  }

  private extractDetail(payload: unknown, fallback: string) {
    if (typeof payload === "string" && payload.trim()) {
      return payload.trim();
    }

    if (payload && typeof payload === "object") {
      const typed = payload as {
        message?: unknown;
        error?: unknown;
        error_code?: unknown;
      };

      if (typeof typed.message === "string" && typed.message.trim()) {
        return typed.message.trim();
      }

      const parts: string[] = [];

      if (typed.error_code !== undefined && typed.error_code !== null && `${typed.error_code}`.trim()) {
        parts.push(`error_code=${typed.error_code}`);
      }

      if (typeof typed.error === "string" && typed.error.trim()) {
        parts.push(`error=${typed.error.trim()}`);
      }

      if (parts.length) {
        return parts.join(", ");
      }
    }

    return fallback;
  }

  private async signedPostToUrl<T>(path: string, targetUrl: string, payload: SmartVmPayload): Promise<T> {
    const signedPayload = withSmartVmSignature(payload, this.credentials);
    const response = await this.fetchImpl(targetUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify(signedPayload)
    });
    const raw = await response.text();
    let parsed: unknown = raw;

    if (raw) {
      try {
        parsed = JSON.parse(raw) as unknown;
      } catch {
        parsed = raw;
      }
    }

    if (!response.ok) {
      const detail = this.extractDetail(parsed, `SmartVM request failed with status ${response.status}`);

      this.onExchange?.({
        path,
        requestUrl: targetUrl,
        requestBody: signedPayload,
        statusCode: response.status,
        responseBody: parsed,
        ok: false
      });

      throw new SmartVmRequestError(detail, response.status, path, signedPayload, parsed);
    }

    const json = parsed as { code?: number; message?: string; data?: T };

    if (json.code !== 200) {
      const detail = this.extractDetail(json, "SmartVM business request failed");
      this.onExchange?.({
        path,
        requestUrl: targetUrl,
        requestBody: signedPayload,
        statusCode: response.status,
        responseBody: json,
        ok: false
      });
      throw new SmartVmRequestError(
        detail,
        response.status,
        path,
        signedPayload,
        json
      );
    }

    this.onExchange?.({
      path,
      requestUrl: targetUrl,
      requestBody: signedPayload,
      statusCode: response.status,
      responseBody: json,
      ok: true
    });

    return json.data as T;
  }

  private async signedPost<T>(path: string, payload: SmartVmPayload): Promise<T> {
    return this.signedPostToUrl(path, `${this.baseUrl}${path}`, payload);
  }

  postToPath<T>(path: string, payload: SmartVmPayload) {
    return this.signedPost<T>(path, payload);
  }

  postToUrl<T>(url: string, payload: SmartVmPayload, tracePath = url) {
    return this.signedPostToUrl<T>(tracePath, url, payload);
  }

  getCabinetGoodsInfo(payload: { deviceCode: string; doorNum?: string }) {
    return this.signedPost<DeviceGoods[]>("/api/pay/container/getCabinetGoodsInfo", payload);
  }

  async openDoor(payload: {
    userId: string;
    eventId: string;
    deviceCode: string;
    payStyle: string;
    doorNum?: string;
    phone: string;
  }): Promise<Pick<CabinetOpenResult, "orderNo">> {
    return this.signedPost<Pick<CabinetOpenResult, "orderNo">>("/api/pay/container/opendoor", payload);
  }

  notifyPaymentSuccess(payload: SmartVmPaymentPayload) {
    return this.signedPost<undefined>("/api/pay/container/paymentSuccess", { ...payload });
  }

  refund(payload: SmartVmRefundPayload) {
    return this.signedPost<undefined>("/api/pay/container/refund", { ...payload });
  }
}
