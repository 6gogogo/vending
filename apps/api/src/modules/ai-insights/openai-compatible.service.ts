import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { isIP } from "node:net";
import {
  BadGatewayException,
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  Optional,
  ServiceUnavailableException
} from "@nestjs/common";
import { ConfigService } from "@nestjs/config";

import type { AiProviderConfigPayload, AiProviderStatus, AiProviderTestResult } from "@vm/shared-types";

import { sanitizeAuditLogEntry } from "../../common/logging/audit-log-sanitizer";
import { resolveFullSimulationExternalMode } from "../../common/config/full-simulation-mode";
import { isProductionRuntime } from "../../common/config/runtime-environment";
import { assertConfiguredRuntimeDataPlaneAiPolicy } from "../../common/config/runtime-data-plane-policy";
import { resolveApiEnvFile } from "../../common/store/persistence";
import {
  PrivateConfigWriteError,
  writePrivateConfigFileAtomically
} from "../../common/store/private-config-file";
import { SystemAuditLogService } from "../../common/store/system-audit-log.service";

interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

interface ChatCompletionResponse {
  model?: string;
  choices?: Array<{
    message?: {
      content?:
        | string
        | Array<{
            type?: string;
            text?: string;
          }>;
    };
  }>;
  usage?: Record<string, unknown>;
  error?: {
    message?: string;
    type?: string;
  };
}

const MAX_AI_RESPONSE_BYTES = 2 * 1024 * 1024;
const MAX_AI_API_KEY_LENGTH = 20_000;
const MAX_AI_MODEL_LENGTH = 200;
const AI_UPSTREAM_ERROR_MESSAGE = "AI 服务暂时不可用，请稍后重试。";
const OPENAI_EXACT_HOST_ALLOWLIST = "OPENAI_BASE_URL_EXACT_HOST_ALLOWLIST";

interface OpenAiCompatibleRuntimeAdapter {
  envFilePath?: string;
}

export const OPENAI_COMPATIBLE_RUNTIME_ADAPTER = Symbol(
  "OPENAI_COMPATIBLE_RUNTIME_ADAPTER"
);

const IPV4_NON_PUBLIC_RANGES: Array<[string, number]> = [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.0.2.0", 24],
  ["192.88.99.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 4],
  ["240.0.0.0", 4]
];

const RESERVED_DNS_SUFFIXES = [
  "localhost",
  "local",
  "internal",
  "lan",
  "localdomain",
  "home.arpa",
  "invalid",
  "test",
  "example",
  "onion"
];

const normalizeHostname = (value: string) =>
  value.trim().replace(/^\[|\]$/g, "").replace(/\.+$/, "").toLowerCase();

const ipv4ToInteger = (value: string) =>
  value.split(".").reduce((result, part) => (result << 8n) | BigInt(Number(part)), 0n);

const isIpv4InCidr = (value: string, base: string, prefixLength: number) => {
  const shift = BigInt(32 - prefixLength);
  return ipv4ToInteger(value) >> shift === ipv4ToInteger(base) >> shift;
};

const isPublicIpv4 = (value: string) =>
  !IPV4_NON_PUBLIC_RANGES.some(([base, prefixLength]) =>
    isIpv4InCidr(value, base, prefixLength)
  );

const ipv6ToInteger = (value: string) => {
  const [head = "", tail = ""] = value.split("::");
  const headParts = head ? head.split(":") : [];
  const tailParts = tail ? tail.split(":") : [];
  const missingParts = 8 - headParts.length - tailParts.length;
  const parts = value.includes("::")
    ? [...headParts, ...Array.from({ length: missingParts }, () => "0"), ...tailParts]
    : headParts;

  if (parts.length !== 8) {
    return undefined;
  }

  return parts.reduce((result, part) => (result << 16n) | BigInt(`0x${part || "0"}`), 0n);
};

const isIpv6InCidr = (value: bigint, base: bigint, prefixLength: number) => {
  const shift = BigInt(128 - prefixLength);
  return value >> shift === base >> shift;
};

const ipv6CidrBase = (value: string) => ipv6ToInteger(value) ?? 0n;

const isPublicIpv6 = (value: string) => {
  const address = ipv6ToInteger(value);

  if (address === undefined || !isIpv6InCidr(address, ipv6CidrBase("2000::"), 3)) {
    return false;
  }

  const nonPublicRanges: Array<[string, number]> = [
    ["2001::", 23],
    ["2001:db8::", 32],
    ["2002::", 16],
    ["3fff::", 20]
  ];

  return !nonPublicRanges.some(([base, prefixLength]) =>
    isIpv6InCidr(address, ipv6CidrBase(base), prefixLength)
  );
};

const isValidDnsHostname = (hostname: string, requireMultipleLabels: boolean) => {
  if (hostname.length > 253 || (requireMultipleLabels && !hostname.includes("."))) {
    return false;
  }

  const labels = hostname.split(".");
  if (
    labels.some(
      (label) =>
        !label ||
        label.length > 63 ||
        !/^[a-z0-9-]+$/i.test(label) ||
        label.startsWith("-") ||
        label.endsWith("-")
    )
  ) {
    return false;
  }

  return true;
};

const isPublicDnsHostname = (hostname: string) =>
  isValidDnsHostname(hostname, true) &&
  !RESERVED_DNS_SUFFIXES.some(
    (suffix) => hostname === suffix || hostname.endsWith(`.${suffix}`)
  );

@Injectable()
export class OpenAiCompatibleService {
  private readonly envFilePath: string;

  constructor(
    @Inject(ConfigService) private readonly configService: ConfigService,
    @Optional()
    @Inject(SystemAuditLogService)
    private readonly auditLog: SystemAuditLogService = new SystemAuditLogService(),
    @Optional()
    @Inject(OPENAI_COMPATIBLE_RUNTIME_ADAPTER)
    runtimeAdapter?: OpenAiCompatibleRuntimeAdapter
  ) {
    this.envFilePath = runtimeAdapter?.envFilePath ?? resolveApiEnvFile();
  }

  getStatus(): AiProviderStatus {
    const missingConfig: string[] = [];
    const usingFullSimulationMock = this.isUsingFullSimulationMockTransport();

    if (!usingFullSimulationMock && !this.apiKey) {
      missingConfig.push("OPENAI_API_KEY");
    }

    return {
      enabled: missingConfig.length === 0,
      provider: "openai-compatible",
      baseUrl: usingFullSimulationMock ? "mock://full-simulation-ai" : this.baseUrl,
      model: usingFullSimulationMock ? "full-simulation-mock" : this.model,
      missingConfig,
      apiKeyConfigured: Boolean(this.apiKey),
      usingDefaultBaseUrl: !this.readConfiguredBaseUrl(),
      usingDefaultModel: !this.readConfiguredModel()
    };
  }

  saveConfig(payload: AiProviderConfigPayload) {
    if (!payload || typeof payload !== "object") {
      throw new BadRequestException("AI 配置参数不正确。");
    }

    const nextApiKey = typeof payload.apiKey === "string" ? payload.apiKey.trim() : undefined;
    const nextBaseUrl = this.normalizeBaseUrl(
      typeof payload.baseUrl === "string" ? payload.baseUrl : this.readConfiguredBaseUrl() ?? ""
    );
    const nextModel = typeof payload.model === "string" ? payload.model.trim() : this.readConfiguredModel() ?? "";

    if ((nextApiKey?.length ?? 0) > MAX_AI_API_KEY_LENGTH) {
      throw new BadRequestException("AI API Key 长度不正确。");
    }

    if (nextApiKey !== undefined && /[\r\n\0]/.test(nextApiKey)) {
      throw new BadRequestException("AI API Key 格式不正确。");
    }

    if (nextModel.length > MAX_AI_MODEL_LENGTH || /[\r\n\0]/.test(nextModel)) {
      throw new BadRequestException("AI 模型名称不正确。");
    }

    this.assertRuntimeDataPlaneAiPolicy(nextApiKey ?? this.apiKey);

    const auditMetadata = {
      action: "save-ai-provider-config",
      provider: "openai-compatible",
      apiKeyUpdated: nextApiKey !== undefined,
      baseUrlCustomized: Boolean(nextBaseUrl),
      modelCustomized: Boolean(nextModel)
    };
    const criticalAudit = isProductionRuntime()
      ? this.auditLog.beginCriticalIntent({
          method: "PATCH",
          path: "/api/ai-insights/config",
          metadata: auditMetadata
        })
      : undefined;

    let configFileCommitted = false;

    try {
      const nextValues = {
        OPENAI_BASE_URL: nextBaseUrl,
        OPENAI_MODEL: nextModel,
        ...(nextApiKey === undefined ? {} : { OPENAI_API_KEY: nextApiKey })
      };
      this.persistEnvValues(nextValues);
      configFileCommitted = true;
      this.applyEnvironmentValues(nextValues);
      const status = this.getStatus();

      if (criticalAudit) {
        this.auditLog.completeCriticalOperation(criticalAudit, {
          method: "PATCH",
          path: "/api/ai-insights/config",
          statusCode: 200,
          durationMs: Date.now() - criticalAudit.startedAt,
          outcome: "completed",
          metadata: auditMetadata
        });
      } else {
        this.auditLog.appendSafely({
          occurredAt: new Date().toISOString(),
          method: "PATCH",
          path: "/api/ai-insights/config",
          statusCode: 200,
          durationMs: 0,
          metadata: {
            provider: "openai-compatible",
            hasApiKey: nextApiKey !== undefined ? Boolean(nextApiKey) : Boolean(this.apiKey),
            baseUrlCustomized: Boolean(nextBaseUrl),
            modelCustomized: Boolean(nextModel)
          }
        });
      }

      return status;
    } catch (error) {
      const operationIndeterminate =
        configFileCommitted ||
        (error instanceof PrivateConfigWriteError && error.committed);

      if (criticalAudit) {
        this.auditLog.completeCriticalOperation(criticalAudit, {
          method: "PATCH",
          path: "/api/ai-insights/config",
          statusCode: operationIndeterminate ? 409 : 500,
          durationMs: Date.now() - criticalAudit.startedAt,
          outcome: operationIndeterminate ? "indeterminate" : "failed",
          metadata: {
            ...auditMetadata,
            retryable: !operationIndeterminate
          }
        });
      }

      if (operationIndeterminate && criticalAudit) {
        throw new ConflictException({
          message: "AI 配置更新状态暂不可确认，请勿重复提交；请联系管理员核对。",
          code: "operation_indeterminate",
          operationId: criticalAudit.operationId,
          retryable: false
        });
      }
      throw error;
    }
  }

  async testConnection(): Promise<AiProviderTestResult> {
    const startedAt = Date.now();
    const testedAt = new Date().toISOString();

    if (this.isUsingFullSimulationMockTransport()) {
      this.assertRuntimeDataPlaneAiPolicy(this.apiKey);
      return {
        success: true,
        provider: "openai-compatible",
        model: "full-simulation-mock",
        baseUrl: "mock://full-simulation-ai",
        testedAt,
        latencyMs: Math.max(1, Date.now() - startedAt),
        message: "模拟 AI 自检通过；未调用外部模型。"
      };
    }

    const response = await this.completeJson<{ ok: boolean }>({
      task: "provider-health-check",
      systemPrompt: "你是 AI 接口连通性检查助手。只返回 JSON。",
      userPrompt: '请仅返回 {"ok":true}。',
      temperature: 0,
      maxTokens: 32
    });

    return {
      success: true,
      provider: "openai-compatible",
      model: response.model,
      baseUrl: this.baseUrl,
      testedAt,
      latencyMs: Math.max(1, Date.now() - startedAt),
      message: "模型接口调用成功。"
    };
  }

  async completeJson<T>(payload: {
    task: string;
    systemPrompt: string;
    userPrompt: string;
    temperature?: number;
    maxTokens?: number;
  }) {
    this.assertRuntimeDataPlaneAiPolicy(this.apiKey);

    if (this.isUsingFullSimulationMockTransport()) {
      return {
        model: "full-simulation-mock",
        data: {} as T
      };
    }

    this.assertEnabled();
    const requestUrl = `${this.baseUrl}/chat/completions`;
    const startedAt = Date.now();
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);

    let responseStatus = 500;
    let parsedResponse: ChatCompletionResponse | string | undefined;

    try {
      const response = await this.fetchWithCriticalAudit(requestUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${this.apiKey}`
        },
        body: JSON.stringify({
          model: this.model,
          temperature: payload.temperature ?? 0.2,
          max_tokens: payload.maxTokens ?? 1400,
          response_format: {
            type: "json_object"
          },
          messages: [
            {
              role: "system",
              content: payload.systemPrompt
            },
            {
              role: "user",
              content: payload.userPrompt
            }
          ]
        }),
        signal: controller.signal
      });

      responseStatus = response.status;
      const rawText = await this.readBoundedResponseText(response);
      parsedResponse = this.tryParseJson(rawText) ?? rawText;

      this.logExchange({
        task: payload.task,
        requestUrl,
        statusCode: response.status,
        durationMs: Date.now() - startedAt,
        response: parsedResponse
      });

      if (!response.ok) {
        throw new BadGatewayException(AI_UPSTREAM_ERROR_MESSAGE);
      }

      const messageContent = this.readMessageContent(parsedResponse);
      const parsedContent = this.parseJsonPayload(messageContent);

      return {
        model: this.readModel(parsedResponse),
        data: parsedContent as T
      };
    } catch (error) {
      if (parsedResponse === undefined) {
        this.logExchange({
          task: payload.task,
          requestUrl,
          statusCode: responseStatus,
          durationMs: Date.now() - startedAt,
          response: undefined,
          error:
            error instanceof Error
              ? {
                  name: error.name,
                  message: error.message
                }
              : {
                  name: "Error",
                  message: "未知错误"
                }
        });
      }

      if (error instanceof BadGatewayException || error instanceof ServiceUnavailableException) {
        throw error;
      }

      if (error instanceof Error && error.name === "AbortError") {
        throw new BadGatewayException("AI 服务请求超时，请稍后重试。");
      }

      throw new BadGatewayException(AI_UPSTREAM_ERROR_MESSAGE);
    } finally {
      clearTimeout(timeout);
    }
  }

  /**
   * 真实 AI 调用会外发业务上下文并可能计费；即使绕过 HTTP 入口，生产环境也必须先写审计意图。
   */
  private async fetchWithCriticalAudit(requestUrl: string, request: RequestInit) {
    const criticalAudit = isProductionRuntime()
      ? this.auditLog.beginCriticalIntent({
          method: "POST",
          path: "/internal/ai/outbound-completion",
          metadata: {
            action: "ai-completion",
            provider: "openai-compatible"
          }
        })
      : undefined;

    try {
      const response = await fetch(requestUrl, request);

      if (criticalAudit) {
        this.auditLog.completeCriticalOperation(criticalAudit, {
          method: "POST",
          path: "/internal/ai/outbound-completion",
          statusCode: response.status,
          durationMs: Date.now() - criticalAudit.startedAt,
          outcome: response.ok ? "completed" : "rejected",
          metadata: {
            action: "ai-completion",
            provider: "openai-compatible"
          }
        });
      }

      return response;
    } catch (error) {
      if (criticalAudit) {
        this.auditLog.completeCriticalOperation(criticalAudit, {
          method: "POST",
          path: "/internal/ai/outbound-completion",
          statusCode: error instanceof Error && error.name === "AbortError" ? 504 : 502,
          durationMs: Date.now() - criticalAudit.startedAt,
          outcome: "indeterminate",
          metadata: {
            action: "ai-completion",
            provider: "openai-compatible"
          }
        });
      }
      throw error;
    }
  }

  private get apiKey() {
    return this.configService.get<string>("OPENAI_API_KEY")?.trim();
  }

  private get baseUrl() {
    return this.normalizeBaseUrl(
      this.configService.get<string>("OPENAI_BASE_URL")?.trim().replace(/\/$/, "") ||
        "https://api.openai.com/v1"
    );
  }

  private get model() {
    return this.configService.get<string>("OPENAI_MODEL")?.trim() || "gpt-4.1-mini";
  }

  private readConfiguredBaseUrl() {
    return this.configService.get<string>("OPENAI_BASE_URL")?.trim();
  }

  private readConfiguredModel() {
    return this.configService.get<string>("OPENAI_MODEL")?.trim();
  }

  private get timeoutMs() {
    const configured = Number(this.configService.get<string>("OPENAI_TIMEOUT_MS") ?? 30_000);
    return Number.isFinite(configured) && configured > 1_000 ? configured : 30_000;
  }

  private assertEnabled() {
    if (!this.apiKey) {
      throw new BadRequestException("尚未配置 OPENAI_API_KEY，无法启用 AI 能力。");
    }
  }

  private assertRuntimeDataPlaneAiPolicy(apiKey: string | undefined) {
    try {
      assertConfiguredRuntimeDataPlaneAiPolicy({
        VM_DATA_PLANE: this.configService.get<string>("VM_DATA_PLANE"),
        VM_DATA_ROOT: this.configService.get<string>("VM_DATA_ROOT"),
        VM_DATA_PLANE_ID: this.configService.get<string>("VM_DATA_PLANE_ID"),
        VM_SIMULATION_PROFILE: this.configService.get<string>("VM_SIMULATION_PROFILE"),
        VM_FULL_SIMULATION_ENABLED: this.configService.get<string>("VM_FULL_SIMULATION_ENABLED"),
        VM_FULL_SIMULATION_AI_MODE: this.configService.get<string>(
          "VM_FULL_SIMULATION_AI_MODE"
        ),
        OPENAI_API_KEY: apiKey
      });
    } catch (error) {
      throw new BadRequestException(
        error instanceof Error ? error.message : "AI 数据平面配置无效。"
      );
    }
  }

  private isUsingFullSimulationMockTransport() {
    return resolveFullSimulationExternalMode("ai", {
      VM_DATA_PLANE: this.configService.get<string>("VM_DATA_PLANE"),
      VM_SIMULATION_PROFILE: this.configService.get<string>("VM_SIMULATION_PROFILE"),
      VM_FULL_SIMULATION_ENABLED: this.configService.get<string>("VM_FULL_SIMULATION_ENABLED"),
      VM_FULL_SIMULATION_AI_MODE: this.configService.get<string>(
        "VM_FULL_SIMULATION_AI_MODE"
      )
    }) === "mock";
  }

  private normalizeBaseUrl(value: string) {
    const trimmed = value.trim();

    if (!trimmed) {
      return "";
    }

    let parsed: URL;

    try {
      parsed = new URL(trimmed);
    } catch {
      throw new BadRequestException("AI 接口地址必须是有效 URL。");
    }

    if (!["http:", "https:"].includes(parsed.protocol)) {
      throw new BadRequestException("AI 接口地址只支持 HTTP 或 HTTPS。");
    }

    if (parsed.username || parsed.password || parsed.search || parsed.hash) {
      throw new BadRequestException("AI 接口地址不能包含账号、密码、查询参数或片段。");
    }

    const hostname = normalizeHostname(parsed.hostname);
    const allowlisted = this.readExactHostAllowlist().has(hostname);

    if (!allowlisted && parsed.protocol !== "https:") {
      throw new BadRequestException(
        `AI 接口地址默认必须使用 HTTPS；本地模型须在 ${OPENAI_EXACT_HOST_ALLOWLIST} 中精确允许主机。`
      );
    }

    if (!allowlisted && !this.isPublicBaseUrlHostname(hostname)) {
      throw new BadRequestException(
        `AI 接口地址不能指向本机、私网或保留地址；本地模型须在 ${OPENAI_EXACT_HOST_ALLOWLIST} 中精确允许主机。`
      );
    }

    return parsed.toString().replace(/\/$/, "");
  }

  private isPublicBaseUrlHostname(hostname: string) {
    const ipVersion = isIP(hostname);

    if (ipVersion === 4) {
      return isPublicIpv4(hostname);
    }

    if (ipVersion === 6) {
      return isPublicIpv6(hostname);
    }

    return isPublicDnsHostname(hostname);
  }

  private readExactHostAllowlist() {
    const raw = this.configService.get<string>(OPENAI_EXACT_HOST_ALLOWLIST)?.trim() ?? "";
    const hosts = raw
      .split(",")
      .map((entry) => entry.trim())
      .filter(Boolean)
      .map((entry) => this.normalizeAllowlistHost(entry));

    return new Set(hosts);
  }

  private normalizeAllowlistHost(value: string) {
    if (/[/\\?#@*\s]/.test(value)) {
      throw new BadRequestException(
        `${OPENAI_EXACT_HOST_ALLOWLIST} 只能填写逗号分隔的精确主机名或 IP，不能包含 URL、端口或通配符。`
      );
    }

    const unwrapped = value.startsWith("[") && value.endsWith("]") ? value.slice(1, -1) : value;
    const ipVersion = isIP(unwrapped);

    if (value.includes(":") && ipVersion !== 6) {
      throw new BadRequestException(
        `${OPENAI_EXACT_HOST_ALLOWLIST} 只能填写逗号分隔的精确主机名或 IP，不能包含 URL、端口或通配符。`
      );
    }

    try {
      const parsed = new URL(`http://${ipVersion === 6 ? `[${unwrapped}]` : value}`);
      const hostname = normalizeHostname(parsed.hostname);

      if (!hostname || (isIP(hostname) === 0 && !isValidDnsHostname(hostname, false))) {
        throw new Error("invalid hostname");
      }

      return hostname;
    } catch {
      throw new BadRequestException(
        `${OPENAI_EXACT_HOST_ALLOWLIST} 包含无效主机；仅支持精确主机名或 IP。`
      );
    }
  }

  private async readBoundedResponseText(response: Response) {
    const declaredLength = Number(response.headers.get("content-length"));

    if (Number.isFinite(declaredLength) && declaredLength > MAX_AI_RESPONSE_BYTES) {
      throw new BadGatewayException("AI 服务响应过大，已中止读取。");
    }

    if (!response.body) {
      return "";
    }

    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let receivedBytes = 0;

    try {
      while (true) {
        const { done, value } = await reader.read();

        if (done) {
          break;
        }

        receivedBytes += value.byteLength;
        if (receivedBytes > MAX_AI_RESPONSE_BYTES) {
          await reader.cancel("response too large");
          throw new BadGatewayException("AI 服务响应过大，已中止读取。");
        }

        chunks.push(value);
      }
    } finally {
      reader.releaseLock();
    }

    return Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))).toString("utf8");
  }

  private readMessageContent(response: ChatCompletionResponse | string | undefined) {
    if (!response || typeof response === "string") {
      throw new BadGatewayException("AI 服务未返回可解析的内容。");
    }

    const content = response.choices?.[0]?.message?.content;

    if (typeof content === "string" && content.trim()) {
      return content.trim();
    }

    if (Array.isArray(content)) {
      const merged = content
        .map((entry) => (typeof entry?.text === "string" ? entry.text : ""))
        .join("")
        .trim();

      if (merged) {
        return merged;
      }
    }

    throw new BadGatewayException("AI 服务返回为空，无法生成分析结果。");
  }

  private parseJsonPayload(value: string) {
    const direct = this.tryParseJson(value);

    if (direct && typeof direct === "object") {
      return direct;
    }

    const fenced = value.match(/```json\s*([\s\S]*?)```/i)?.[1] ?? value.match(/```\s*([\s\S]*?)```/i)?.[1];
    const fencedParsed = fenced ? this.tryParseJson(fenced) : undefined;

    if (fencedParsed && typeof fencedParsed === "object") {
      return fencedParsed;
    }

    const objectStart = value.indexOf("{");
    const objectEnd = value.lastIndexOf("}");

    if (objectStart >= 0 && objectEnd > objectStart) {
      const slicedParsed = this.tryParseJson(value.slice(objectStart, objectEnd + 1));

      if (slicedParsed && typeof slicedParsed === "object") {
        return slicedParsed;
      }
    }

    throw new BadGatewayException("AI 服务返回内容不是有效 JSON，请稍后重试。");
  }

  private tryParseJson(value: string) {
    try {
      return JSON.parse(value) as unknown;
    } catch {
      return undefined;
    }
  }

  private readModel(response: ChatCompletionResponse | string | undefined) {
    if (response && typeof response === "object" && typeof response.model === "string" && response.model.trim()) {
      return response.model;
    }

    return this.model;
  }

  private logExchange(payload: {
    task: string;
    requestUrl: string;
    statusCode: number;
    durationMs: number;
    response?: ChatCompletionResponse | string;
    error?: {
      name: string;
      message: string;
    };
  }) {
    this.auditLog.appendSafely({
      occurredAt: new Date().toISOString(),
      method: "POST",
      path: "/external/openai/chat/completions",
      body: {
        task: payload.task,
        model: this.model
      },
      statusCode: payload.statusCode,
      durationMs: payload.durationMs,
      response: payload.response ? this.summarizeResponseForAudit(payload.response) : undefined,
      error: sanitizeAuditLogEntry(payload.error),
      metadata: {
        upstreamBaseUrl: this.baseUrl,
        requestUrl: payload.requestUrl
      }
    });
  }

  private summarizeResponseForAudit(response: ChatCompletionResponse | string) {
    if (typeof response === "string") {
      return {
        format: "text",
        ...this.summarizeText(response)
      };
    }

    const content = response.choices?.[0]?.message?.content;
    const mergedContent =
      typeof content === "string"
        ? content
        : Array.isArray(content)
          ? content.map((entry) => (typeof entry?.text === "string" ? entry.text : "")).join("")
          : "";

    return sanitizeAuditLogEntry({
      model: this.model,
      usage: this.summarizeUsageForAudit(response.usage),
      content: mergedContent ? this.summarizeText(mergedContent) : undefined,
      upstreamError: response.error
        ? {
            type: response.error.type,
            message: response.error.message
          }
        : undefined
    });
  }

  private summarizeUsageForAudit(usage: Record<string, unknown> | undefined) {
    if (!usage) {
      return undefined;
    }

    const result: Record<string, number> = {};
    for (const key of [
      "prompt_tokens",
      "completion_tokens",
      "total_tokens",
      "input_tokens",
      "output_tokens"
    ]) {
      const value = usage[key];
      if (typeof value === "number" && Number.isFinite(value) && value >= 0) {
        result[key] = value;
      }
    }

    return Object.keys(result).length ? result : undefined;
  }

  private summarizeText(value: string) {
    return {
      byteLength: Buffer.byteLength(value, "utf8"),
      sha256: createHash("sha256").update(value, "utf8").digest("hex")
    };
  }

  private persistEnvValues(values: Record<string, string>) {
    const envFilePath = this.envFilePath;
    let nextContent = existsSync(envFilePath) ? readFileSync(envFilePath, "utf8") : "";

    for (const [name, value] of Object.entries(values)) {
      const nextEntry = `${name}=${this.encodeEnvValue(value)}`;
      const linePattern = new RegExp(`^${name}=.*$`, "m");
      nextContent = linePattern.test(nextContent)
        ? nextContent.replace(linePattern, nextEntry)
        : `${nextContent.replace(/\s*$/, "")}${nextContent.trim() ? "\n" : ""}${nextEntry}\n`;
    }

    writePrivateConfigFileAtomically(envFilePath, nextContent);
  }

  private applyEnvironmentValues(values: Record<string, string>) {
    for (const [name, value] of Object.entries(values)) {
      process.env[name] = value;
    }
  }

  private encodeEnvValue(value: string) {
    if (!value) {
      return "";
    }

    if (/[\s#"'`]/.test(value)) {
      return JSON.stringify(value);
    }

    return value;
  }
}
