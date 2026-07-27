import { createServer } from "node:http";
import { isIPv4 } from "node:net";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const normalizeIp = (value) => {
  const normalized = String(value ?? "").trim().toLowerCase();
  return normalized.startsWith("::ffff:") ? normalized.slice("::ffff:".length) : normalized;
};

const isLoopbackHost = (value) => {
  const normalized = normalizeIp(value).replace(/^\[|\]$/gu, "");
  return normalized === "::1" || (isIPv4(normalized) && normalized.split(".")[0] === "127");
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

const resolvePort = (value, name) => {
  const normalized = Number(value);
  if (!Number.isInteger(normalized) || normalized < 1 || normalized > 65_535) {
    throw new Error(`${name} must be an integer between 1 and 65535`);
  }
  return normalized;
};

const resolvePrivateOrLoopbackHost = (value, name) => {
  const normalized = String(value ?? "").trim();
  if (!isLoopbackHost(normalized) && !isPrivateIpv4(normalized)) {
    throw new Error(`${name} must be a loopback or RFC1918 address`);
  }
  return normalized;
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
    throw new Error("PUBLIC_HTTP_ENTRY_REDIRECT_ALLOWED_HOSTS must contain valid DNS hostnames");
  }

  return normalized;
};

const resolveAllowedHosts = (value) => {
  const entries = String(value ?? "")
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
  if (entries.length === 0) {
    throw new Error("PUBLIC_HTTP_ENTRY_REDIRECT_ALLOWED_HOSTS is required");
  }
  return new Set(entries.map(normalizeAllowedHost));
};

const normalizeRequestHost = (value) => {
  const raw = String(value ?? "").trim();
  const match = /^([A-Za-z0-9.-]+)(?::([0-9]{1,5}))?$/u.exec(raw);
  if (!match) {
    throw new Error("invalid request host");
  }
  if (match[2] !== undefined) {
    resolvePort(match[2], "request host port");
  }
  return normalizeAllowedHost(match[1]);
};

const getSingleHeader = (headers, name) => {
  const value = headers[name];
  if (Array.isArray(value) || typeof value !== "string") {
    return undefined;
  }
  const normalized = value.trim();
  return normalized && !normalized.includes(",") ? normalized : undefined;
};

const resolveCanonicalHttpsOrigin = (value) => {
  let parsed;
  try {
    parsed = new URL(String(value ?? "").trim());
  } catch {
    throw new Error("PUBLIC_HTTP_ENTRY_REDIRECT_CANONICAL_HTTPS_URL must be a valid HTTPS URL");
  }

  if (
    parsed.protocol !== "https:" ||
    parsed.username ||
    parsed.password ||
    parsed.port ||
    parsed.pathname !== "/" ||
    parsed.search ||
    parsed.hash
  ) {
    throw new Error(
      "PUBLIC_HTTP_ENTRY_REDIRECT_CANONICAL_HTTPS_URL must be a credential-free HTTPS origin"
    );
  }

  return parsed.origin;
};

const writeEmptyResponse = (response, status, headers = {}) => {
  if (response.destroyed || response.writableEnded) {
    return;
  }
  response.writeHead(status, {
    "Cache-Control": "no-store",
    "Content-Length": "0",
    "X-Content-Type-Options": "nosniff",
    ...headers
  });
  response.end();
};

export const resolvePublicHttpEntryRedirectConfig = (env = process.env) => ({
  bindHost: resolvePrivateOrLoopbackHost(
    env.PUBLIC_HTTP_ENTRY_REDIRECT_BIND_HOST,
    "PUBLIC_HTTP_ENTRY_REDIRECT_BIND_HOST"
  ),
  port: resolvePort(env.PUBLIC_HTTP_ENTRY_REDIRECT_PORT, "PUBLIC_HTTP_ENTRY_REDIRECT_PORT"),
  allowedHosts: resolveAllowedHosts(env.PUBLIC_HTTP_ENTRY_REDIRECT_ALLOWED_HOSTS),
  canonicalHttpsOrigin: resolveCanonicalHttpsOrigin(
    env.PUBLIC_HTTP_ENTRY_REDIRECT_CANONICAL_HTTPS_URL
  )
});

export const createPublicHttpEntryRedirectServer = (config) => {
  const server = createServer((incoming, outgoing) => {
    if (incoming.method !== "GET" && incoming.method !== "HEAD") {
      incoming.resume();
      writeEmptyResponse(outgoing, 405, { Allow: "GET, HEAD" });
      return;
    }

    if (incoming.url !== "/") {
      incoming.resume();
      writeEmptyResponse(outgoing, 404);
      return;
    }

    let host;
    try {
      host = normalizeRequestHost(getSingleHeader(incoming.headers, "host"));
    } catch {
      host = undefined;
    }
    if (!host || !config.allowedHosts.has(host)) {
      incoming.resume();
      writeEmptyResponse(outgoing, 403);
      return;
    }

    writeEmptyResponse(outgoing, 308, { Location: `${config.canonicalHttpsOrigin}/` });
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
  const config = resolvePublicHttpEntryRedirectConfig();
  const server = createPublicHttpEntryRedirectServer(config);
  await new Promise((resolveListening, rejectListening) => {
    server.once("error", rejectListening);
    server.listen(config.port, config.bindHost, () => {
      server.off("error", rejectListening);
      resolveListening();
    });
  });

  console.log(`public_http_entry_redirect_listening=${config.bindHost}:${config.port}`);
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
