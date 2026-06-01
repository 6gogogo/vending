const fs = require("node:fs");
const path = require("node:path");
const { spawn } = require("node:child_process");

const apiBase = "http://127.0.0.1:4000/api";
const storePath = path.join(process.cwd(), "apps/api/runtime-data/store.json");
const outDir = path.join(process.cwd(), "docs/test-artifacts/business-flow-audit-2026-06-02/screens");
const chromePath = "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
const remotePort = 9333;

fs.mkdirSync(outDir, { recursive: true });

function readStore() {
  return JSON.parse(fs.readFileSync(storePath, "utf8"));
}

function latestAuditUser(role) {
  const store = readStore();
  const prefix = role === "special" ? "审计用户" : "审计商家";
  return store.users
    .filter((user) => user.role === role && String(user.name).startsWith(prefix))
    .sort((left, right) => String(right.id).localeCompare(String(left.id)))[0];
}

function latestCode(phone, fallback) {
  if (fallback) {
    return fallback;
  }
  const entry = (readStore().verificationCodes || []).find(([key]) => key === phone);
  if (!entry) {
    throw new Error(`No verification code for ${phone}`);
  }
  return entry[1].code;
}

async function req(method, url, body, token) {
  const res = await fetch(`${apiBase}${url}`, {
    method,
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {})
    },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  const text = await res.text();
  const json = text ? JSON.parse(text) : undefined;
  if (!res.ok || json?.code >= 400) {
    throw new Error(json?.message || `HTTP ${res.status}`);
  }
  return json?.data ?? json;
}

async function codeFor(phone, scene) {
  try {
    const response = await req("POST", "/auth/request-code", { phone, scene });
    return latestCode(phone, response.previewCode);
  } catch (error) {
    if (String(error.message).includes("验证码发送过于频繁")) {
      return latestCode(phone);
    }
    throw error;
  }
}

async function buildSessions() {
  const admin = await req("POST", "/auth/backoffice-login", {
    username: "super",
    password: "super123"
  });

  const special = latestAuditUser("special");
  const merchant = latestAuditUser("merchant");

  if (!special || !merchant) {
    throw new Error("Missing audit special/merchant users. Run business-edge-e2e.cjs first.");
  }

  const specialCode = await codeFor(special.phone, "app-login");
  const merchantCode = await codeFor(merchant.phone, "app-login");
  const specialSession = await req("POST", "/auth/app-login", {
    phone: special.phone,
    code: specialCode
  });
  const merchantSession = await req("POST", "/auth/app-login", {
    phone: merchant.phone,
    code: merchantCode
  });

  const store = readStore();
  const device =
    store.devices
      .filter((entry) => String(entry.deviceCode).startsWith("AUDIT-"))
      .sort((left, right) => String(right.deviceCode).localeCompare(String(left.deviceCode)))[0] ??
    store.devices[0];

  return {
    admin,
    special: specialSession,
    merchant: merchantSession,
    deviceCode: device.deviceCode
  };
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForChrome() {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${remotePort}/json/version`);
      if (response.ok) {
        return;
      }
    } catch {
      await delay(250);
    }
  }
  throw new Error("Chrome remote debugging endpoint did not start.");
}

async function newTarget() {
  const response = await fetch(`http://127.0.0.1:${remotePort}/json/new?${encodeURIComponent("about:blank")}`, {
    method: "PUT"
  });
  const target = await response.json();
  return target.webSocketDebuggerUrl;
}

async function connect(wsUrl) {
  const ws = new WebSocket(wsUrl);
  const pending = new Map();
  let nextId = 1;

  await new Promise((resolve, reject) => {
    ws.onopen = resolve;
    ws.onerror = reject;
  });

  ws.onmessage = (event) => {
    const message = JSON.parse(event.data);
    if (message.id && pending.has(message.id)) {
      const { resolve, reject } = pending.get(message.id);
      pending.delete(message.id);
      if (message.error) {
        reject(new Error(message.error.message));
      } else {
        resolve(message.result);
      }
    }
  };

  return {
    send(method, params = {}) {
      const id = nextId++;
      ws.send(JSON.stringify({ id, method, params }));
      return new Promise((resolve, reject) => pending.set(id, { resolve, reject }));
    },
    close() {
      ws.close();
    }
  };
}

async function navigate(client, url, waitMs = 5_000) {
  await client.send("Page.navigate", { url });
  await delay(waitMs);
}

async function evalJs(client, expression) {
  return client.send("Runtime.evaluate", {
    expression,
    awaitPromise: true,
    returnByValue: true
  });
}

async function screenshot(client, fileName) {
  const result = await client.send("Page.captureScreenshot", {
    format: "png",
    captureBeyondViewport: true
  });
  const filePath = path.join(outDir, fileName);
  fs.writeFileSync(filePath, Buffer.from(result.data, "base64"));
  console.log(filePath);
}

function mobileStoragePayload(session) {
  return JSON.stringify({
    type: "object",
    data: {
      token: session.token,
      user: session.user,
      quota: session.quota
    }
  });
}

(async () => {
  const sessions = await buildSessions();
  const userDataDir = path.join(process.cwd(), "tmp-ux-screens", `business-audit-${Date.now()}`);
  fs.mkdirSync(userDataDir, { recursive: true });

  const chrome = spawn(chromePath, [
    "--headless=new",
    "--disable-gpu",
    "--remote-allow-origins=*",
    `--remote-debugging-port=${remotePort}`,
    `--user-data-dir=${userDataDir}`,
    "--window-size=480,1200",
    "about:blank"
  ], {
    stdio: "ignore",
    detached: false
  });

  try {
    await waitForChrome();
    const client = await connect(await newTarget());
    await client.send("Page.enable");
    await client.send("Runtime.enable");

    await navigate(client, "http://localhost:5173/#/pages/common/login");
    await screenshot(client, "01-mobile-entry.png");
    await navigate(client, "http://localhost:5173/#/pages/common/register");
    await screenshot(client, "02-mobile-register.png");
    await navigate(client, "http://localhost:5173/#/pages/common/feedback");
    await screenshot(client, "03-mobile-feedback.png");

    await evalJs(
      client,
      `localStorage.setItem("vm-mobile-session", ${JSON.stringify(mobileStoragePayload(sessions.special))})`
    );
    await navigate(client, `http://localhost:5173/?audit=special-${Date.now()}#/pages/tabs/primary`);
    await screenshot(client, "04a-mobile-user-feedback-resolved-modal.png");
    await evalJs(
      client,
      `Array.from(document.querySelectorAll("button,.uni-modal__btn")).find((element) => element.textContent.trim() === "确定")?.click()`
    );
    await delay(800);
    await screenshot(client, "04-mobile-user-home.png");
    await navigate(client, "http://localhost:5173/#/pages/tabs/nearby");
    await screenshot(client, "05-mobile-user-nearby.png");
    await navigate(client, `http://localhost:5173/#/pages/special/device-detail?deviceCode=${encodeURIComponent(sessions.deviceCode)}`);
    await screenshot(client, "06-mobile-user-device-detail.png");

    await evalJs(
      client,
      `localStorage.setItem("vm-mobile-session", ${JSON.stringify(mobileStoragePayload(sessions.merchant))})`
    );
    await navigate(client, `http://localhost:5173/?audit=merchant-${Date.now()}#/pages/tabs/primary`);
    await screenshot(client, "07-mobile-merchant-home.png");
    await navigate(client, `http://localhost:5173/#/pages/merchant/restock?deviceCode=${encodeURIComponent(sessions.deviceCode)}`);
    await screenshot(client, "08-mobile-merchant-restock.png");

    await navigate(client, "http://127.0.0.1:5173/login");
    await evalJs(
      client,
      `localStorage.setItem("vm-admin-session", ${JSON.stringify(JSON.stringify(sessions.admin))})`
    );
    await navigate(client, "http://127.0.0.1:5173/dashboard", 6_000);
    await screenshot(client, "09-admin-dashboard.png");
    await navigate(client, "http://127.0.0.1:5173/users", 6_000);
    await screenshot(client, "10-admin-users-permissions.png");
    await navigate(client, "http://127.0.0.1:5173/goods", 6_000);
    await screenshot(client, "11-admin-goods.png");
    await navigate(client, "http://127.0.0.1:5173/warehouse", 6_000);
    await screenshot(client, "12-admin-warehouse.png");

    client.close();
  } finally {
    chrome.kill();
  }
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
