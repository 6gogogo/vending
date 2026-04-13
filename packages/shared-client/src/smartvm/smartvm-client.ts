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
}

export class SmartVmClient {
  private readonly baseUrl: string;
  private readonly credentials: SmartVmCredentials;
  private readonly fetchImpl: typeof fetch;

  constructor({ baseUrl, credentials, fetchImpl = fetch }: SmartVmClientOptions) {
    this.baseUrl = baseUrl.replace(/\/$/, "");
    this.credentials = credentials;
    this.fetchImpl = fetchImpl;
  }

  private async signedPost<T>(path: string, payload: SmartVmPayload): Promise<T> {
    const response = await this.fetchImpl(`${this.baseUrl}${path}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify(withSmartVmSignature(payload, this.credentials))
    });

    if (!response.ok) {
      let detail = `SmartVM request failed with status ${response.status}`;

      try {
        const raw = await response.text();
        if (raw) {
          try {
            const parsed = JSON.parse(raw) as { message?: string; error?: string };
            detail = parsed.message ?? parsed.error ?? raw;
          } catch {
            detail = raw;
          }
        }
      } catch {
        // 忽略响应体解析失败，保留状态码信息。
      }

      throw new Error(detail);
    }

    const json = (await response.json()) as { code: number; message: string; data?: T };

    if (json.code !== 200) {
      throw new Error(json.message);
    }

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
    payStyle: "2" | "3";
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
