const hasUrlProperty = (input: unknown): input is { url: string } =>
  typeof input === "object" &&
  input !== null &&
  "url" in input &&
  typeof (input as { url?: unknown }).url === "string";

const resolveUrl = (input: string | URL | Request) => {
  if (typeof input === "string") {
    return input;
  }

  if (hasUrlProperty(input)) {
    return input.url;
  }

  return String(input);
};

const normalizeBody = (body: BodyInit | null | undefined) => {
  if (typeof body !== "string") {
    return body;
  }

  try {
    return JSON.parse(body);
  } catch {
    return body;
  }
};

const normalizeHeaders = (headers: HeadersInit | undefined) => {
  if (!headers) {
    return {};
  }

  if (typeof Headers !== "undefined" && headers instanceof Headers) {
    const headerMap: Record<string, string> = {};

    headers.forEach((value, key) => {
      headerMap[key] = value;
    });

    return headerMap;
  }

  if (Array.isArray(headers)) {
    return Object.fromEntries(headers);
  }

  return headers as Record<string, string>;
};

// uni-app 在微信/支付宝小程序里没有浏览器原生 fetch，这里转成 uni.request 兼容多端。
export const uniRequestFetch: typeof fetch = ((input: string | URL | Request, init?: RequestInit) =>
  new Promise((resolve, reject) => {
    uni.request({
      url: resolveUrl(input),
      method: (init?.method ?? "GET") as never,
      header: normalizeHeaders(init?.headers),
      data: normalizeBody(init?.body),
      success: (response: { statusCode?: number; data: unknown }) => {
        const status = Number(response.statusCode ?? 500);
        const responseLike = {
          ok: status >= 200 && status < 300,
          status,
          json: async () => response.data
        } as Response;

        resolve(responseLike);
      },
      fail: (error: { errMsg?: string }) => {
        reject(new Error(error.errMsg || "请求失败。"));
      }
    });
  })) as typeof fetch;
