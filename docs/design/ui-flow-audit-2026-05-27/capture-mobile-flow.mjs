import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const flowDataPath = path.join(root, "docs/design/ui-flow-audit-2026-05-27/flow-data.json");
const outputArg = process.argv[2] || "before";
const outputDir = path.join(root, "docs/design/ui-flow-audit-2026-05-27", outputArg);
const baseUrl = process.env.MOBILE_H5_URL || "http://127.0.0.1:4099";
const port = Number(process.env.CDP_PORT || "12135");

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const jsonEscape = (value) => JSON.stringify(value).replace(/</g, "\\u003c");

class CdpClient {
  constructor(wsUrl) {
    this.ws = new WebSocket(wsUrl);
    this.nextId = 1;
    this.pending = new Map();
    this.events = new Map();
    this.ws.addEventListener("message", (event) => {
      const raw = typeof event.data === "string" ? event.data : Buffer.from(event.data).toString("utf8");
      const message = JSON.parse(raw);
      if (message.id && this.pending.has(message.id)) {
        const { resolve, reject } = this.pending.get(message.id);
        this.pending.delete(message.id);
        if (message.error) {
          reject(new Error(`${message.error.message}: ${message.error.data || ""}`));
        } else {
          resolve(message.result);
        }
        return;
      }

      const handlers = this.events.get(message.method) || [];
      handlers.forEach((handler) => handler(message.params));
    });
  }

  async open() {
    if (this.ws.readyState === WebSocket.OPEN) {
      return;
    }

    await new Promise((resolve, reject) => {
      this.ws.addEventListener("open", resolve, { once: true });
      this.ws.addEventListener("error", reject, { once: true });
    });
  }

  send(method, params = {}) {
    const id = this.nextId++;
    const payload = JSON.stringify({ id, method, params });
    const promise = new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error(`CDP timeout: ${method}`));
        }
      }, 15000);
    });
    this.ws.send(payload);
    return promise;
  }

  on(method, handler) {
    const handlers = this.events.get(method) || [];
    handlers.push(handler);
    this.events.set(method, handlers);
  }

  close() {
    this.ws.close();
  }
}

const waitForChrome = async () => {
  const endpoint = `http://127.0.0.1:${port}/json/version`;
  for (let index = 0; index < 80; index += 1) {
    try {
      const response = await fetch(endpoint);
      if (response.ok) {
        const pageResponse = await fetch(`http://127.0.0.1:${port}/json/new?about:blank`, {
          method: "PUT"
        });
        if (pageResponse.ok) {
          return pageResponse.json();
        }

        const listResponse = await fetch(`http://127.0.0.1:${port}/json/list`);
        const targets = await listResponse.json();
        const page = targets.find((target) => target.type === "page");
        if (page?.webSocketDebuggerUrl) {
          return page;
        }
      }
    } catch {
      // 等待 Chrome 远程调试端口启动。
    }
    await sleep(250);
  }
  throw new Error("Chrome CDP did not start in time.");
};

const waitForRuntime = async (client) => {
  for (let index = 0; index < 40; index += 1) {
    const result = await client.send("Runtime.evaluate", {
      expression: "Boolean(window.uni && window.uni.setStorageSync && document.body)",
      returnByValue: true
    });
    if (result.result.value) {
      return;
    }
    await sleep(250);
  }
};

const waitForText = async (client, pattern, timeout = 8000) => {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeout) {
    const result = await client.send("Runtime.evaluate", {
      expression: "document.body ? document.body.innerText : ''",
      returnByValue: true
    });
    const text = result.result.value || "";
    if (!pattern || text.includes(pattern)) {
      return text;
    }
    await sleep(300);
  }
  return "";
};

const nav = async (client, route, waitText) => {
  const url = `${baseUrl}/?shot=${Date.now()}#/${route}`;
  const load = new Promise((resolve) => {
    const finish = () => resolve();
    client.on("Page.loadEventFired", finish);
    setTimeout(finish, 5000);
  });
  await client.send("Page.navigate", { url });
  await load;
  await waitForRuntime(client).catch(() => undefined);
  await waitForText(client, waitText, waitText ? 10000 : 2500);
  await sleep(1200);
};

const setSession = async (client, session) => {
  await nav(client, "pages/common/app-login", "登录");
  const expression = `
    (() => {
      const session = ${jsonEscape(session)};
      if (window.uni && window.uni.setStorageSync) {
        window.uni.setStorageSync("vm-mobile-session", session);
      }
      return true;
    })()
  `;
  await client.send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
};

const clearSession = async (client) => {
  await nav(client, "pages/common/app-login", "登录");
  const expression = `
    (() => {
      if (window.uni && window.uni.removeStorageSync) {
        window.uni.removeStorageSync("vm-mobile-session");
      }
      if (window.localStorage) {
        window.localStorage.removeItem("vm-mobile-session");
      }
      return true;
    })()
  `;
  await client.send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
};

const capture = async (client, name, route, options = {}) => {
  if (options.clear) {
    await clearSession(client);
  }
  if (options.session) {
    await setSession(client, options.session);
  }

  await nav(client, route, options.waitText);
  const textResult = await client.send("Runtime.evaluate", {
    expression: "document.body ? document.body.innerText.replace(/\\s+/g, ' ').trim().slice(0, 900) : ''",
    returnByValue: true
  });
  const screenshot = await client.send("Page.captureScreenshot", {
    format: "png",
    captureBeyondViewport: false,
    fromSurface: true
  });
  const file = path.join(outputDir, `${name}.png`);
  await fs.writeFile(file, Buffer.from(screenshot.data, "base64"));
  return {
    name,
    route,
    file,
    text: textResult.result.value || ""
  };
};

const normalizeSession = (session) => ({
  token: session.token,
  user: session.user,
  quota: session.quota
});

const main = async () => {
  await fs.mkdir(outputDir, { recursive: true });
  const flowData = JSON.parse(await fs.readFile(flowDataPath, "utf8"));
  const pendingPhone = flowData.pendingPhone || flowData.pendingApp?.phone;
  const deviceCode = flowData.device?.deviceCode || "91120149";
  const sessions = {
    admin: normalizeSession(flowData.sessions.backoffice),
    special: normalizeSession(flowData.sessions.seededSpecial || flowData.sessions.special),
    merchant: normalizeSession(flowData.sessions.seededMerchant || flowData.sessions.merchant)
  };

  const chromePath =
    process.env.CHROME_PATH ||
    "C:/Program Files/Google/Chrome/Application/chrome.exe";
  const userDataDir = path.join(os.tmpdir(), `vm-mobile-cdp-${Date.now()}`);
  const chrome = spawn(chromePath, [
    "--headless=new",
    "--remote-debugging-address=127.0.0.1",
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${userDataDir}`,
    "--disable-gpu",
    "--hide-scrollbars",
    "--no-first-run",
    "--no-default-browser-check",
    "about:blank"
  ], { stdio: "ignore" });

  const version = await waitForChrome();
  const client = new CdpClient(version.webSocketDebuggerUrl);
  await client.open();
  await client.send("Page.enable");
  await client.send("Runtime.enable");
  await client.send("Emulation.setDeviceMetricsOverride", {
    width: 390,
    height: 844,
    deviceScaleFactor: 2,
    mobile: true
  });
  await client.send("Emulation.setUserAgentOverride", {
    userAgent:
      "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1"
  });

  const items = [];
  const resultSuccessRoute =
    "pages/common/result?status=success&title=%E9%A2%86%E5%8F%96%E6%88%90%E5%8A%9F&detail=%E6%9F%9C%E9%97%A8%E5%B7%B2%E5%BC%80%EF%BC%8C%E8%AF%B7%E5%8F%96%E8%B5%B0%E7%89%A9%E5%93%81%E5%90%8E%E5%8F%8A%E6%97%B6%E5%85%B3%E9%97%A8&actionText=%E6%9F%A5%E7%9C%8B%E9%A2%86%E5%8F%96%E8%AE%B0%E5%BD%95";
  const resultWarningRoute =
    "pages/common/result?status=warning&title=%E9%9C%80%E8%A6%81%E7%A1%AE%E8%AE%A4%E6%94%B6%E8%B4%B9&detail=%E4%BB%8A%E6%97%A5%E5%85%8D%E8%B4%B9%E9%A5%AE%E5%93%81%E9%A2%9D%E5%BA%A6%E5%B7%B2%E7%94%A8%E5%AE%8C%EF%BC%8C%E8%B6%85%E5%87%BA%E9%83%A8%E5%88%86%E4%BC%9A%E6%8C%89%E5%95%86%E5%93%81%E4%BB%B7%E6%A0%BC%E7%BB%93%E7%AE%97&actionText=%E7%BB%A7%E7%BB%AD%E6%9F%A5%E7%9C%8B%E6%9F%9C%E6%9C%BA";

  items.push(await capture(client, "00-login", "pages/common/app-login", { clear: true, waitText: "登录" }));
  items.push(await capture(client, "01-register", `pages/common/register?phone=${pendingPhone}`, { clear: true, waitText: "提交申请" }));
  items.push(await capture(client, "02-review-status", `pages/common/review-status?phone=${pendingPhone}`, { clear: true, waitText: "审核" }));
  items.push(await capture(client, "03-special-home", "pages/tabs/primary", { session: sessions.special, waitText: "扫码开柜" }));
  items.push(await capture(client, "04-special-nearby", "pages/tabs/nearby", { session: sessions.special, waitText: "附近" }));
  items.push(await capture(client, "05-special-device-detail", `pages/special/device-detail?deviceCode=${deviceCode}`, { session: sessions.special, waitText: "柜机" }));
  items.push(await capture(client, "06-result-success", resultSuccessRoute, { session: sessions.special, waitText: "领取成功" }));
  items.push(await capture(client, "07-result-warning", resultWarningRoute, { session: sessions.special, waitText: "确认收费" }));
  items.push(await capture(client, "08-special-records", "pages/tabs/records", { session: sessions.special, waitText: "记录" }));
  items.push(await capture(client, "09-merchant-home", "pages/tabs/primary", { session: sessions.merchant, waitText: "补货" }));
  items.push(await capture(client, "10-merchant-restock", `pages/merchant/restock?deviceCode=${deviceCode}`, { session: sessions.merchant, waitText: "补货" }));
  items.push(await capture(client, "11-merchant-records", "pages/tabs/records", { session: sessions.merchant, waitText: "记录" }));
  items.push(await capture(client, "12-admin-home", "pages/tabs/primary", { session: sessions.admin, waitText: "管理员" }));
  items.push(await capture(client, "13-admin-reviews", "pages/admin/reviews", { session: sessions.admin, waitText: "审核" }));
  items.push(await capture(client, "14-admin-devices", "pages/admin/devices", { session: sessions.admin, waitText: "柜机" }));
  items.push(await capture(client, "15-settings", "pages/tabs/settings", { session: sessions.special, waitText: "我的" }));

  await fs.writeFile(path.join(outputDir, "manifest.json"), JSON.stringify({
    capturedAt: new Date().toISOString(),
    baseUrl,
    viewport: { width: 390, height: 844, deviceScaleFactor: 2 },
    items
  }, null, 2));

  client.close();
  chrome.kill();
  await fs.rm(userDataDir, { recursive: true, force: true }).catch(() => undefined);
  console.log(`captured ${items.length} screens to ${outputDir}`);
};

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
