import { Inject, Injectable } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import {
  SmartVmClient,
  SmartVmRequestError,
  verifySmartVmSignature,
  type SmartVmPayload
} from "@vm/shared-client/smartvm";
import type {
  SmartVmCredentials,
  SmartVmDoorStatusPayload,
  SmartVmPaymentPayload,
  SmartVmRefundPayload,
  SmartVmSettlementPayload
} from "@vm/shared-types";

import { appendSystemAuditLog } from "../../common/store/persistence";

export interface SmartVmExchangeTrace {
  direction: "outbound";
  occurredAt: string;
  method: "GET" | "POST";
  path: string;
  requestUrl: string;
  requestBody: SmartVmPayload;
  statusCode: number;
  responseBody: unknown;
  ok: boolean;
  errorMessage?: string;
  simulated?: boolean;
}

@Injectable()
export class SmartVmGateway {
  constructor(@Inject(ConfigService) private readonly configService: ConfigService) {}

  private formatResponseError(responseBody: unknown) {
    if (typeof responseBody === "string" && responseBody.trim()) {
      return responseBody.trim();
    }

    if (responseBody && typeof responseBody === "object") {
      const typed = responseBody as {
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

    return undefined;
  }

  private get credentials(): SmartVmCredentials | undefined {
    const clientId = this.configService.get<string>("SMARTVM_CLIENT_ID");
    const key = this.configService.get<string>("SMARTVM_KEY");

    if (!clientId || !key) {
      return undefined;
    }

    return {
      clientId,
      key
    };
  }

  private buildExchangeTrace(payload: {
    method: "GET" | "POST";
    path: string;
    requestUrl: string;
    requestBody: SmartVmPayload;
    responseBody: unknown;
    statusCode: number;
    ok: boolean;
  }): SmartVmExchangeTrace {
    return {
      direction: "outbound",
      occurredAt: new Date().toISOString(),
      method: payload.method,
      path: `/external/smartvm${payload.path}`,
      requestUrl: payload.requestUrl,
      requestBody: payload.requestBody,
      statusCode: payload.statusCode,
      responseBody: payload.responseBody,
      ok: payload.ok,
      errorMessage: payload.ok ? undefined : this.formatResponseError(payload.responseBody)
    };
  }

  private buildSimulatedExchangeTrace(payload: {
    method: "GET" | "POST";
    path: string;
    requestBody: SmartVmPayload;
    responseBody: unknown;
  }): SmartVmExchangeTrace {
    return {
      direction: "outbound",
      occurredAt: new Date().toISOString(),
      method: payload.method,
      path: `/external/smartvm${payload.path}`,
      requestUrl: `mock://smartvm${payload.path}`,
      requestBody: payload.requestBody,
      statusCode: 200,
      responseBody: payload.responseBody,
      ok: true,
      simulated: true
    };
  }

  private attachExchangeTrace(error: unknown, exchange?: SmartVmExchangeTrace) {
    if (exchange && error && typeof error === "object") {
      Object.assign(error, { smartVmExchange: exchange });
    }
  }

  private createClient(onExchange?: (exchange: SmartVmExchangeTrace) => void) {
    const baseUrl = this.configService.get<string>("SMARTVM_BASE_URL");
    const credentials = this.credentials;

    if (!baseUrl || !credentials) {
      return undefined;
    }

    return new SmartVmClient({
      baseUrl,
      credentials,
      onExchange: ({ method, path, requestUrl, requestBody, responseBody, statusCode, ok }) => {
        const exchange = this.buildExchangeTrace({
          method,
          path,
          requestUrl,
          requestBody,
          responseBody,
          statusCode,
          ok
        });

        appendSystemAuditLog({
          occurredAt: exchange.occurredAt,
          method,
          path: exchange.path,
          body: requestBody,
          statusCode,
          durationMs: 0,
          response: responseBody,
          error: ok
            ? undefined
            : {
                name: "SmartVmRequestError",
                message: this.formatResponseError(responseBody)
              },
          metadata: {
            upstreamBaseUrl: baseUrl,
            requestUrl
          }
        });
        onExchange?.(exchange);
      }
    });
  }

  async getGoodsInfo(payload: { deviceCode: string; doorNum?: string }) {
    return this.createClient()?.getCabinetGoodsInfo(payload);
  }

  async getRouterStatus(payload: { deviceCode: string }) {
    return this.createClient()?.getRouterStatus(payload);
  }

  async openDoor(payload: {
    userId: string;
    eventId: string;
    deviceCode: string;
    payStyle?: string;
    doorNum?: string;
    phone: string;
  }) {
    const payStyle = this.getDefaultOpenDoorPayStyle(payload.payStyle);
    const requestBody = {
      ...payload,
      payStyle
    };
    const exchanges: SmartVmExchangeTrace[] = [];
    const client = this.createClient((exchange) => exchanges.push(exchange));

    if (!client) {
      const compactEventId = payload.eventId.replace(/[^a-zA-Z0-9]/g, "").slice(-12) || Date.now().toString(36);
      const responseBody = {
        orderNo: `mock-${compactEventId}`
      };
      return {
        ...responseBody,
        smartVmExchange: this.buildSimulatedExchangeTrace({
          method: "POST",
          path: "/api/pay/container/opendoor",
          requestBody,
          responseBody
        })
      };
    }

    let result: Awaited<ReturnType<SmartVmClient["openDoor"]>>;

    try {
      result = await client.openDoor(requestBody);
    } catch (error) {
      this.attachExchangeTrace(error, exchanges.at(-1));
      throw error;
    }

    return {
      ...result,
      smartVmExchange: exchanges.at(-1)
    };
  }

  isUsingMockTransport() {
    const baseUrl = this.configService.get<string>("SMARTVM_BASE_URL");
    return !baseUrl || !this.credentials;
  }

  async notifyPaymentSuccess(
    payload: SmartVmPaymentPayload,
    options?: {
      targetUrl?: string;
    }
  ) {
    const exchanges: SmartVmExchangeTrace[] = [];
    const client = this.createClient((exchange) => exchanges.push(exchange));

    if (!client) {
      const responseBody = {
        simulated: true
      };
      return {
        ...responseBody,
        smartVmExchange: this.buildSimulatedExchangeTrace({
          method: "POST",
          path: "/api/pay/container/paymentSuccess",
          requestBody: { ...payload },
          responseBody
        })
      };
    }

    const preferredTarget = options?.targetUrl?.trim();
    const overridePath = this.configService.get<string>("SMARTVM_PAYMENT_SUCCESS_PATH");

    if (preferredTarget?.startsWith("http://") || preferredTarget?.startsWith("https://")) {
      let result: undefined;
      try {
        result = await client.postToUrl<undefined>(preferredTarget, { ...payload }, "/api/pay/container/paymentSuccess");
      } catch (error) {
        this.attachExchangeTrace(error, exchanges.at(-1));
        throw error;
      }
      return {
        result,
        smartVmExchange: exchanges.at(-1)
      };
    }

    if (preferredTarget?.startsWith("/")) {
      let result: undefined;
      try {
        result = await client.postToPath<undefined>(preferredTarget, { ...payload });
      } catch (error) {
        this.attachExchangeTrace(error, exchanges.at(-1));
        throw error;
      }
      return {
        result,
        smartVmExchange: exchanges.at(-1)
      };
    }

    if (overridePath) {
      let result: undefined;
      try {
        result = await client.postToPath<undefined>(overridePath, { ...payload });
      } catch (error) {
        this.attachExchangeTrace(error, exchanges.at(-1));
        throw error;
      }
      return {
        result,
        smartVmExchange: exchanges.at(-1)
      };
    }

    let result: undefined;
    try {
      result = await client.notifyPaymentSuccess(payload);
    } catch (error) {
      this.attachExchangeTrace(error, exchanges.at(-1));
      throw error;
    }
    return {
      result,
      smartVmExchange: exchanges.at(-1)
    };
  }

  async refund(payload: SmartVmRefundPayload) {
    const exchanges: SmartVmExchangeTrace[] = [];
    const client = this.createClient((exchange) => exchanges.push(exchange));

    if (!client) {
      const responseBody = {
        simulated: true
      };
      return {
        ...responseBody,
        smartVmExchange: this.buildSimulatedExchangeTrace({
          method: "POST",
          path: "/api/pay/container/refund",
          requestBody: { ...payload },
          responseBody
        })
      };
    }

    let result: undefined;
    try {
      result = await client.refund(payload);
    } catch (error) {
      this.attachExchangeTrace(error, exchanges.at(-1));
      throw error;
    }
    return {
      result,
      smartVmExchange: exchanges.at(-1)
    };
  }

  verifySignedPayload(
    payload:
      | (SmartVmDoorStatusPayload & Record<string, unknown>)
      | (SmartVmSettlementPayload & Record<string, unknown>)
      | Record<string, unknown>
  ) {
    const credentials = this.credentials;

    if (!credentials) {
      return this.allowUnsignedCallbacks();
    }

    return verifySmartVmSignature(payload, credentials);
  }

  extractErrorMessage(error: unknown) {
    if (error instanceof SmartVmRequestError) {
      return error.message;
    }

    if (error instanceof Error) {
      return error.message;
    }

    return "柜机平台未返回可用结果。";
  }

  extractExchangeTrace(error: unknown): SmartVmExchangeTrace | undefined {
    const embeddedExchange = error && typeof error === "object"
      ? (error as { smartVmExchange?: SmartVmExchangeTrace }).smartVmExchange
      : undefined;

    if (embeddedExchange) {
      return embeddedExchange;
    }

    if (!(error instanceof SmartVmRequestError)) {
      return undefined;
    }

    return {
      direction: "outbound",
      occurredAt: new Date().toISOString(),
      method: "POST",
      path: `/external/smartvm${error.path}`,
      requestUrl: "",
      requestBody: error.requestBody,
      statusCode: error.statusCode,
      responseBody: error.responseBody,
      ok: false,
      errorMessage: error.message
    };
  }

  private getDefaultOpenDoorPayStyle(preferred?: string) {
    const normalizedPreferred = preferred?.trim();

    if (normalizedPreferred) {
      return normalizedPreferred;
    }

    const configured = this.configService.get<string>("SMARTVM_DEFAULT_PAY_STYLE")?.trim();
    return configured || "2";
  }

  private allowUnsignedCallbacks() {
    const raw =
      this.configService.get<string>("SMARTVM_ALLOW_UNSIGNED_CALLBACKS") ??
      this.configService.get<string>("ALLOW_UNSIGNED_SMARTVM_CALLBACKS");

    return ["1", "true", "yes", "on"].includes(raw?.trim().toLowerCase() ?? "");
  }
}
