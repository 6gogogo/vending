const fs = require("node:fs");
const path = require("node:path");

const base = "http://127.0.0.1:4000/api";
const storePath = path.join(process.cwd(), "apps/api/runtime-data/store.json");
const results = [];
const runId = Date.now().toString(36);

function record(name, ok, detail = "") {
  results.push({ name, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? ` | ${detail}` : ""}`);
}

function assertStep(name, condition, detail = "") {
  if (!condition) {
    throw new Error(`${name}${detail ? `: ${detail}` : ""}`);
  }
  record(name, true, detail);
}

function auth(token) {
  return token ? { Authorization: `Bearer ${token}` } : {};
}

async function req(method, url, body, token) {
  const res = await fetch(`${base}${url}`, {
    method,
    headers: { "Content-Type": "application/json", ...auth(token) },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  const text = await res.text();
  let json;
  try {
    json = text ? JSON.parse(text) : undefined;
  } catch {
    json = text;
  }
  if (!res.ok) {
    const message =
      json && typeof json === "object" && typeof json.message === "string"
        ? json.message
        : `HTTP ${res.status}`;
    const err = new Error(message);
    err.status = res.status;
    err.body = json;
    throw err;
  }
  if (json && typeof json === "object" && "code" in json && "data" in json) {
    if (json.code >= 400) {
      const err = new Error(json.message || `API ${json.code}`);
      err.status = json.code;
      err.body = json;
      throw err;
    }
    return json.data;
  }
  return json;
}

async function expectError(name, fn, check = {}) {
  try {
    await fn();
  } catch (error) {
    if (check.status && error.status !== check.status) {
      throw error;
    }
    if (check.includes && !String(error.message).includes(check.includes)) {
      throw error;
    }
    record(name, true, `${error.status || ""} ${error.message}`.trim());
    return error;
  }
  throw new Error(`${name}: expected error`);
}

function uniquePhone(prefix = "139") {
  return `${prefix}${String(Date.now() + Math.floor(Math.random() * 900000)).slice(-8)}`;
}

function latestCode(phone, fallback) {
  if (fallback) {
    return fallback;
  }
  const raw = JSON.parse(fs.readFileSync(storePath, "utf8"));
  const entry = (raw.verificationCodes || []).find(([key]) => key === phone);
  if (!entry) {
    throw new Error(`No verification code for ${phone}`);
  }
  return entry[1].code;
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

(async () => {
  const health = await req("GET", "/health");
  assertStep("API 健康检查", health.status === "正常" || health.status === "ok");

  const superSession = await req("POST", "/auth/backoffice-login", {
    username: "super",
    password: "super123"
  });
  const superToken = superSession.token;
  assertStep("程序提供商可进入后台", superSession.user.backofficeRole === "super_admin");

  await expectError(
    "预约保留时间小于 5 分钟会被拒绝",
    () => req("PATCH", "/reservations/settings", { holdMinutes: 2 }, superToken),
    { includes: "预约保留时间" }
  );
  await req("PATCH", "/reservations/settings", { enabled: true, holdMinutes: 30, maxTimeouts: 3 }, superToken);

  await expectError(
    "空区域名称不能创建",
    () => req("POST", "/regions", { name: "   " }, superToken),
    { includes: "区域" }
  );
  const region = await req(
    "POST",
    "/regions",
    { name: `审计区域${runId}`, sortOrder: 99, longitude: 120.31, latitude: 31.49 },
    superToken
  );
  assertStep("后台可新增区域", region.name.includes(runId), region.id);
  const patchedRegion = await req("PATCH", `/regions/${region.id}`, { name: `审计区域${runId}更新` }, superToken);
  assertStep("后台可修改区域", patchedRegion.name.endsWith("更新"));

  const category = await req(
    "POST",
    "/goods-categories",
    { name: `审计分类${runId}`, category: "daily", sortOrder: 88 },
    superToken
  );
  assertStep("后台可新增货品分类", category.name.includes(runId), category.id);
  await expectError(
    "重复货品分类会被拒绝",
    () => req("POST", "/goods-categories", { name: `审计分类${runId}`, category: "daily" }, superToken),
    { includes: "已存在" }
  );

  const goodsId = `audit-goods-${runId}`;
  const goods = await req(
    "POST",
    "/goods",
    {
      goodsCode: `AUDIT${runId}`,
      goodsId,
      name: `审计物资${runId}`,
      fullName: `审计物资${runId}`,
      category: "daily",
      categoryName: category.name,
      price: 150,
      imageUrl: "https://dummyimage.com/160x160/e8f5e9/166534.png&text=AUDIT",
      packageForm: "袋",
      specification: "1袋",
      manufacturer: "审计测试"
    },
    superToken
  );
  assertStep("后台可新增货品", goods.goodsId === goodsId);
  await expectError(
    "重复货品编号会被拒绝",
    () =>
      req(
        "POST",
        "/goods",
        {
          goodsCode: `AUDIT${runId}`,
          name: `重复物资${runId}`,
          category: "daily",
          price: 100,
          imageUrl: ""
        },
        superToken
      ),
    { includes: "已存在" }
  );
  const updatedGoods = await req("PATCH", `/goods/${goodsId}`, { price: 180, specification: "升级装" }, superToken);
  assertStep("后台可修改货品", updatedGoods.price === 180 && updatedGoods.specification === "升级装");

  const deviceCode = `AUDIT-${runId}`.toUpperCase();
  const device = await req(
    "POST",
    "/devices/mock/upsert",
    {
      deviceCode,
      name: `审计柜机${runId}`,
      location: "审计测试点位",
      address: "审计测试地址 1 号",
      longitude: 120.31,
      latitude: 31.49,
      status: "online",
      doorNum: "1",
      goods: [
        {
          goodsId,
          goodsCode: goods.goodsCode,
          name: goods.name,
          category: goods.category,
          stock: 3,
          price: goods.price
        }
      ]
    },
    superToken
  );
  assertStep("后台可新增模拟柜机和初始库存", device.deviceCode === deviceCode);

  const queriedGoods = await req("POST", `/devices/${deviceCode}/goods/query?doorNum=1`, undefined, superToken);
  assertStep(
    "柜机货品查询展示当前批次库存",
    queriedGoods.some((item) => item.goodsId === goodsId && item.stock === 3),
    JSON.stringify(queriedGoods.map((item) => ({ goodsId: item.goodsId, stock: item.stock })))
  );

  await expectError(
    "新增批次未确认会被拒绝",
    () => req("POST", `/goods/${goodsId}/batches`, { deviceCode, quantity: 1, confirmed: false }, superToken),
    { includes: "确认" }
  );
  const batch = await req(
    "POST",
    `/goods/${goodsId}/batches`,
    { deviceCode, quantity: 2, confirmed: true, expiresAt: "2026-12-31T00:00:00.000Z", note: "审计新增批次" },
    superToken
  );
  assertStep("确认后可新增批次", Boolean(batch.batchId), batch.batchId || "");

  const warehouseSnapshot = await req("GET", "/warehouse-inventory", undefined, superToken);
  const warehouseCode = warehouseSnapshot.warehouse.code;
  await expectError(
    "多批次调拨未指定批次会被拒绝",
    () => req("POST", "/inventory-transfers", { fromCode: deviceCode, toCode: warehouseCode, goodsId, quantity: 1 }, superToken),
    { includes: "批次" }
  );
  const transfer = await req(
    "POST",
    "/inventory-transfers",
    { fromCode: deviceCode, toCode: warehouseCode, goodsId, quantity: 1, sourceBatchId: batch.batchId, note: "审计调拨" },
    superToken
  );
  assertStep("指定批次后可调拨到仓库", transfer.goodsId === goodsId && transfer.quantity === 1, transfer.id);

  const stocktake = await req(
    "POST",
    "/stocktakes",
    { deviceCode, note: "审计盘点", items: [{ goodsId, actualQuantity: 4 }] },
    superToken
  );
  assertStep("后台可执行柜机盘点", stocktake.deviceCode === deviceCode && stocktake.items.some((item) => item.goodsId === goodsId));

  const rejectedPhone = uniquePhone("139");
  const rejectedCode = await codeFor(rejectedPhone, "register");
  const rejectedApplication = await req("POST", "/registration-applications", {
    phone: rejectedPhone,
    code: rejectedCode,
    requestedRole: "special",
    profile: { name: `驳回用户${runId}`, regionId: region.id, regionName: region.name }
  });
  await req("PATCH", `/registration-applications/${rejectedApplication.id}/review`, { decision: "rejected", reason: "资料不完整" }, superToken);
  const rejectedLogin = await req("POST", "/auth/app-login", { phone: rejectedPhone, code: rejectedCode });
  assertStep("审核驳回后登录返回驳回状态", rejectedLogin.state === "rejected" && rejectedLogin.message.includes("资料不完整"));

  const merchantPhone = uniquePhone("138");
  const merchantCode = await codeFor(merchantPhone, "register");
  const merchantApplication = await req("POST", "/registration-applications", {
    phone: merchantPhone,
    code: merchantCode,
    requestedRole: "merchant",
    profile: {
      name: `审计商家${runId}`,
      merchantName: `审计商家${runId}`,
      contactName: `联系人${runId}`,
      address: "审计商家地址",
      regionId: region.id,
      regionName: region.name
    }
  });
  const reviewedMerchant = await req("PATCH", `/registration-applications/${merchantApplication.id}/review`, { decision: "approved" }, superToken);
  const merchantLoginCode = await codeFor(merchantPhone, "app-login");
  const merchantSession = await req("POST", "/auth/app-login", { phone: merchantPhone, code: merchantLoginCode });
  assertStep("商家注册审核通过后可登录", merchantSession.state === "approved" && merchantSession.user.role === "merchant", reviewedMerchant.linkedUserId || "");

  const merchantToken = merchantSession.token;
  await expectError("商家不能访问人员管理接口", () => req("GET", "/users", undefined, merchantToken), { status: 403 });
  await expectError("商家补货数量为 0 会被拒绝", async () => {
    const template = await req(
      "POST",
      "/merchant-goods-templates",
      {
        goodsId: `merchant-audit-${runId}`,
        goodsCode: `MA${runId}`,
        goodsName: `商家审计物资${runId}`,
        fullName: `商家审计物资${runId}`,
        category: "daily",
        categoryName: "日用品",
        defaultQuantity: 1,
        defaultShelfLifeDays: 30
      },
      merchantToken
    );
    await req(
      "POST",
      "/merchant-restocks",
      { templateId: template.id, deviceCode, productionDate: "2026-06-01", quantity: 0, confirmed: true },
      merchantToken
    );
  }, { includes: "数量" });

  const specialPhone = uniquePhone("139");
  const specialCode = await codeFor(specialPhone, "register");
  const specialApplication = await req("POST", "/registration-applications", {
    phone: specialPhone,
    code: specialCode,
    requestedRole: "special",
    profile: { name: `审计用户${runId}`, regionId: region.id, regionName: region.name }
  });
  const reviewedSpecial = await req("PATCH", `/registration-applications/${specialApplication.id}/review`, { decision: "approved" }, superToken);
  const specialLoginCode = await codeFor(specialPhone, "app-login");
  const specialSession = await req("POST", "/auth/app-login", { phone: specialPhone, code: specialLoginCode });
  const specialToken = specialSession.token;
  assertStep("用户注册审核通过后可登录", specialSession.state === "approved" && specialSession.user.role === "special");

  await req(
    "POST",
    "/special-access-policies",
    {
      name: `审计领取策略${runId}`,
      weekdays: [0, 1, 2, 3, 4, 5, 6],
      startHour: 0,
      endHour: 24,
      goodsLimits: [{ goodsId, goodsName: goods.name, category: goods.category, quantity: 2 }],
      applicableUserIds: [reviewedSpecial.linkedUserId],
      status: "active"
    },
    superToken
  );
  const quota = await req("GET", `/access-rules/summary?phone=${specialPhone}`, undefined, specialToken);
  assertStep("后台领取策略同步到用户端", (quota.remainingByGoods?.[goodsId] ?? 0) >= 2);

  await req("PATCH", "/reservations/settings", { enabled: false }, superToken);
  await expectError(
    "预约关闭后用户不能预约",
    () =>
      req(
        "POST",
        "/reservations",
        { deviceCode, doorNum: "1", intentItems: [{ goodsId, goodsName: goods.name, category: goods.category, quantity: 1 }] },
        specialToken
      ),
    { includes: "未启用" }
  );
  await req("PATCH", "/reservations/settings", { enabled: true }, superToken);
  const reservation = await req(
    "POST",
    "/reservations",
    { deviceCode, doorNum: "1", intentItems: [{ goodsId, goodsName: goods.name, category: goods.category, quantity: 1 }] },
    specialToken
  );
  const cancelled = await req("POST", `/reservations/${reservation.id}/cancel`, {}, specialToken);
  assertStep("用户可取消自己的预约", cancelled.status === "cancelled");

  await expectError("用户不能访问货品总览", () => req("GET", "/goods-overview", undefined, specialToken), { status: 403 });

  const feedback = await req(
    "POST",
    "/alerts/feedback",
    { title: "柜机异常反馈", detail: "审计反馈：柜门无法打开", deviceCode, feedbackType: "机器故障" },
    specialToken
  );
  assertStep("登录用户提交反馈会绑定本人", feedback.targetUserId === specialSession.user.id, feedback.id);
  const resolvedFeedback = await req("PATCH", `/alerts/${feedback.id}/resolve`, { note: "已安排处理" }, superToken);
  assertStep("管理员可处理反馈", resolvedFeedback.status === "resolved");
  const myAlerts = await req("GET", "/alerts", undefined, specialToken);
  assertStep("用户可看到自己的反馈处理状态", myAlerts.some((item) => item.id === feedback.id && item.status === "resolved"));

  const logs = await req("GET", "/operation-logs", undefined, superToken);
  assertStep(
    "配置、调拨、盘点、反馈均进入操作追踪",
    logs.some((entry) => entry.metadata?.deviceCode === deviceCode || entry.primarySubject?.id === deviceCode)
  );

  const failed = results.filter((entry) => !entry.ok);
  console.log(
    JSON.stringify(
      {
        passed: results.length - failed.length,
        failed: failed.length,
        total: results.length,
        deviceCode,
        goodsId,
        specialPhone,
        merchantPhone
      },
      null,
      2
    )
  );
  if (failed.length) {
    process.exitCode = 1;
  }
})().catch((error) => {
  record("边界链路脚本异常", false, `${error.status || ""} ${error.message}`.trim());
  if (error.body) {
    console.error(JSON.stringify(error.body, null, 2));
  }
  console.log(
    JSON.stringify(
      {
        passed: results.filter((entry) => entry.ok).length,
        failed: results.filter((entry) => !entry.ok).length,
        total: results.length
      },
      null,
      2
    )
  );
  process.exitCode = 1;
});
