const fs = require("node:fs");
const path = require("node:path");
const { spawn } = require("node:child_process");

const apiBase = "http://127.0.0.1:4000/api";
const outDir = path.join(process.cwd(), "docs/test-artifacts/specialty-audit-2026-06-02/screens");
const storePath = path.join(process.cwd(), "apps/api/runtime-data/store.json");
const chromePath = "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
const remotePort = 9333;

fs.mkdirSync(outDir, { recursive: true });

function readStore() {
  return JSON.parse(fs.readFileSync(storePath, "utf8"));
}

function latestByRole(role, prefix) {
  return readStore().users
    .filter((user) => user.role === role && String(user.name).startsWith(prefix))
    .sort((left, right) => String(right.id).localeCompare(String(left.id)))[0];
}

function latestDevice(prefix) {
  return readStore().devices
    .filter((device) => String(device.deviceCode).startsWith(prefix))
    .sort((left, right) => String(right.deviceCode).localeCompare(String(left.deviceCode)))[0];
}

function latestGoods(prefix) {
  return readStore().goodsCatalog
    .filter((goods) => String(goods.goodsId).startsWith(prefix))
    .sort((left, right) => String(right.goodsId).localeCompare(String(left.goodsId)))[0];
}

function latestLogId() {
  return readStore().logs[0]?.id;
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
  const specialUser = latestByRole("special", "专项用户");
  const merchantUser = latestByRole("merchant", "merchantA商家");
  const device = latestDevice("SPEC-") ?? latestDevice("AUDIT-") ?? readStore().devices[0];
  const goods = latestGoods("specialty-goods-") ?? readStore().goodsCatalog[0];

  if (!specialUser || !merchantUser || !device || !goods) {
    throw new Error("Missing specialty audit data. Run specialty-e2e.cjs first.");
  }

  const specialCode = await codeFor(specialUser.phone, "app-login");
  const merchantCode = await codeFor(merchantUser.phone, "app-login");
  const special = await req("POST", "/auth/app-login", { phone: specialUser.phone, code: specialCode });
  const merchant = await req("POST", "/auth/app-login", { phone: merchantUser.phone, code: merchantCode });

  return {
    admin,
    special,
    merchant,
    deviceCode: device.deviceCode,
    goodsId: goods.goodsId,
    userId: specialUser.id,
    logId: latestLogId()
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

async function navigate(client, url, waitMs = 3500) {
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

async function setViewport(client, width, height) {
  await client.send("Emulation.setDeviceMetricsOverride", {
    width,
    height,
    deviceScaleFactor: 1,
    mobile: width <= 600
  });
}

async function screenshot(client, fileName, fullPage = false) {
  const result = await client.send("Page.captureScreenshot", {
    format: "png",
    captureBeyondViewport: fullPage
  });
  const filePath = path.join(outDir, fileName);
  fs.writeFileSync(filePath, Buffer.from(result.data, "base64"));
  return filePath;
}

async function pageMetrics(client, name, fileName) {
  const result = await evalJs(
    client,
    `(() => {
      const body = document.body;
      const root = document.documentElement;
      const visibleButtons = Array.from(document.querySelectorAll("button,a,input,select,textarea"))
        .filter((element) => {
          const rect = element.getBoundingClientRect();
          return rect.width > 0 && rect.height > 0 && rect.bottom >= 0 && rect.top <= window.innerHeight;
        }).length;
      const headings = Array.from(document.querySelectorAll("h1,h2,.page-title,.title"))
        .map((element) => element.textContent.trim())
        .filter(Boolean)
        .slice(0, 8);
      return {
        name: ${JSON.stringify(name)},
        path: location.pathname + location.hash,
        screenshot: ${JSON.stringify(fileName)},
        viewportHeight: window.innerHeight,
        scrollHeight: Math.max(body.scrollHeight, root.scrollHeight),
        ratio: Number((Math.max(body.scrollHeight, root.scrollHeight) / window.innerHeight).toFixed(2)),
        visibleButtons,
        headings
      };
    })()`
  );
  return result.result.value;
}

function mobileStoragePayload(session) {
  return {
    token: session.token,
    user: session.user,
    quota: session.quota
  };
}

(async () => {
  const sessions = await buildSessions();
  const userDataDir = path.join(process.cwd(), "tmp-ux-screens", `specialty-ui-${Date.now()}`);
  fs.mkdirSync(userDataDir, { recursive: true });

  const chrome = spawn(chromePath, [
    "--headless=new",
    "--disable-gpu",
    "--remote-allow-origins=*",
    `--remote-debugging-port=${remotePort}`,
    `--user-data-dir=${userDataDir}`,
    "--window-size=1440,1000",
    "about:blank"
  ], {
    stdio: "ignore",
    detached: false
  });

  const manifest = {
    generatedAt: new Date().toISOString(),
    mobile: [],
    admin: []
  };

  try {
    await waitForChrome();
    const client = await connect(await newTarget());
    await client.send("Page.enable");
    await client.send("Runtime.enable");

    await setViewport(client, 480, 920);
    const mobilePages = [
      ["01-mobile-login.png", "登录入口", "http://localhost:5173/#/pages/common/login"],
      ["02-mobile-register.png", "注册资料", "http://localhost:5173/#/pages/common/register"],
      ["03-mobile-feedback.png", "异常反馈", "http://localhost:5173/#/pages/common/feedback"]
    ];

    for (const [fileName, name, url] of mobilePages) {
      await navigate(client, url);
      await screenshot(client, fileName);
      manifest.mobile.push(await pageMetrics(client, name, fileName));
    }

    await evalJs(
      client,
      `(() => {
        const value = ${JSON.stringify(mobileStoragePayload(sessions.special))};
        if (window.uni?.setStorageSync) window.uni.setStorageSync("vm-mobile-session", value);
        localStorage.setItem("vm-mobile-session", JSON.stringify({ type: "object", data: value }));
      })()`
    );
    const userPages = [
      ["04-mobile-user-home.png", "用户首页", `http://localhost:5173/?audit=special-${Date.now()}#/pages/tabs/primary`],
      ["05-mobile-user-nearby.png", "附近柜机", `http://localhost:5173/?audit=special-${Date.now()}#/pages/tabs/nearby`],
      ["06-mobile-user-device.png", "用户柜机详情", `http://localhost:5173/?audit=special-${Date.now()}#/pages/special/device-detail?deviceCode=${encodeURIComponent(sessions.deviceCode)}`],
      ["07-mobile-user-records.png", "用户记录", `http://localhost:5173/?audit=special-${Date.now()}#/pages/tabs/records`],
      ["08-mobile-user-settings.png", "用户我的", `http://localhost:5173/?audit=special-${Date.now()}#/pages/tabs/settings`],
      ["09-mobile-user-history.png", "用户领取历史", `http://localhost:5173/?audit=special-${Date.now()}#/pages/special/history`]
    ];

    for (const [fileName, name, url] of userPages) {
      await navigate(client, url);
      await screenshot(client, fileName);
      manifest.mobile.push(await pageMetrics(client, name, fileName));
    }

    await evalJs(
      client,
      `(() => {
        const value = ${JSON.stringify(mobileStoragePayload(sessions.merchant))};
        if (window.uni?.setStorageSync) window.uni.setStorageSync("vm-mobile-session", value);
        localStorage.setItem("vm-mobile-session", JSON.stringify({ type: "object", data: value }));
      })()`
    );
    const merchantPages = [
      ["10-mobile-merchant-home.png", "商家首页", `http://localhost:5173/?audit=merchant-${Date.now()}#/pages/tabs/primary`],
      ["11-mobile-merchant-restock.png", "商家补货", `http://localhost:5173/?audit=merchant-${Date.now()}#/pages/merchant/restock?deviceCode=${encodeURIComponent(sessions.deviceCode)}`],
      ["12-mobile-merchant-templates.png", "商家常用商品", `http://localhost:5173/?audit=merchant-${Date.now()}#/pages/merchant/templates`],
      ["13-mobile-merchant-traces.png", "商家补货追踪", `http://localhost:5173/?audit=merchant-${Date.now()}#/pages/merchant/traces`],
      ["14-mobile-merchant-settings.png", "商家我的", `http://localhost:5173/?audit=merchant-${Date.now()}#/pages/tabs/settings`]
    ];

    for (const [fileName, name, url] of merchantPages) {
      await navigate(client, url);
      await screenshot(client, fileName);
      manifest.mobile.push(await pageMetrics(client, name, fileName));
    }

    await setViewport(client, 1440, 900);
    await navigate(client, "http://127.0.0.1:5173/login");
    await evalJs(client, `localStorage.setItem("vm-admin-session", ${JSON.stringify(JSON.stringify(sessions.admin))})`);

    const adminPages = [
      ["15-admin-platform.png", "全局工作台", "http://127.0.0.1:5173/platform"],
      ["16-admin-dashboard.png", "运营主控台", "http://127.0.0.1:5173/dashboard"],
      ["17-admin-users.png", "人员管理", "http://127.0.0.1:5173/users"],
      ["18-admin-user-detail.png", "人员详情", `http://127.0.0.1:5173/users/${encodeURIComponent(sessions.userId)}`],
      ["19-admin-goods.png", "货物总览", "http://127.0.0.1:5173/goods"],
      ["20-admin-goods-detail.png", "货物详情", `http://127.0.0.1:5173/goods/${encodeURIComponent(sessions.goodsId)}`],
      ["21-admin-warehouse.png", "仓库盘点", "http://127.0.0.1:5173/warehouse"],
      ["22-admin-operations.png", "柜机监控", "http://127.0.0.1:5173/operations"],
      ["23-admin-device-detail.png", "柜机详情", `http://127.0.0.1:5173/operations/${encodeURIComponent(sessions.deviceCode)}`],
      ["24-admin-data-monitor.png", "数据监控", "http://127.0.0.1:5173/data-monitor"],
      ["25-admin-ai.png", "AI 工作台", "http://127.0.0.1:5173/ai"],
      ["26-admin-settings.png", "系统设置", "http://127.0.0.1:5173/settings"],
      ["27-admin-logs.png", "操作日志", "http://127.0.0.1:5173/logs"],
      ["28-admin-log-detail.png", "日志详情", `http://127.0.0.1:5173/logs/${encodeURIComponent(sessions.logId ?? "")}`],
      ["29-admin-merchant.png", "商家后台", "http://127.0.0.1:5173/merchant"]
    ];

    for (const [fileName, name, url] of adminPages) {
      await navigate(client, url);
      await screenshot(client, fileName);
      const metrics = await pageMetrics(client, name, fileName);
      manifest.admin.push(metrics);

      if (metrics.ratio >= 2.5) {
        const fullFileName = fileName.replace(".png", "-full.png");
        await screenshot(client, fullFileName, true);
        metrics.fullScreenshot = fullFileName;
      }
    }

    const manifestPath = path.join(outDir, "manifest.json");
    fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
    console.log(manifestPath);
    console.log(JSON.stringify({
      mobileScreens: manifest.mobile.length,
      adminScreens: manifest.admin.length,
      longAdminPages: manifest.admin.filter((entry) => entry.ratio >= 2.5).map((entry) => ({
        name: entry.name,
        ratio: entry.ratio,
        screenshot: entry.screenshot,
        fullScreenshot: entry.fullScreenshot
      }))
    }, null, 2));
    client.close();
  } finally {
    chrome.kill();
  }
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
