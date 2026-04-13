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

  private async signedPost<T>(path: string, payload: SmartVmPayload): Promise<T> {
    const signedPayload = withSmartVmSignature(payload, this.credentials);
    const response = await this.fetchImpl(`${this.baseUrl}${path}`, {
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
      const detail =
        typeof parsed === "object" &&
        parsed !== null &&
        "message" in parsed &&
        typeof (parsed as { message?: unknown }).message === "string"
          ? (parsed as { message: string }).message
          : typeof parsed === "string" && parsed
            ? parsed
            : `SmartVM request failed with status ${response.status}`;

      this.onExchange?.({
        path,
        requestBody: signedPayload,
        statusCode: response.status,
        responseBody: parsed,
        ok: false
      });

      throw new SmartVmRequestError(detail, response.status, path, signedPayload, parsed);
    }

    const json = parsed as { code: number; message: string; data?: T };

    if (json.code !== 200) {
      this.onExchange?.({
        path,
        requestBody: signedPayload,
        statusCode: response.status,
        responseBody: json,
        ok: false
      });
      throw new SmartVmRequestError(
        json.message,
        response.status,
        path,
        signedPayload,
        json
      );
    }

    this.onExchange?.({
      path,
      requestBody: signedPayload,
      statusCode: response.status,
      responseBody: json,
      ok: true
    });

    return json.data as T;
  }

  postToPath<T>(path: string, payload: SmartVmPayload) {
    return this.signedPost<T>(path, payload);
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
