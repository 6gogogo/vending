import { createReadStream } from "node:fs";
import { realpath, stat } from "node:fs/promises";
import { createServer, request as createUpstreamRequest } from "node:http";
import { isIP, isIPv4 } from "node:net";
import { extname, isAbsolute, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const LOOPBACK_HOST = "127.0.0.1";
const DEFAULT_PORT = 5795;
const DEFAULT_ADMIN_ROOT = "apps/admin-web/dist";
const DEFAULT_MOBILE_ROOT = "apps/mobile/dist/build/h5";
const API_RELAY_TIMEOUT_MS = 30_000;
const API_RELAY_UPSTREAM_HOST = "127.0.0.1";
const API_RELAY_UPSTREAM_PORT = 8100;
const VNC_WIREGUARD_SOURCE = "10.66.66.1";
const VENDING_PUBLIC_HOST = "vending.5gogogo.top";

const hopByHopHeaders = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "proxy-connection",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade"
]);

const isAllowedPrivateIpv4 = (host) => {
  if (!isIPv4(host)) {
    return false;
  }

  const octets = host.split(".");
  const [first, second] = octets.map(Number);
  return (
    first === 10 ||
    (first === 172 && second >= 16 && second <= 31) ||
    (first === 192 && second === 168)
  );
};

const mimeTypeByExtension = new Map([
  [".avif", "image/avif"],
  [".css", "text/css; charset=utf-8"],
  [".gif", "image/gif"],
  [".html", "text/html; charset=utf-8"],
  [".ico", "image/x-icon"],
  [".jpeg", "image/jpeg"],
  [".jpg", "image/jpeg"],
  [".js", "text/javascript; charset=utf-8"],
  [".json", "application/json; charset=utf-8"],
  [".map", "application/json; charset=utf-8"],
  [".mjs", "text/javascript; charset=utf-8"],
  [".mp3", "audio/mpeg"],
  [".mp4", "video/mp4"],
  [".ogg", "audio/ogg"],
  [".otf", "font/otf"],
  [".pdf", "application/pdf"],
  [".png", "image/png"],
  [".svg", "image/svg+xml"],
  [".ttf", "font/ttf"],
  [".txt", "text/plain; charset=utf-8"],
  [".wasm", "application/wasm"],
  [".webmanifest", "application/manifest+json; charset=utf-8"],
  [".webp", "image/webp"],
  [".woff", "font/woff"],
  [".woff2", "font/woff2"],
  [".xml", "application/xml; charset=utf-8"]
]);

const errorRoute = (status, message) => ({
  kind: "error",
  status,
  message
});

const decodeRequestPath = (requestTarget) => {
  if (
    typeof requestTarget !== "string" ||
    !requestTarget.startsWith("/") ||
    requestTarget.startsWith("//")
  ) {
    return undefined;
  }

  const rawPath = requestTarget.split("?", 1)[0];
  let decodedPath;

  try {
    decodedPath = decodeURIComponent(rawPath);
  } catch {
    return undefined;
  }

  if (
    !decodedPath.startsWith("/") ||
    decodedPath.includes("//") ||
    decodedPath.includes("\\") ||
    decodedPath.includes("\0") ||
    /[\u0000-\u001f\u007f]/u.test(decodedPath)
  ) {
    return undefined;
  }

  const pathSegments = decodedPath.split("/");
  if (pathSegments.some((segment) => segment === "." || segment === "..")) {
    return undefined;
  }

  return decodedPath;
};

export const resolvePublicWebRoute = ({ method, requestTarget }) => {
  if (method !== "GET" && method !== "HEAD") {
    return errorRoute(405, "Method Not Allowed");
  }

  const pathname = decodeRequestPath(requestTarget);
  if (!pathname) {
    return errorRoute(400, "Bad Request");
  }

  // 公网 API 必须由同机 HTTPS 反向代理转发到 API 服务。静态服务不能把
  // /api/* 回退成后台 SPA，否则反代故障会被伪装成页面成功响应。
  if (pathname === "/api" || pathname.startsWith("/api/")) {
    return errorRoute(404, "Not Found");
  }

  const queryIndex = requestTarget.indexOf("?");
  const query = queryIndex >= 0 ? requestTarget.slice(queryIndex) : "";

  if (pathname === "/mobile") {
    return {
      kind: "redirect",
      status: 308,
      location: `/mobile/${query}`
    };
  }

  if (pathname === "/mobile/") {
    return {
      kind: "file",
      root: "mobile",
      relativePath: "index.html",
      fallback: false
    };
  }

  if (pathname.startsWith("/mobile/assets/")) {
    const relativePath = pathname.slice("/mobile/".length);
    if (!relativePath || relativePath.endsWith("/")) {
      return errorRoute(404, "Not Found");
    }

    return {
      kind: "file",
      root: "mobile",
      relativePath,
      fallback: false
    };
  }

  if (pathname.startsWith("/mobile/")) {
    return errorRoute(404, "Not Found");
  }

  return {
    kind: "file",
    root: "admin",
    relativePath: pathname.slice(1),
    fallback: !pathname.startsWith("/assets/") && extname(pathname) === ""
  };
};

export const resolvePublicWebPort = (value) => {
  if (value === undefined || String(value).trim() === "") {
    return DEFAULT_PORT;
  }

  const normalized = Number(value);
  if (!Number.isInteger(normalized) || normalized < 1 || normalized > 65_535) {
    throw new Error("PUBLIC_WEB_PORT must be an integer between 1 and 65535");
  }

  return normalized;
};

// 默认只绑定 loopback。受管的内网反向代理可以显式指定 RFC1918 地址，
// 但绝不接受 0.0.0.0、公开 IP 或主机名，避免静态服务被意外直接暴露。
export const resolvePublicWebBindHost = (value) => {
  if (value === undefined || String(value).trim() === "") {
    return LOOPBACK_HOST;
  }

  const normalized = String(value).trim();
  if (normalized === LOOPBACK_HOST || normalized === "::1" || isAllowedPrivateIpv4(normalized)) {
    return normalized;
  }

  throw new Error(
    "PUBLIC_WEB_BIND_HOST must be 127.0.0.1, ::1, or an RFC1918 private IPv4 address"
  );
};

// Spark 静态服务默认不代理 API。只有受管单元明确启用、固定为 VNC 的
// WireGuard 对端、固定为本机 API 上游时，才开放同源 /api/ 反代。
export const resolvePublicWebApiRelayConfig = (env = process.env) => {
  const enabled = String(env.PUBLIC_WEB_API_RELAY_ENABLED ?? "").trim();
  if (!enabled) {
    return undefined;
  }
  if (enabled !== "1") {
    throw new Error("PUBLIC_WEB_API_RELAY_ENABLED must be exactly 1");
  }

  if (String(env.PUBLIC_WEB_API_RELAY_ALLOWED_SOURCES ?? "").trim() !== VNC_WIREGUARD_SOURCE) {
    throw new Error("PUBLIC_WEB_API_RELAY_ALLOWED_SOURCES must be exactly 10.66.66.1");
  }
  if (String(env.PUBLIC_WEB_API_RELAY_ALLOWED_HOST ?? "").trim().toLowerCase() !== VENDING_PUBLIC_HOST) {
    throw new Error("PUBLIC_WEB_API_RELAY_ALLOWED_HOST must be exactly vending.5gogogo.top");
  }
  if (String(env.PUBLIC_WEB_API_RELAY_CLIENT_IP_POLICY ?? "").trim() !== "nginx-real-ip") {
    throw new Error("PUBLIC_WEB_API_RELAY_CLIENT_IP_POLICY must be nginx-real-ip");
  }
  if (String(env.PUBLIC_WEB_API_RELAY_UPSTREAM_HOST ?? "").trim() !== API_RELAY_UPSTREAM_HOST) {
    throw new Error("PUBLIC_WEB_API_RELAY_UPSTREAM_HOST must be exactly 127.0.0.1");
  }
  if (String(env.PUBLIC_WEB_API_RELAY_UPSTREAM_PORT ?? "").trim() !== String(API_RELAY_UPSTREAM_PORT)) {
    throw new Error("PUBLIC_WEB_API_RELAY_UPSTREAM_PORT must be exactly 8100");
  }

  return {
    allowedSources: new Set([VNC_WIREGUARD_SOURCE]),
    clientIpPolicy: "nginx-real-ip",
    host: VENDING_PUBLIC_HOST,
    upstreamHost: API_RELAY_UPSTREAM_HOST,
    upstreamPort: API_RELAY_UPSTREAM_PORT
  };
};

const isPathInside = (root, candidate) => {
  const relationship = relative(root, candidate);
  return relationship === "" || (!relationship.startsWith("..") && !isAbsolute(relationship));
};

const resolveExistingFile = async (root, relativePath) => {
  const candidate = resolve(root, relativePath || ".");
  if (!isPathInside(root, candidate)) {
    return undefined;
  }

  try {
    const resolvedCandidate = await realpath(candidate);
    if (!isPathInside(root, resolvedCandidate)) {
      return undefined;
    }

    const fileStat = await stat(resolvedCandidate);
    if (!fileStat.isFile()) {
      return undefined;
    }

    return {
      path: resolvedCandidate,
      size: fileStat.size
    };
  } catch {
    return undefined;
  }
};

const cacheControlFor = (filePath) =>
  extname(filePath).toLowerCase() === ".html"
    ? "no-store"
    : /[/\\]assets[/\\]/u.test(filePath)
      ? "public, max-age=31536000, immutable"
      : "public, max-age=3600";

const normalizeIp = (value) => {
  const normalized = String(value ?? "").trim().toLowerCase();
  return normalized.startsWith("::ffff:") ? normalized.slice("::ffff:".length) : normalized;
};

const getSingleHeader = (headers, name) => {
  const value = headers[name];
  if (Array.isArray(value) || typeof value !== "string") {
    return undefined;
  }

  const normalized = value.trim();
  return normalized && !normalized.includes(",") ? normalized : undefined;
};

const connectionHeaderNames = (headers) => {
  const value = headers.connection;
  const raw = Array.isArray(value) ? value.join(",") : value;
  return new Set(
    String(raw ?? "")
      .split(",")
      .map((entry) => entry.trim().toLowerCase())
      .filter(Boolean)
  );
};

const isRemovedApiInboundHeader = (name, connectionNames) => {
  const normalized = name.toLowerCase();
  return (
    hopByHopHeaders.has(normalized) ||
    connectionNames.has(normalized) ||
    normalized === "host" ||
    normalized === "forwarded" ||
    normalized === "x-real-ip" ||
    normalized.startsWith("x-forwarded-") ||
    normalized.startsWith("x-vending-")
  );
};

const copyApiUpstreamHeaders = (incoming, context) => {
  const headers = {};
  const connectionNames = connectionHeaderNames(incoming.headers);

  for (const [name, value] of Object.entries(incoming.headers)) {
    if (value === undefined || isRemovedApiInboundHeader(name, connectionNames)) {
      continue;
    }
    headers[name.toLowerCase()] = value;
  }

  headers.host = context.host;
  headers["x-forwarded-for"] = context.clientIp;
  headers["x-forwarded-host"] = context.host;
  headers["x-forwarded-proto"] = "https";
  return headers;
};

const copyApiDownstreamHeaders = (headers) => {
  const result = {};
  const connectionNames = connectionHeaderNames(headers);
  for (const [name, value] of Object.entries(headers)) {
    const normalized = name.toLowerCase();
    if (
      value !== undefined &&
      !hopByHopHeaders.has(normalized) &&
      !connectionNames.has(normalized) &&
      !normalized.startsWith("x-accel-")
    ) {
      result[name] = value;
    }
  }
  return result;
};

const writeEmptyResponse = (response, status) => {
  if (response.destroyed || response.writableEnded) {
    return;
  }
  if (response.headersSent) {
    response.destroy();
    return;
  }

  response.writeHead(status, {
    "Cache-Control": "no-store",
    "Content-Length": "0",
    "X-Content-Type-Options": "nosniff"
  });
  response.end();
};

const resolveApiRequestContext = (incoming, config, source) => {
  if (config.clientIpPolicy !== "nginx-real-ip") {
    return undefined;
  }

  const requestedClientIp = normalizeIp(getSingleHeader(incoming.headers, "x-real-ip"));
  const clientIp = isIP(requestedClientIp) === 0 ? source : requestedClientIp;

  return { clientIp, host: config.host };
};

const proxyApiRequest = (incoming, outgoing, config) => {
  const source = normalizeIp(incoming.socket.remoteAddress);
  if (!config.allowedSources.has(source)) {
    incoming.resume();
    writeEmptyResponse(outgoing, 403);
    return;
  }

  const context = resolveApiRequestContext(incoming, config, source);
  if (!context) {
    incoming.resume();
    writeEmptyResponse(outgoing, 403);
    return;
  }

  let upstreamResponse;
  const upstream = createUpstreamRequest(
    {
      agent: false,
      hostname: config.upstreamHost,
      port: config.upstreamPort,
      method: incoming.method,
      path: incoming.url,
      headers: copyApiUpstreamHeaders(incoming, context)
    },
    (receivedUpstreamResponse) => {
      upstreamResponse = receivedUpstreamResponse;
      outgoing.writeHead(
        receivedUpstreamResponse.statusCode ?? 502,
        copyApiDownstreamHeaders(receivedUpstreamResponse.headers)
      );
      receivedUpstreamResponse.once("error", () => outgoing.destroy());
      receivedUpstreamResponse.pipe(outgoing);
    }
  );

  upstream.setTimeout(API_RELAY_TIMEOUT_MS, () => {
    upstream.destroy(new Error("public web API relay upstream timeout"));
  });
  upstream.once("error", () => writeEmptyResponse(outgoing, 502));
  incoming.once("aborted", () => upstream.destroy());
  incoming.once("error", () => upstream.destroy());
  outgoing.once("close", () => {
    if (!outgoing.writableEnded) {
      upstreamResponse?.destroy();
      upstream.destroy();
    }
  });
  incoming.pipe(upstream);
};

const writeTextResponse = (response, method, status, message, extraHeaders = {}) => {
  const body = `${message}\n`;
  response.writeHead(status, {
    "Cache-Control": "no-store",
    "Content-Length": Buffer.byteLength(body),
    "Content-Type": "text/plain; charset=utf-8",
    "X-Content-Type-Options": "nosniff",
    ...extraHeaders
  });

  if (method === "HEAD") {
    response.end();
    return;
  }

  response.end(body);
};

const streamFileResponse = (response, method, file) => {
  const contentType = mimeTypeByExtension.get(extname(file.path).toLowerCase()) ??
    "application/octet-stream";

  response.writeHead(200, {
    "Cache-Control": cacheControlFor(file.path),
    "Content-Length": file.size,
    "Content-Type": contentType,
    "X-Content-Type-Options": "nosniff"
  });

  if (method === "HEAD") {
    response.end();
    return;
  }

  const stream = createReadStream(file.path);
  stream.on("error", () => response.destroy());
  stream.pipe(response);
};

export const createPublicWebServer = async ({ adminRoot, mobileRoot, apiRelay } = {}) => {
  const effectiveAdminRoot = await realpath(resolve(adminRoot ?? DEFAULT_ADMIN_ROOT));
  const effectiveMobileRoot = await realpath(resolve(mobileRoot ?? DEFAULT_MOBILE_ROOT));
  const adminIndex = await resolveExistingFile(effectiveAdminRoot, "index.html");
  const mobileIndex = await resolveExistingFile(effectiveMobileRoot, "index.html");

  if (!adminIndex || !mobileIndex) {
    throw new Error("Both admin and mobile build roots must contain index.html");
  }

  return createServer(async (request, response) => {
    const method = request.method ?? "";
    const pathname = decodeRequestPath(request.url ?? "");
    if (apiRelay && (pathname === "/api" || pathname?.startsWith("/api/"))) {
      proxyApiRequest(request, response, apiRelay);
      return;
    }
    const route = resolvePublicWebRoute({
      method,
      requestTarget: request.url ?? ""
    });

    if (route.kind === "error") {
      writeTextResponse(
        response,
        method,
        route.status,
        route.message,
        route.status === 405 ? { Allow: "GET, HEAD" } : {}
      );
      return;
    }

    if (route.kind === "redirect") {
      response.writeHead(route.status, {
        "Cache-Control": "no-store",
        "Content-Length": "0",
        Location: route.location,
        "X-Content-Type-Options": "nosniff"
      });
      response.end();
      return;
    }

    const root = route.root === "mobile" ? effectiveMobileRoot : effectiveAdminRoot;
    const requestedFile = await resolveExistingFile(root, route.relativePath);
    const file = requestedFile ?? (route.fallback ? adminIndex : undefined);

    if (!file) {
      writeTextResponse(response, method, 404, "Not Found");
      return;
    }

    streamFileResponse(response, method, file);
  });
};

const run = async () => {
  const port = resolvePublicWebPort(process.env.PUBLIC_WEB_PORT);
  const bindHost = resolvePublicWebBindHost(process.env.PUBLIC_WEB_BIND_HOST);
  const apiRelay = resolvePublicWebApiRelayConfig();
  const server = await createPublicWebServer({ apiRelay });

  await new Promise((resolveListening, rejectListening) => {
    server.once("error", rejectListening);
    server.listen(port, bindHost, () => {
      server.off("error", rejectListening);
      resolveListening();
    });
  });

  console.log(`public_web_listening=${bindHost}:${port}`);

  const shutdown = () => {
    server.close((error) => {
      process.exitCode = error ? 1 : 0;
    });
  };

  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
};

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  await run();
}
