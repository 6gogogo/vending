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
  timeoutMs?: number;
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
  private readonly timeoutMs: number;
  private readonly onExchange?: SmartVmClientOptions["onExchange"];

  constructor({
    baseUrl,
    credentials,
    fetchImpl = fetch,
    timeoutMs = 15_000,
    onExchange
  }: SmartVmClientOptions) {
    this.baseUrl = baseUrl.replace(/\/$/, "");
    this.credentials = credentials;
    this.fetchImpl = fetchImpl;
    this.timeoutMs = Number.isFinite(timeoutMs) && timeoutMs > 0 ? Math.round(timeoutMs) : 15_000;
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

  private async parseResponseBody(response: Response) {
    const raw = await response.text();

    try {
      return raw ? (JSON.parse(raw) as unknown) : "";
    } catch {
      return raw;
    }
  }

  private async fetchSigned(
    path: string,
    requestUrl: string,
    requestBody: SmartVmPayload,
    init: RequestInit
  ) {
    const controller = new AbortController();
    let timedOut = false;
    let rejectForTimeout: ((reason: Error) => void) | undefined;
    const timeoutPromise = new Promise<never>((_, reject) => {
      rejectForTimeout = reject;
    });
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
      rejectForTimeout?.(new Error("SmartVM request timed out"));
    }, this.timeoutMs);

    try {
      const requestPromise = (async () => {
        const response = await this.fetchImpl(requestUrl, { ...init, signal: controller.signal });
        const parsed = await this.parseResponseBody(response);
        return { response, parsed };
      })();

      return await Promise.race([
        requestPromise,
        timeoutPromise
      ]);
    } catch (error) {
      const message = timedOut
        ? `SmartVM 请求超过 ${this.timeoutMs} 毫秒，已中止。`
        : `SmartVM 网络请求失败：${error instanceof Error ? error.message : "未知错误"}`;
      const statusCode = timedOut ? 504 : 502;
      const responseBody = {
        message,
        reason: timedOut ? "timeout" : "network_error"
      };

      this.onExchange?.({
        method: init.method === "GET" ? "GET" : "POST",
        path,
        requestUrl,
        requestBody,
        statusCode,
        responseBody,
        ok: false
      });

      throw new SmartVmRequestError(message, statusCode, path, requestBody, responseBody);
    } finally {
      clearTimeout(timer);
    }
  }

  private async signedPostToUrl<T>(path: string, targetUrl: string, payload: SmartVmPayload): Promise<T> {
    const signedPayload = withSmartVmSignature(payload, this.credentials);
    const { response, parsed } = await this.fetchSigned(path, targetUrl, signedPayload, {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify(signedPayload)
    });

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
