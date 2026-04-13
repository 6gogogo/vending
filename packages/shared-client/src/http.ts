import type { ApiEnvelope } from "@vm/shared-types";

export interface JsonClientOptions {
  baseUrl: string;
  getToken?: () => string | undefined;
  fetchImpl?: typeof fetch;
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
}

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

export const createJsonClient = ({ baseUrl, getToken, fetchImpl = fetch }: JsonClientOptions) => {
  const request = async <T>(
    method: "GET" | "POST" | "PATCH" | "DELETE",
    path: string,
    body?: unknown,
    options: RequestOptions = {}
  ): Promise<T> => {
    const response = await fetchImpl(buildUrl(baseUrl, path, options.query), {
      method,
      headers: {
        "Content-Type": "application/json",
        ...(getToken?.() ? { Authorization: `Bearer ${getToken?.()}` } : {}),
        ...options.headers
      },
      body: body === undefined ? undefined : JSON.stringify(body)
    });

    const json = (await response.json()) as ApiEnvelope<T> | T;

    if (!response.ok) {
      throw new ApiError(`HTTP ${response.status}`, response.status, json);
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
