import { BadGatewayException, BadRequestException, Inject, Injectable } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";

import type { AiProviderStatus } from "@vm/shared-types";

import { appendSystemAuditLog } from "../../common/store/persistence";

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

@Injectable()
export class OpenAiCompatibleService {
  constructor(@Inject(ConfigService) private readonly configService: ConfigService) {}

  getStatus(): AiProviderStatus {
    const missingConfig: string[] = [];

    if (!this.apiKey) {
      missingConfig.push("OPENAI_API_KEY");
    }

    return {
      enabled: missingConfig.length === 0,
      provider: "openai-compatible",
      baseUrl: this.baseUrl,
      model: this.model,
      missingConfig
    };
  }

  async completeJson<T>(payload: {
    task: string;
    systemPrompt: string;
    userPrompt: string;
    temperature?: number;
    maxTokens?: number;
  }) {
    this.assertEnabled();
    const requestUrl = `${this.baseUrl}/chat/completions`;
    const startedAt = Date.now();
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);

    let responseStatus = 500;
    let parsedResponse: ChatCompletionResponse | string | undefined;

    try {
      const response = await fetch(requestUrl, {
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
      const rawText = await response.text();
      parsedResponse = this.tryParseJson(rawText) ?? rawText;

      this.logExchange({
        task: payload.task,
        requestUrl,
        statusCode: response.status,
        durationMs: Date.now() - startedAt,
        response: parsedResponse
      });

      if (!response.ok) {
        throw new BadGatewayException(
          this.extractErrorMessage(parsedResponse) ?? `AI 服务请求失败，HTTP ${response.status}`
        );
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

      if (error instanceof BadGatewayException) {
        throw error;
      }

      if (error instanceof Error && error.name === "AbortError") {
        throw new BadGatewayException("AI 服务请求超时，请稍后重试。");
      }

      throw new BadGatewayException(
        error instanceof Error ? error.message : "AI 服务调用失败。"
      );
    } finally {
      clearTimeout(timeout);
    }
  }

  private get apiKey() {
    return this.configService.get<string>("OPENAI_API_KEY")?.trim();
  }

  private get baseUrl() {
    return (
      this.configService.get<string>("OPENAI_BASE_URL")?.trim().replace(/\/$/, "") ||
      "https://api.openai.com/v1"
    );
  }

  private get model() {
    return this.configService.get<string>("OPENAI_MODEL")?.trim() || "gpt-4.1-mini";
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

  private extractErrorMessage(response: ChatCompletionResponse | string | undefined) {
    if (typeof response === "string") {
      return response.trim() || undefined;
    }

    if (!response) {
      return undefined;
    }

    if (typeof response.error?.message === "string" && response.error.message.trim()) {
      return response.error.message.trim();
    }

    return undefined;
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
    appendSystemAuditLog({
      occurredAt: new Date().toISOString(),
      method: "POST",
      path: "/external/openai/chat/completions",
      body: {
        task: payload.task,
        model: this.model
      },
      statusCode: payload.statusCode,
      durationMs: payload.durationMs,
      response:
        typeof payload.response === "string"
          ? payload.response.slice(0, 1200)
          : payload.response
            ? {
                model: payload.response.model,
                usage: payload.response.usage,
                preview: this.readPreview(payload.response)
              }
            : undefined,
      error: payload.error,
      metadata: {
        upstreamBaseUrl: this.baseUrl,
        requestUrl: payload.requestUrl
      }
    });
  }

  private readPreview(response: ChatCompletionResponse) {
    const content = response.choices?.[0]?.message?.content;

    if (typeof content === "string") {
      return content.slice(0, 1200);
    }

    if (Array.isArray(content)) {
      return content
        .map((entry) => (typeof entry?.text === "string" ? entry.text : ""))
        .join("")
        .slice(0, 1200);
    }

    return "";
  }
}
