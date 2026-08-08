import {
  BadRequestException,
  Inject,
  Injectable,
  Optional,
  ServiceUnavailableException
} from "@nestjs/common";
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

import { sanitizeAuditLogEntry } from "../../common/logging/audit-log-sanitizer";
import { resolveFullSimulationExternalMode } from "../../common/config/full-simulation-mode";
import { assertConfiguredRuntimeDataPlaneSmartVmPolicy } from "../../common/config/runtime-data-plane-policy";
import { isProductionRuntime } from "../../common/config/runtime-environment";
import { SystemAuditLogService } from "../../common/store/system-audit-log.service";

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

// 仅收录已由 SmartVM 开门接口契约验证的“请求未受理”业务码；新增码前必须补充契约与回归测试。
const DEFINITE_OPEN_DOOR_REJECTION_CODES = new Set<number>([
  // SmartVM 已实机确认：300 表示平台风控明确拒绝，柜门不会执行动作。
  300,
  400
]);

@Injectable()
export class SmartVmGateway {
  constructor(
    @Inject(ConfigService) private readonly configService: ConfigService,
    @Optional()
    @Inject(SystemAuditLogService)
    private readonly auditLog: SystemAuditLogService = new SystemAuditLogService()
  ) {}

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
    return sanitizeAuditLogEntry({
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
    });
  }

  private buildSimulatedExchangeTrace(payload: {
    method: "GET" | "POST";
    path: string;
    requestBody: SmartVmPayload;
    responseBody: unknown;
  }): SmartVmExchangeTrace {
    return sanitizeAuditLogEntry({
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
    });
  }

  private attachExchangeTrace(error: unknown, exchange?: SmartVmExchangeTrace) {
    if (exchange && error && typeof error === "object") {
      Object.assign(error, { smartVmExchange: exchange });
    }
  }

  private createClient(onExchange?: (exchange: SmartVmExchangeTrace) => void) {
    this.assertRuntimeDataPlaneSmartVmPolicy();

    if (this.getFullSimulationTransportMode() === "mock") {
      return undefined;
    }

    const baseUrl = this.configService.get<string>("SMARTVM_BASE_URL");
    const credentials = this.credentials;

    if (!baseUrl || !credentials) {
      return undefined;
    }

    return new SmartVmClient({
      baseUrl,
      credentials,
      timeoutMs: this.getRequestTimeoutMs(),
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

        this.auditLog.appendSafely({
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

  private getRequestTimeoutMs() {
    const configured = Number(this.configService.get<string>("SMARTVM_TIMEOUT_MS") ?? 15_000);
    return Number.isSafeInteger(configured) && configured > 0 ? configured : 15_000;
  }

  /**
   * 柜机命令一旦发出就无法由本服务回滚；生产环境必须先落盘最小化审计意图。
   * 只记录固定动作类型，不记录载荷、目标地址、签名或支付标识。
   */
  private async runCriticalSmartVmOperation<T>(
    action: "open-door" | "notify-payment-success" | "refund",
    operation: () => Promise<T>
  ): Promise<T> {
    const criticalAudit = (isProductionRuntime() || this.isLiveDataPlane())
      ? this.auditLog.beginCriticalIntent({
          method: "POST",
          path: "/internal/smartvm/outbound-command",
          metadata: {
            action,
            provider: "smartvm"
          }
        })
      : undefined;

    try {
      const result = await operation();

      if (criticalAudit) {
        this.auditLog.completeCriticalOperation(criticalAudit, {
          method: "POST",
          path: "/internal/smartvm/outbound-command",
          statusCode: 200,
          durationMs: Date.now() - criticalAudit.startedAt,
          outcome: "completed",
          metadata: {
            action,
            provider: "smartvm"
          }
        });
      }

      return result;
    } catch (error) {
      if (criticalAudit) {
        const upstreamStatus = error instanceof SmartVmRequestError ? error.statusCode : undefined;
        const statusCode =
          typeof upstreamStatus === "number" && upstreamStatus >= 100 && upstreamStatus <= 599
            ? upstreamStatus
            : 502;
        this.auditLog.completeCriticalOperation(criticalAudit, {
          method: "POST",
          path: "/internal/smartvm/outbound-command",
          statusCode,
          durationMs: Date.now() - criticalAudit.startedAt,
          outcome: this.isDefiniteSmartVmRejection(error) ? "rejected" : "indeterminate",
          metadata: {
            action,
            provider: "smartvm"
          }
        });
      }
      throw error;
    }
  }

  async getGoodsInfo(payload: { deviceCode: string; doorNum?: string }) {
    return this.createClient()?.getCabinetGoodsInfo(payload);
  }

  async probeDevice(payload: { deviceCode: string; doorNum?: string }) {
    const client = this.createClient();

    if (!client) {
      return undefined;
    }

    // 当前实机交付使用 1.1 契约；商品查询是供应商明确提供的只读 POST，
    // 可确认租户凭据与设备编号有效。物理在线和门状态仍只接受设备回调。
    await client.getCabinetGoodsInfo(payload);
    return { recognized: true as const };
  }

  async openDoor(payload: {
    userId: string;
    eventId: string;
    deviceCode: string;
    doorNum?: string;
    phone: string;
  }) {
    const payStyle = this.getDefaultOpenDoorPayStyle();
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
      result = await this.runCriticalSmartVmOperation(
        "open-door",
        () => client.openDoor(requestBody)
      );
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
    this.assertRuntimeDataPlaneSmartVmPolicy();

    if (this.getFullSimulationTransportMode() === "mock") {
      return true;
    }

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
      this.assertAllowedNotifyTarget(preferredTarget);
      let result: undefined;
      try {
        result = await this.runCriticalSmartVmOperation(
          "notify-payment-success",
          () =>
            client.postToUrl<undefined>(
              preferredTarget,
              { ...payload },
              "/api/pay/container/paymentSuccess"
            )
        );
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
        result = await this.runCriticalSmartVmOperation(
          "notify-payment-success",
          () => client.postToPath<undefined>(preferredTarget, { ...payload })
        );
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
        result = await this.runCriticalSmartVmOperation(
          "notify-payment-success",
          () => client.postToPath<undefined>(overridePath, { ...payload })
        );
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
      result = await this.runCriticalSmartVmOperation(
        "notify-payment-success",
        () => client.notifyPaymentSuccess(payload)
      );
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
      result = await this.runCriticalSmartVmOperation(
        "refund",
        () => client.refund(payload)
      );
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
    this.assertRuntimeDataPlaneSmartVmPolicy();
    const credentials = this.credentials;

    if (!credentials) {
      return this.allowUnsignedCallbacks();
    }

    return verifySmartVmSignature(payload, credentials);
  }

  extractErrorMessage(error: unknown) {
    if (error instanceof SmartVmRequestError) {
      if (this.looksLikeHtml(error.message) || this.looksLikeHtml(error.responseBody)) {
        return `柜机平台请求失败（HTTP ${error.statusCode}）。`;
      }

      return error.message;
    }

    if (error instanceof Error) {
      if (this.looksLikeHtml(error.message)) {
        return "柜机平台返回了无法识别的响应。";
      }

      return error.message;
    }

    return "柜机平台未返回可用结果。";
  }

  private looksLikeHtml(value: unknown) {
    return typeof value === "string" && /<(?:!doctype|html|head|body|title|h1)\b/i.test(value);
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

    return sanitizeAuditLogEntry({
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
    });
  }

  isDefiniteOpenDoorRejection(error: unknown) {
    return this.isDefiniteSmartVmRejection(error);
  }

  private isDefiniteSmartVmRejection(error: unknown) {
    if (!(error instanceof SmartVmRequestError)) {
      return false;
    }

    const responseBody = error.responseBody;

    // 2xx 也可能携带空体、非 JSON 或代理替换响应；没有经过验证的业务码时一律视为结果未知。
    if (!responseBody || typeof responseBody !== "object" || Array.isArray(responseBody)) {
      return false;
    }

    const responseCode = (responseBody as { code?: unknown }).code;

    if (typeof responseCode !== "number" || !Number.isSafeInteger(responseCode)) {
      return false;
    }

    // 仅在 HTTP 层也明确返回业务响应时才释放租约。408 仍可能是代理超时，不能判断远端是否已执行。
    return (
      ((error.statusCode >= 200 && error.statusCode < 300) ||
        (error.statusCode >= 400 && error.statusCode < 500 && error.statusCode !== 408)) &&
      DEFINITE_OPEN_DOOR_REJECTION_CODES.has(responseCode)
    );
  }

  private getDefaultOpenDoorPayStyle() {
    const configured = this.configService.get<string>("SMARTVM_DEFAULT_PAY_STYLE")?.trim();
    return configured || "2";
  }

  private assertAllowedNotifyTarget(target: string) {
    let targetUrl: URL;

    try {
      targetUrl = new URL(target);
    } catch {
      throw new BadRequestException("柜机付款回写地址格式无效。");
    }

    const configuredOrigins = (
      this.configService.get<string>("SMARTVM_ALLOWED_NOTIFY_ORIGINS") ?? ""
    )
      .split(",")
      .map((entry) => entry.trim())
      .filter(Boolean);
    const baseUrl = this.configService.get<string>("SMARTVM_BASE_URL")?.trim();

    if (baseUrl) {
      try {
        configuredOrigins.push(new URL(baseUrl).origin);
      } catch {
        throw new BadRequestException("SMARTVM_BASE_URL 格式无效。");
      }
    }

    const allowedOrigins = new Set(
      configuredOrigins.map((entry) => {
        try {
          return new URL(entry).origin;
        } catch {
          throw new BadRequestException("SMARTVM_ALLOWED_NOTIFY_ORIGINS 包含无效地址。");
        }
      })
    );

    if (!allowedOrigins.has(targetUrl.origin)) {
      throw new BadRequestException("柜机付款回写地址不在允许的来源列表中。");
    }
  }

  private allowUnsignedCallbacks() {
    if (isProductionRuntime() || this.isLiveDataPlane()) {
      return false;
    }

    const raw =
      this.configService.get<string>("SMARTVM_ALLOW_UNSIGNED_CALLBACKS") ??
      this.configService.get<string>("ALLOW_UNSIGNED_SMARTVM_CALLBACKS");

    return ["1", "true", "yes", "on"].includes(raw?.trim().toLowerCase() ?? "");
  }

  private assertRuntimeDataPlaneSmartVmPolicy() {
    try {
      assertConfiguredRuntimeDataPlaneSmartVmPolicy({
        VM_DATA_PLANE: this.configService.get<string>("VM_DATA_PLANE"),
        VM_DATA_ROOT: this.configService.get<string>("VM_DATA_ROOT"),
        VM_DATA_PLANE_ID: this.configService.get<string>("VM_DATA_PLANE_ID"),
        VM_SIMULATION_PROFILE: this.configService.get<string>("VM_SIMULATION_PROFILE"),
        VM_FULL_SIMULATION_ENABLED: this.configService.get<string>("VM_FULL_SIMULATION_ENABLED"),
        VM_FULL_SIMULATION_SMARTVM_MODE: this.configService.get<string>(
          "VM_FULL_SIMULATION_SMARTVM_MODE"
        ),
        SMARTVM_MODE: this.configService.get<string>("SMARTVM_MODE"),
        SMARTVM_BASE_URL: this.configService.get<string>("SMARTVM_BASE_URL"),
        SMARTVM_CLIENT_ID: this.configService.get<string>("SMARTVM_CLIENT_ID"),
        SMARTVM_KEY: this.configService.get<string>("SMARTVM_KEY"),
        SMARTVM_ALLOW_UNSIGNED_CALLBACKS: this.configService.get<string>(
          "SMARTVM_ALLOW_UNSIGNED_CALLBACKS"
        ),
        ALLOW_UNSIGNED_SMARTVM_CALLBACKS: this.configService.get<string>(
          "ALLOW_UNSIGNED_SMARTVM_CALLBACKS"
        ),
        SMARTVM_AUTO_FORWARD_SETTLEMENT_PAYMENT_SUCCESS: this.configService.get<string>(
          "SMARTVM_AUTO_FORWARD_SETTLEMENT_PAYMENT_SUCCESS"
        )
      });

      if (
        this.isLiveDataPlane() &&
        this.configService.get<string>("SMARTVM_MODE")?.trim().toLowerCase() ===
          "disabled"
      ) {
        throw new ServiceUnavailableException(
          "柜机平台尚未接入，当前实例不能执行柜机查询或控制操作。"
        );
      }
    } catch (error) {
      if (error instanceof ServiceUnavailableException) {
        throw error;
      }

      throw new BadRequestException(
        error instanceof Error ? error.message : "SmartVM 数据平面配置无效。"
      );
    }
  }

  private getFullSimulationTransportMode() {
    return resolveFullSimulationExternalMode("smartvm", {
      VM_DATA_PLANE: this.configService.get<string>("VM_DATA_PLANE"),
      VM_SIMULATION_PROFILE: this.configService.get<string>("VM_SIMULATION_PROFILE"),
      VM_FULL_SIMULATION_ENABLED: this.configService.get<string>("VM_FULL_SIMULATION_ENABLED"),
      VM_FULL_SIMULATION_SMARTVM_MODE: this.configService.get<string>(
        "VM_FULL_SIMULATION_SMARTVM_MODE"
      )
    });
  }

  private isLiveDataPlane() {
    return this.configService.get<string>("VM_DATA_PLANE")?.trim().toLowerCase() === "live";
  }
}
