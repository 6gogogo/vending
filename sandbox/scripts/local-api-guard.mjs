import { isIP } from "node:net";

const LOCAL_CANDIDATE_API_ERROR =
  "测试柜联调脚本仅允许指向本机候选 API；请将 LOCAL_API_BASE_URL 设置为 localhost、127.0.0.0/8 或 ::1 地址。";

export const assertLocalCandidateApiBaseUrl = (rawUrl) => {
  let parsedUrl;

  try {
    parsedUrl = new URL(rawUrl);
  } catch {
    throw new Error(`LOCAL_API_BASE_URL 不是合法 URL：${rawUrl}`);
  }

  const hostname = parsedUrl.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  const ipVersion = isIP(hostname);
  const isLoopback =
    hostname === "localhost" ||
    hostname === "::1" ||
    (ipVersion === 4 && hostname.split(".")[0] === "127");

  if (
    !isLoopback ||
    !["http:", "https:"].includes(parsedUrl.protocol) ||
    parsedUrl.username ||
    parsedUrl.password
  ) {
    throw new Error(LOCAL_CANDIDATE_API_ERROR);
  }
};
