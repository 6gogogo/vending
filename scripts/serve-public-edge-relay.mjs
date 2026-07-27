import { createServer, request as createUpstreamRequest } from "node:http";
import { isIP, isIPv4 } from "node:net";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const RELAY_TIMEOUT_MS = 30_000;
const loopbackHosts = new Set(["127.0.0.1", "::1"]);
const modes = new Set(["api", "static"]);
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

const resolvePort = (value, name) => {
  const normalized = Number(value);
  if (!Number.isInteger(normalized) || normalized < 1 || normalized > 65_535) {
    throw new Error(`${name} must be an integer between 1 and 65535`);
  }
  return normalized;
};

const normalizeIp = (value) => {
  const normalized = String(value ?? "").trim().toLowerCase();
  return normalized.startsWith("::ffff:") ? normalized.slice("::ffff:".length) : normalized;
};

const isLoopbackHost = (value) => {
  const normalized = normalizeIp(value).replace(/^\[|\]$/gu, "");
  return (
    loopbackHosts.has(normalized) ||
    (isIPv4(normalized) && normalized.split(".")[0] === "127")
  );
};

const isPrivateIpv4 = (value) => {
  const normalized = String(value ?? "").trim();
  if (!isIPv4(normalized)) {
    return false;
  }

  const [first, second] = normalized.split(".").map(Number);
  return (
    first === 10 ||
    (first === 172 && second >= 16 && second <= 31) ||
    (first === 192 && second === 168)
  );
};

const normalizeAllowedHost = (value) => {
  const normalized = String(value ?? "").trim().toLowerCase().replace(/\.$/u, "");
  const labels = normalized.split(".");
  const validLabel = (label) =>
    /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/u.test(label);

  if (
    !normalized ||
    normalized.length > 253 ||
    labels.length < 2 ||
    labels.some((label) => !validLabel(label))
  ) {
    throw new Error("PUBLIC_EDGE_RELAY_ALLOWED_HOSTS must contain valid DNS hostnames");
  }

  return normalized;
};

const resolveAllowedHosts = (value) => {
  const entries = String(value ?? "")
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
  if (entries.length === 0) {
    throw new Error("PUBLIC_EDGE_RELAY_ALLOWED_HOSTS is required");
  }
  return new Set(entries.map(normalizeAllowedHost));
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

const isRemovedInboundHeader = (name, connectionNames) => {
  const normalized = name.toLowerCase();
  return (
    hopByHopHeaders.has(normalized) ||
    connectionNames.has(normalized) ||
    normalized === "host" ||
    normalized === "forwarded" ||
    normalized === "x-real-ip" ||
    normalized.startsWith("x-forwarded-") ||
    normalized.startsWith("x-vending-relay-")
  );
};

const copyUpstreamHeaders = (incoming, context, mode) => {
  const headers = {};
  const connectionNames = connectionHeaderNames(incoming.headers);

  for (const [name, value] of Object.entries(incoming.headers)) {
    if (value === undefined || isRemovedInboundHeader(name, connectionNames)) {
      continue;
    }
    headers[name.toLowerCase()] = value;
  }

  headers.host = context.host;
  if (mode === "api") {
    headers["x-vending-relay-client-ip"] = context.clientIp;
    headers["x-vending-relay-host"] = context.host;
    headers["x-vending-relay-proto"] = "https";
  }
  return headers;
};

const copyDownstreamHeaders = (headers) => {
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

const resolveRequestContext = (incoming, config) => {
  const host = normalizeAllowedHost(getSingleHeader(incoming.headers, "host"));
  if (!config.allowedHosts.has(host)) {
    return undefined;
  }

  if (config.mode === "static") {
    return { host };
  }

  const clientIp = normalizeIp(getSingleHeader(incoming.headers, "x-real-ip"));
  const proto = getSingleHeader(incoming.headers, "x-forwarded-proto")?.toLowerCase();
  if (isIP(clientIp) === 0 || proto !== "https") {
    return undefined;
  }

  return { clientIp, host };
};

const isSafeRequestTarget = (value) =>
  typeof value === "string" && value.startsWith("/") && !value.startsWith("//");

export const resolvePublicEdgeRelayConfig = (env = process.env) => {
  const mode = String(env.PUBLIC_EDGE_RELAY_MODE ?? "").trim();
  if (!modes.has(mode)) {
    throw new Error("PUBLIC_EDGE_RELAY_MODE must be api or static");
  }

  const bindHost = String(env.PUBLIC_EDGE_RELAY_BIND_HOST ?? "").trim();
  if (!isLoopbackHost(bindHost)) {
    throw new Error("PUBLIC_EDGE_RELAY_BIND_HOST must be a loopback address");
  }

  const upstreamHost = String(env.PUBLIC_EDGE_RELAY_UPSTREAM_HOST ?? "").trim();
  if (!isPrivateIpv4(upstreamHost)) {
    throw new Error("PUBLIC_EDGE_RELAY_UPSTREAM_HOST must be an RFC1918 IPv4 address");
  }

  return {
    mode,
    bindHost,
    port: resolvePort(env.PUBLIC_EDGE_RELAY_PORT, "PUBLIC_EDGE_RELAY_PORT"),
    upstreamHost,
    upstreamPort: resolvePort(
      env.PUBLIC_EDGE_RELAY_UPSTREAM_PORT,
      "PUBLIC_EDGE_RELAY_UPSTREAM_PORT"
    ),
    allowedHosts: resolveAllowedHosts(env.PUBLIC_EDGE_RELAY_ALLOWED_HOSTS)
  };
};

export const createPublicEdgeRelayServer = (config) => {
  const server = createServer((incoming, outgoing) => {
    if (!isLoopbackHost(incoming.socket.remoteAddress)) {
      incoming.resume();
      writeEmptyResponse(outgoing, 403);
      return;
    }

    if (!isSafeRequestTarget(incoming.url)) {
      incoming.resume();
      writeEmptyResponse(outgoing, 400);
      return;
    }

    if (
      config.mode === "static" &&
      (incoming.url === "/api" || incoming.url?.startsWith("/api/"))
    ) {
      incoming.resume();
      writeEmptyResponse(outgoing, 404);
      return;
    }

    let context;
    try {
      context = resolveRequestContext(incoming, config);
    } catch {
      context = undefined;
    }

    if (!context) {
      incoming.resume();
      writeEmptyResponse(outgoing, 403);
      return;
    }

    let upstreamResponse;
    const upstream = createUpstreamRequest(
      {
        hostname: config.upstreamHost,
        port: config.upstreamPort,
        method: incoming.method,
        path: incoming.url,
        headers: copyUpstreamHeaders(incoming, context, config.mode)
      },
      (receivedUpstreamResponse) => {
        upstreamResponse = receivedUpstreamResponse;
        outgoing.writeHead(
          receivedUpstreamResponse.statusCode ?? 502,
          copyDownstreamHeaders(receivedUpstreamResponse.headers)
        );
        receivedUpstreamResponse.once("error", () => outgoing.destroy());
        receivedUpstreamResponse.pipe(outgoing);
      }
    );

    upstream.setTimeout(RELAY_TIMEOUT_MS, () => {
      upstream.destroy(new Error("public edge relay upstream timeout"));
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
  });

  server.on("connect", (_request, socket) => {
    socket.end("HTTP/1.1 405 Method Not Allowed\r\nConnection: close\r\n\r\n");
  });
  server.on("upgrade", (_request, socket) => {
    socket.end("HTTP/1.1 426 Upgrade Required\r\nConnection: close\r\n\r\n");
  });
  return server;
};

const run = async () => {
  const config = resolvePublicEdgeRelayConfig();
  const server = createPublicEdgeRelayServer(config);

  await new Promise((resolveListening, rejectListening) => {
    server.once("error", rejectListening);
    server.listen(config.port, config.bindHost, () => {
      server.off("error", rejectListening);
      resolveListening();
    });
  });

  console.log(`public_edge_relay_listening=${config.mode}:${config.bindHost}:${config.port}`);

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
