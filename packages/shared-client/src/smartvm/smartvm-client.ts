import type {
  CabinetOpenResult,
  DeviceGoods,
  SmartVmCredentials,
  SmartVmPaymentPayload,
  SmartVmRefundPayload,
  SmartVmRouterStatusResult
} from "@vm/shared-types";

import { withSmartVmSignature, type SmartVmPayload } from "./signature";

interface SmartVmClientOptions {
  baseUrl: string;
  credentials: SmartVmCredentials;
  fetchImpl?: typeof fetch;
  onExchange?: (payload: {
    method: "GET" | "POST";
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

  private appendQuery(targetUrl: string, payload: SmartVmPayload) {
    const url = new URL(targetUrl);

    for (const [key, value] of Object.entries(payload)) {
      if (value === undefined || value === null || value === "") {
        continue;
      }

      url.searchParams.set(key, typeof value === "object" ? JSON.stringify(value) : String(value));
    }

    return url.toString();
  }

  private async parseResponseBody(response: Response) {
    const raw = await response.text();

    try {
      return raw ? (JSON.parse(raw) as unknown) : "";
    } catch {
      return raw;
    }
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
    const parsed = await this.parseResponseBody(response);

    if (!response.ok) {
      const detail = this.extractDetail(parsed, `SmartVM request failed with status ${response.status}`);

      this.onExchange?.({
        method: "POST",
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
        method: "POST",
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
      method: "POST",
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

  private async signedGet<T>(path: string, payload: SmartVmPayload): Promise<T> {
    const signedPayload = withSmartVmSignature(payload, this.credentials);
    const requestUrl = this.appendQuery(`${this.baseUrl}${path}`, signedPayload);
    const response = await this.fetchImpl(requestUrl, {
      method: "GET",
      headers: {
        "Content-Type": "application/json"
      }
    });
    const parsed = await this.parseResponseBody(response);

    if (!response.ok) {
      const detail = this.extractDetail(parsed, `SmartVM request failed with status ${response.status}`);

      this.onExchange?.({
        method: "GET",
        path,
        requestUrl,
        requestBody: signedPayload,
        statusCode: response.status,
        responseBody: parsed,
        ok: false
      });

      throw new SmartVmRequestError(detail, response.status, path, signedPayload, parsed);
    }

    const json = parsed as { code?: number | string; message?: string; data?: T } | undefined;

    if (json && typeof json === "object" && "code" in json) {
      if (json.code !== 200 && json.code !== "200") {
        const detail = this.extractDetail(json, "SmartVM business request failed");
        this.onExchange?.({
          method: "GET",
          path,
          requestUrl,
          requestBody: signedPayload,
          statusCode: response.status,
          responseBody: json,
          ok: false
        });
        throw new SmartVmRequestError(detail, response.status, path, signedPayload, json);
      }

      this.onExchange?.({
        method: "GET",
        path,
        requestUrl,
        requestBody: signedPayload,
        statusCode: response.status,
        responseBody: json,
        ok: true
      });

      return json.data as T;
    }

    this.onExchange?.({
      method: "GET",
      path,
      requestUrl,
      requestBody: signedPayload,
      statusCode: response.status,
      responseBody: parsed,
      ok: true
    });

    return parsed as T;
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

  getRouterStatus(payload: { deviceCode: string }) {
    return this.signedGet<SmartVmRouterStatusResult>("/osapi/router/status", {
      assetId: payload.deviceCode
    });
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
