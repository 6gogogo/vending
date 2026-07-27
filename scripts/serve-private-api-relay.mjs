import { createServer, request as createUpstreamRequest } from "node:http";
import { isIP, isIPv4 } from "node:net";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const DEFAULT_PORT = 8100;
const DEFAULT_UPSTREAM_PORT = 8100;
const LOOPBACK_HOST = "127.0.0.1";
const RELAY_TIMEOUT_MS = 30_000;
const healthProbePaths = new Set([
  "/api/health",
  "/api/health/production-readiness"
]);

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

const isLoopbackHost = (value) => {
  const host = String(value ?? "").trim().toLowerCase().replace(/^\[|\]$/gu, "");
  if (host === "::1") {
    return true;
  }

  return isIPv4(host) && host.split(".")[0] === "127";
};

const isPrivateIpv4 = (host) => {
  if (!isIPv4(host)) {
    return false;
  }

  const [first, second] = host.split(".").map(Number);
  return (
    first === 10 ||
    (first === 172 && second >= 16 && second <= 31) ||
    (first === 192 && second === 168)
  );
};

const resolvePort = (value, name, fallback) => {
  if (value === undefined || String(value).trim() === "") {
    return fallback;
  }

  const normalized = Number(value);
  if (!Number.isInteger(normalized) || normalized < 1 || normalized > 65_535) {
    throw new Error(`${name} must be an integer between 1 and 65535`);
  }

  return normalized;
};

const resolvePrivateHost = (value, name) => {
  const normalized = String(value ?? "").trim();
  if (!normalized) {
    throw new Error(`${name} is required`);
  }

  if (!isPrivateIpv4(normalized) && !isLoopbackHost(normalized)) {
    throw new Error(`${name} must be a private or loopback IP address`);
  }

  return normalized;
};

const resolveCommaSeparated = (value, name, resolveEntry) => {
  const entries = String(value ?? "")
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);

  if (entries.length === 0) {
    throw new Error(`${name} is required`);
  }

  return new Set(entries.map(resolveEntry));
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
    throw new Error("PRIVATE_API_RELAY_ALLOWED_HOSTS must contain valid DNS hostnames");
  }

  return normalized;
};

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

const trustedRequestContext = (incoming, allowedHosts) => {
  const clientIp = normalizeIp(
    getSingleHeader(incoming.headers, "x-vending-relay-client-ip")
  );
  const host = normalizeAllowedHost(
    getSingleHeader(incoming.headers, "x-vending-relay-host")
  );
  const proto = getSingleHeader(incoming.headers, "x-vending-relay-proto")
    ?.toLowerCase();

  if (isIP(clientIp) === 0 || !allowedHosts.has(host) || proto !== "https") {
    return undefined;
  }

  return { clientIp, host, proto };
};

const copyUpstreamHeaders = (incoming, context) => {
  const headers = {};
  const connectionNames = connectionHeaderNames(incoming.headers);

  for (const [name, value] of Object.entries(incoming.headers)) {
    if (value === undefined || isRemovedInboundHeader(name, connectionNames)) {
      continue;
    }
    headers[name.toLowerCase()] = value;
  }

  headers.host = context.host;
  headers["x-forwarded-for"] = context.clientIp;
  headers["x-forwarded-host"] = context.host;
  headers["x-forwarded-proto"] = context.proto;
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

const isSafeRequestTarget = (value) =>
  typeof value === "string" && value.startsWith("/") && !value.startsWith("//");

export const resolvePrivateApiRelayConfig = (env = process.env) => {
  const upstreamHost = String(env.PRIVATE_API_RELAY_UPSTREAM_HOST ?? LOOPBACK_HOST).trim();
  if (!isLoopbackHost(upstreamHost)) {
    throw new Error("PRIVATE_API_RELAY_UPSTREAM_HOST must be a loopback address");
  }

  const allowedSources = resolveCommaSeparated(
    env.PRIVATE_API_RELAY_ALLOWED_SOURCES,
    "PRIVATE_API_RELAY_ALLOWED_SOURCES",
    (source) => resolvePrivateHost(source, "PRIVATE_API_RELAY_ALLOWED_SOURCES")
  );
  const allowedHosts = resolveCommaSeparated(
    env.PRIVATE_API_RELAY_ALLOWED_HOSTS,
    "PRIVATE_API_RELAY_ALLOWED_HOSTS",
    normalizeAllowedHost
  );
  const rawHealthProbeSource = String(env.PRIVATE_API_RELAY_HEALTH_PROBE_SOURCE ?? "").trim();
  const healthProbeSource = rawHealthProbeSource
    ? resolvePrivateHost(rawHealthProbeSource, "PRIVATE_API_RELAY_HEALTH_PROBE_SOURCE")
    : undefined;

  if (healthProbeSource && !allowedSources.has(healthProbeSource)) {
    throw new Error("PRIVATE_API_RELAY_HEALTH_PROBE_SOURCE must be in PRIVATE_API_RELAY_ALLOWED_SOURCES");
  }

  return {
    bindHost: resolvePrivateHost(env.PRIVATE_API_RELAY_BIND_HOST, "PRIVATE_API_RELAY_BIND_HOST"),
    port: resolvePort(env.PRIVATE_API_RELAY_PORT, "PRIVATE_API_RELAY_PORT", DEFAULT_PORT),
    allowedSources,
    allowedHosts,
    healthProbeSource,
    upstreamHost,
    upstreamPort: resolvePort(
      env.PRIVATE_API_RELAY_UPSTREAM_PORT,
      "PRIVATE_API_RELAY_UPSTREAM_PORT",
      DEFAULT_UPSTREAM_PORT
    )
  };
};

export const createPrivateApiRelayServer = (config) => {
  const server = createServer((incoming, outgoing) => {
    const source = normalizeIp(incoming.socket.remoteAddress);
    const isHealthProbeSource = source === config.healthProbeSource;
    if (!config.allowedSources.has(source)) {
      incoming.resume();
      writeEmptyResponse(outgoing, 403);
      return;
    }

    if (!isSafeRequestTarget(incoming.url)) {
      incoming.resume();
      writeEmptyResponse(outgoing, 400);
      return;
    }

    let context;
    if (isHealthProbeSource) {
      if (incoming.method !== "GET" || !healthProbePaths.has(incoming.url ?? "")) {
        incoming.resume();
        writeEmptyResponse(outgoing, 403);
        return;
      }

      context = {
        clientIp: source,
        host: config.allowedHosts.values().next().value,
        proto: "https"
      };
    } else {
      try {
        context = trustedRequestContext(incoming, config.allowedHosts);
      } catch {
        context = undefined;
      }
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
        headers: copyUpstreamHeaders(incoming, context)
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
      upstream.destroy(new Error("private API relay upstream timeout"));
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
  const config = resolvePrivateApiRelayConfig();
  const server = createPrivateApiRelayServer(config);

  await new Promise((resolveListening, rejectListening) => {
    server.once("error", rejectListening);
    server.listen(config.port, config.bindHost, () => {
      server.off("error", rejectListening);
      resolveListening();
    });
  });

  console.log(`private_api_relay_listening=${config.bindHost}:${config.port}`);

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
