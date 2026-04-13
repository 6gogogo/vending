import { Inject, Injectable } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { SmartVmClient, SmartVmRequestError, verifySmartVmSignature } from "@vm/shared-client/smartvm";
import type {
  SmartVmCredentials,
  SmartVmDoorStatusPayload,
  SmartVmPaymentPayload,
  SmartVmRefundPayload,
  SmartVmSettlementPayload
} from "@vm/shared-types";

import { appendSystemAuditLog } from "../../common/store/persistence";

@Injectable()
export class SmartVmGateway {
  constructor(@Inject(ConfigService) private readonly configService: ConfigService) {}

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

  private get client() {
    const baseUrl = this.configService.get<string>("SMARTVM_BASE_URL");
    const credentials = this.credentials;

    if (!baseUrl || !credentials) {
      return undefined;
    }

    return new SmartVmClient({
      baseUrl,
      credentials,
      onExchange: ({ path, requestBody, responseBody, statusCode, ok }) => {
        appendSystemAuditLog({
          occurredAt: new Date().toISOString(),
          method: "POST",
          path: `/external/smartvm${path}`,
          body: requestBody,
          statusCode,
          durationMs: 0,
          response: responseBody,
          error: ok
            ? undefined
            : {
                name: "SmartVmRequestError",
                message:
                  typeof responseBody === "object" &&
                  responseBody !== null &&
                  "message" in responseBody &&
                  typeof (responseBody as { message?: unknown }).message === "string"
                    ? (responseBody as { message: string }).message
                    : undefined
              },
          metadata: {
            upstreamBaseUrl: baseUrl
          }
        });
      }
    });
  }

  async getGoodsInfo(payload: { deviceCode: string; doorNum?: string }) {
    return this.client?.getCabinetGoodsInfo(payload);
  }

  async openDoor(payload: {
    userId: string;
    eventId: string;
    deviceCode: string;
    payStyle?: string;
    doorNum?: string;
    phone: string;
  }) {
    const client = this.client;
    const payStyle = this.getDefaultOpenDoorPayStyle(payload.payStyle);

    if (!client) {
      return {
        orderNo: `mock-order-${payload.eventId}`
      };
    }

    return client.openDoor({
      ...payload,
      payStyle
    });
  }

  async notifyPaymentSuccess(payload: SmartVmPaymentPayload) {
    const client = this.client;

    if (!client) {
      return {
        simulated: true
      };
    }

    const overridePath = this.configService.get<string>("SMARTVM_PAYMENT_SUCCESS_PATH");

    if (overridePath) {
      return client.postToPath<undefined>(overridePath, { ...payload });
    }

    return client.notifyPaymentSuccess(payload);
  }

  async refund(payload: SmartVmRefundPayload) {
    const client = this.client;

    if (!client) {
      return {
        simulated: true
      };
    }

    return client.refund(payload);
  }

  verifySignedPayload(
    payload:
      | (SmartVmDoorStatusPayload & Record<string, unknown>)
      | (SmartVmSettlementPayload & Record<string, unknown>)
      | Record<string, unknown>
  ) {
    if (!this.credentials) {
      return true;
    }

    return verifySmartVmSignature(payload, this.credentials);
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

  private getDefaultOpenDoorPayStyle(preferred?: string) {
    const normalizedPreferred = preferred?.trim();

    if (normalizedPreferred) {
      return normalizedPreferred;
    }

    const configured = this.configService.get<string>("SMARTVM_DEFAULT_PAY_STYLE")?.trim();
    return configured || "2";
  }
}
