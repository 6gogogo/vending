import type { ApiEnvelope } from "@vm/shared-types";

export interface JsonClientOptions {
  baseUrl: string;
  getToken?: () => string | undefined;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

export class ApiError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly body?: unknown
  ) {
    super(message);
  }
}

export interface RequestOptions {
  query?: Record<string, string | number | undefined>;
  headers?: Record<string, string>;
  timeoutMs?: number;
}

const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;

const normalizeTimeoutMs = (value: number | undefined, fallback = DEFAULT_REQUEST_TIMEOUT_MS) =>
  Number.isFinite(value) && Number(value) > 0 ? Math.round(Number(value)) : fallback;

const buildQueryString = (query?: RequestOptions["query"]) => {
  if (!query) {
    return "";
  }

  return Object.entries(query)
    .filter(([, value]) => value !== undefined)
    .map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(String(value))}`)
    .join("&");
};

const buildUrl = (baseUrl: string, path: string, query?: RequestOptions["query"]) => {
  const normalizedBase = baseUrl.replace(/\/$/, "");
  const normalizedPath = path.startsWith("/") ? path : `/${path}`;
  const url = `${normalizedBase}${normalizedPath}`;
  const queryString = buildQueryString(query);

  if (!queryString) {
    return url;
  }

  return `${url}${url.includes("?") ? "&" : "?"}${queryString}`;
};

export const createJsonClient = ({
  baseUrl,
  getToken,
  fetchImpl = fetch,
  timeoutMs = DEFAULT_REQUEST_TIMEOUT_MS
}: JsonClientOptions) => {
  const request = async <T>(
    method: "GET" | "POST" | "PATCH" | "DELETE",
    path: string,
    body?: unknown,
    options: RequestOptions = {}
  ): Promise<T> => {
    const effectiveTimeoutMs = normalizeTimeoutMs(options.timeoutMs, normalizeTimeoutMs(timeoutMs));
    const controller = typeof AbortController === "undefined" ? undefined : new AbortController();
    let rejectForTimeout: ((reason: ApiError) => void) | undefined;
    const timeoutPromise = new Promise<never>((_, reject) => {
      rejectForTimeout = reject;
    });
    const timer = setTimeout(() => {
      controller?.abort();
      rejectForTimeout?.(new ApiError("请求超时，请检查网络后重试。", 408));
    }, effectiveTimeoutMs);
    let result: { response: Response; json: ApiEnvelope<T> | T };

    try {
      const requestPromise = (async () => {
        const response = await fetchImpl(buildUrl(baseUrl, path, options.query), {
          method,
          headers: {
            "Content-Type": "application/json",
            ...(getToken?.() ? { Authorization: `Bearer ${getToken?.()}` } : {}),
            ...options.headers
          },
          body: body === undefined ? undefined : JSON.stringify(body),
          signal: controller?.signal
        });
        const json = (await response.json()) as ApiEnvelope<T> | T;
        return { response, json };
      })();

      result = await Promise.race([
        requestPromise,
        timeoutPromise
      ]);
    } catch (error) {
      if (error instanceof ApiError) {
        throw error;
      }

      if (controller?.signal.aborted) {
        throw new ApiError("请求超时，请检查网络后重试。", 408);
      }

      throw error;
    } finally {
      clearTimeout(timer);
    }

    const { response, json } = result;

    if (!response.ok) {
      const responseMessage =
        typeof json === "object" &&
        json !== null &&
        "message" in json &&
        typeof (json as { message?: unknown }).message === "string"
          ? (json as { message: string }).message
          : `HTTP ${response.status}`;

      throw new ApiError(responseMessage, response.status, json);
    }

    if (typeof json === "object" && json !== null && "code" in json && "data" in json) {
      const envelope = json as ApiEnvelope<T>;

      if (envelope.code >= 400) {
        throw new ApiError(envelope.message, envelope.code, envelope);
      }

      return envelope.data;
    }

    return json as T;
  };

  return {
    get: <T>(path: string, options?: RequestOptions) => request<T>("GET", path, undefined, options),
    post: <T>(path: string, body?: unknown, options?: RequestOptions) =>
      request<T>("POST", path, body, options),
    patch: <T>(path: string, body?: unknown, options?: RequestOptions) =>
      request<T>("PATCH", path, body, options),
    delete: <T>(path: string, options?: RequestOptions) =>
      request<T>("DELETE", path, undefined, options)
  };
};
