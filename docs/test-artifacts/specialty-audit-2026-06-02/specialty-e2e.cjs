const fs = require("node:fs");
const path = require("node:path");

const base = "http://127.0.0.1:4000/api";
const storePath = path.join(process.cwd(), "apps/api/runtime-data/store.json");
const results = [];
const runId = Date.now().toString(36);
const state = {};

function record(name, ok, detail = "") {
  results.push({ name, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? ` | ${detail}` : ""}`);
}

function auth(token) {
  return token ? { Authorization: `Bearer ${token}` } : {};
}

async function req(method, url, body, token, options = {}) {
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
    err.text = text;
    throw err;
  }

  if (options.raw) {
    return { status: res.status, body: text, headers: res.headers };
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

function readStore() {
  return JSON.parse(fs.readFileSync(storePath, "utf8"));
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

function uniquePhone(prefix = "139") {
  return `${prefix}${String(Date.now() + Math.floor(Math.random() * 900000)).slice(-8)}`;
}

async function step(name, fn) {
  try {
    const detail = await fn();
    record(name, true, typeof detail === "string" ? detail : "");
    return detail;
  } catch (error) {
    record(name, false, `${error.status || ""} ${error.message}`.trim());
    return undefined;
  }
}

async function expectError(name, fn, check = {}) {
  return step(name, async () => {
    try {
      await fn();
    } catch (error) {
      if (check.status && error.status !== check.status) {
        throw new Error(`期望状态 ${check.status}，实际 ${error.status || "unknown"}：${error.message}`);
      }
      if (check.includes && !String(error.message).includes(check.includes)) {
        throw new Error(`期望错误包含「${check.includes}」，实际：${error.message}`);
      }
      if (check.notIncludes && String(error.message).includes(check.notIncludes)) {
        throw new Error(`错误不应包含「${check.notIncludes}」，实际：${error.message}`);
      }
      return `${error.status || ""} ${error.message}`.trim();
    }
    throw new Error("期望接口拒绝，但实际成功");
  });
}

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

function hasNoProviderPermissions(permissions) {
  return !permissions.includes("platform-overview:view") && !permissions.includes("platform-tenants:view");
}

(async () => {
  await step("API 健康检查", async () => {
    const health = await req("GET", "/health");
    assert(health.status === "正常" || health.status === "ok", "健康检查状态异常");
  });

  await step("公开配置可读取且不泄漏后台默认密码", async () => {
    const config = await req("GET", "/public-config");
    const serialized = JSON.stringify(config);
    assert(!serialized.includes("super123"), "公开配置泄漏默认密码");
  });

  await expectError(
    "错误后台密码不能登录",
    () => req("POST", "/auth/backoffice-login", { username: "super", password: "wrong-password" }),
    { status: 401, includes: "账号或密码" }
  );

  await step("程序提供商登录后台", async () => {
    const session = await req("POST", "/auth/backoffice-login", { username: "super", password: "super123" });
    state.superToken = session.token;
    state.superUser = session.user;
    assert(session.user.backofficeRole === "super_admin", "不是服务商身份");
  });

  await step("服务商可查看全局概览和实例列表", async () => {
    const overview = await req("GET", "/platform/overview", undefined, state.superToken);
    const tenants = await req("GET", "/platform/tenants", undefined, state.superToken);
    assert(Array.isArray(tenants), "实例列表不是数组");
    assert(overview.totals && typeof overview.totals.tenants === "number", "全局概览结构异常");
  });

  await step("未注册手机号请求登录验证码不暴露注册状态", async () => {
    const response = await req("POST", "/auth/request-code", {
      phone: uniquePhone("136"),
      scene: "app-login"
    });
    const serialized = JSON.stringify(response);
    assert(response.provider === "mock", "隔离环境未使用 mock 验证码");
    assert(!/registered|application|pending|rejected/i.test(serialized), "验证码接口泄漏了注册状态");
  });

  state.regionName = `专项区域${runId}`;
  await expectError(
    "区域名称为空会被拒绝",
    () => req("POST", "/regions", { name: "   ", longitude: 120.3, latitude: 31.4 }, state.superToken),
    { status: 400, includes: "区域名称" }
  );
  await expectError(
    "区域经纬度非数字会被拒绝",
    () => req("POST", "/regions", { name: `非法区域${runId}`, longitude: "abc", latitude: 31.4 }, state.superToken),
    { status: 400, includes: "经度" }
  );
  await step("后台可创建专项区域", async () => {
    state.region = await req(
      "POST",
      "/regions",
      { name: state.regionName, longitude: 120.31, latitude: 31.49, sortOrder: 120 },
      state.superToken
    );
    assert(state.region.name === state.regionName, "区域名称未保存");
    return state.region.id;
  });

  await expectError(
    "注册资料姓名为空会被拒绝",
    async () => {
      const phone = uniquePhone("139");
      const code = await codeFor(phone, "register");
      await req("POST", "/registration-applications", {
        phone,
        code,
        requestedRole: "special",
        profile: { name: "   ", regionId: state.region.id, regionName: state.regionName }
      });
    },
    { status: 400, includes: "姓名" }
  );
  await expectError(
    "注册资料必须选择已配置区域",
    async () => {
      const phone = uniquePhone("139");
      const code = await codeFor(phone, "register");
      await req("POST", "/registration-applications", {
        phone,
        code,
        requestedRole: "special",
        profile: { name: `缺区域${runId}`, regionName: "不存在区域" }
      });
    },
    { status: 400, includes: "区域" }
  );
  await expectError(
    "公开注册不能申请管理员",
    async () => {
      const phone = uniquePhone("137");
      const code = await codeFor(phone, "register");
      await req("POST", "/registration-applications", {
        phone,
        code,
        requestedRole: "admin",
        profile: { name: `管理员申请${runId}`, regionId: state.region.id, regionName: state.regionName }
      });
    },
    { status: 400, includes: "管理员账号" }
  );

  await step("创建并审核专项用户", async () => {
    state.specialPhone = uniquePhone("139");
    const code = await codeFor(state.specialPhone, "register");
    const application = await req("POST", "/registration-applications", {
      phone: state.specialPhone,
      code,
      requestedRole: "special",
      profile: { name: `专项用户${runId}`, regionId: state.region.id, regionName: state.regionName }
    });
    const reviewed = await req("PATCH", `/registration-applications/${application.id}/review`, { decision: "approved" }, state.superToken);
    state.specialUserId = reviewed.linkedUserId;
    const loginCode = await codeFor(state.specialPhone, "app-login");
    state.specialSession = await req("POST", "/auth/app-login", { phone: state.specialPhone, code: loginCode });
    state.specialToken = state.specialSession.token;
    assert(state.specialSession.state === "approved", "用户未通过登录");
    return state.specialUserId;
  });

  await step("创建并审核第二个专项用户", async () => {
    state.otherSpecialPhone = uniquePhone("139");
    const code = await codeFor(state.otherSpecialPhone, "register");
    const application = await req("POST", "/registration-applications", {
      phone: state.otherSpecialPhone,
      code,
      requestedRole: "special",
      profile: { name: `专项用户B${runId}`, regionId: state.region.id, regionName: state.regionName }
    });
    const reviewed = await req("PATCH", `/registration-applications/${application.id}/review`, { decision: "approved" }, state.superToken);
    state.otherSpecialUserId = reviewed.linkedUserId;
    const loginCode = await codeFor(state.otherSpecialPhone, "app-login");
    state.otherSpecialSession = await req("POST", "/auth/app-login", { phone: state.otherSpecialPhone, code: loginCode });
    state.otherSpecialToken = state.otherSpecialSession.token;
  });

  await step("创建并审核两个商家", async () => {
    for (const key of ["merchantA", "merchantB"]) {
      const phone = uniquePhone("138");
      const code = await codeFor(phone, "register");
      const application = await req("POST", "/registration-applications", {
        phone,
        code,
        requestedRole: "merchant",
        profile: {
          name: `${key}联系人${runId}`,
          merchantName: `${key}商家${runId}`,
          regionId: state.region.id,
          regionName: state.regionName,
          contactName: `${key}联系人${runId}`,
          address: "专项测试地址"
        }
      });
      const reviewed = await req("PATCH", `/registration-applications/${application.id}/review`, { decision: "approved" }, state.superToken);
      const loginCode = await codeFor(phone, "app-login");
      const session = await req("POST", "/auth/app-login", { phone, code: loginCode });
      state[key] = { phone, userId: reviewed.linkedUserId, token: session.token, session };
    }
  });

  await expectError(
    "货品分类名称为空会被拒绝",
    () => req("POST", "/goods-categories", { name: "   ", category: "daily" }, state.superToken),
    { status: 400, includes: "分类名称" }
  );
  await step("创建专项货品分类", async () => {
    state.category = await req(
      "POST",
      "/goods-categories",
      { name: `专项分类${runId}`, category: "daily", sortOrder: 130 },
      state.superToken
    );
  });
  await expectError(
    "货品编号为空会被拒绝",
    () => req("POST", "/goods", { goodsCode: "   ", name: `空编号${runId}`, category: "daily", price: 100, imageUrl: "" }, state.superToken),
    { status: 400, includes: "货品编号" }
  );
  await expectError(
    "货品名称为空会被拒绝",
    () => req("POST", "/goods", { goodsCode: `EMPTYNAME${runId}`, name: "   ", category: "daily", price: 100, imageUrl: "" }, state.superToken),
    { status: 400, includes: "货品名称" }
  );
  await expectError(
    "货品价格不能为负数",
    () => req("POST", "/goods", { goodsCode: `NEG${runId}`, name: `负价${runId}`, category: "daily", price: -1, imageUrl: "" }, state.superToken),
    { status: 400, includes: "价格" }
  );
  await step("创建专项货品", async () => {
    state.goodsId = `specialty-goods-${runId}`;
    state.goods = await req("POST", "/goods", {
      goodsCode: `SP${runId}`,
      goodsId: state.goodsId,
      name: `专项物资${runId}`,
      fullName: `专项物资${runId}`,
      category: "daily",
      categoryName: state.category.name,
      price: 250,
      imageUrl: "https://dummyimage.com/160x160/e8f5e9/166534.png&text=SP",
      packageForm: "份",
      specification: "1份",
      manufacturer: "专项测试"
    }, state.superToken);
  });

  await expectError(
    "柜机编号为空会被拒绝",
    () => req("POST", "/devices", { deviceCode: "   ", name: `空编号柜${runId}`, location: "测试点" }, state.superToken),
    { status: 400, includes: "柜机编号" }
  );
  await step("创建专项柜机", async () => {
    state.deviceCode = `SPEC-${runId}`.toUpperCase();
    state.device = await req("POST", "/devices/mock/upsert", {
      deviceCode: state.deviceCode,
      name: `专项柜机${runId}`,
      location: "专项测试点位",
      address: "专项测试地址 1 号",
      longitude: 120.31,
      latitude: 31.49,
      status: "online",
      doorNum: "1",
      goods: [
        {
          goodsId: state.goodsId,
          goodsCode: state.goods.goodsCode,
          name: state.goods.name,
          category: state.goods.category,
          stock: 5,
          price: state.goods.price
        }
      ]
    }, state.superToken);
  });
  await expectError(
    "柜机货品低库存阈值不能为负数",
    () => req("PATCH", `/devices/${state.deviceCode}/goods/${state.goodsId}/threshold`, { enabled: true, lowStockThreshold: -1 }, state.superToken),
    { status: 400, includes: "阈值" }
  );
  await step("柜机货品阈值可正常保存", async () => {
    const setting = await req("PATCH", `/devices/${state.deviceCode}/goods/${state.goodsId}/threshold`, { enabled: true, lowStockThreshold: 2 }, state.superToken);
    assert(setting.lowStockThreshold === 2, "阈值未保存");
  });

  await expectError(
    "全局领取规则每日额度不能为负数",
    () => req("PATCH", "/access-rules?role=special", { dailyLimit: -1 }, state.superToken),
    { status: 400, includes: "每日" }
  );
  await expectError(
    "全局领取规则品类额度不能为负数",
    () => req("PATCH", "/access-rules?role=special", { categoryLimit: { daily: -1 } }, state.superToken),
    { status: 400, includes: "额度" }
  );
  await expectError(
    "领取策略结束时间必须晚于开始时间",
    () => req("POST", "/special-access-policies", {
      name: `非法策略${runId}`,
      weekdays: [1],
      startHour: 12,
      endHour: 12,
      goodsLimits: [{ goodsId: state.goodsId, goodsName: state.goods.name, category: "daily", quantity: 1 }],
      applicableUserIds: [state.specialUserId],
      status: "active"
    }, state.superToken),
    { status: 400, includes: "结束时间" }
  );
  await expectError(
    "领取策略必须至少包含一种物资",
    () => req("POST", "/special-access-policies", {
      name: `空策略${runId}`,
      weekdays: [1],
      startHour: 0,
      endHour: 24,
      goodsLimits: [],
      applicableUserIds: [state.specialUserId],
      status: "active"
    }, state.superToken),
    { status: 400, includes: "物资" }
  );
  await step("创建并批量下发专项领取策略", async () => {
    state.policy = await req("POST", "/special-access-policies", {
      name: `专项领取策略${runId}`,
      weekdays: [0, 1, 2, 3, 4, 5, 6],
      startHour: 0,
      endHour: 24,
      goodsLimits: [{ goodsId: state.goodsId, goodsName: state.goods.name, category: "daily", quantity: 3 }],
      applicableUserIds: [],
      status: "active"
    }, state.superToken);
    const policies = await req("POST", "/special-access-policies/batch-assign", {
      userIds: [state.specialUserId],
      policyIds: [state.policy.id],
      mode: "replace"
    }, state.superToken);
    assert(policies.some((item) => item.id === state.policy.id && item.applicableUserIds.includes(state.specialUserId)), "策略未绑定用户");
  });

  await expectError(
    "个人领取策略不能设置不存在货品",
    () => req("POST", `/users/${state.specialUserId}/access-policies`, {
      name: `不存在货品${runId}`,
      weekdays: [1],
      startHour: 0,
      endHour: 24,
      goodsLimits: [{ goodsId: "missing-goods", quantity: 1 }],
      status: "active"
    }, state.superToken),
    { status: 404, includes: "未找到货品" }
  );

  await expectError(
    "补货批次数量不能为 0",
    () => req("POST", `/goods/${state.goodsId}/batches`, { deviceCode: state.deviceCode, quantity: 0, confirmed: true }, state.superToken),
    { status: 400, includes: "数量" }
  );
  await step("新增专项库存批次", async () => {
    state.batch = await req("POST", `/goods/${state.goodsId}/batches`, {
      deviceCode: state.deviceCode,
      quantity: 4,
      confirmed: true,
      expiresAt: "2026-12-31T00:00:00.000Z",
      note: "专项压测新增批次"
    }, state.superToken);
    assert(state.batch.batchId, "批次未生成");
  });
  await expectError(
    "去除批次数量超出剩余库存会被拒绝",
    () => req("POST", `/goods/batches/${state.batch.batchId}/remove`, { quantity: 9999, confirmed: true }, state.superToken),
    { status: 400, includes: "库存" }
  );
  await step("去除部分批次库存", async () => {
    const removed = await req("POST", `/goods/batches/${state.batch.batchId}/remove`, { quantity: 1, confirmed: true, note: "专项去除" }, state.superToken);
    assert(removed.removedQuantity === 1, "去除数量异常");
  });

  await expectError(
    "调拨来源和去向相同会被拒绝",
    () => req("POST", "/inventory-transfers", { fromCode: state.deviceCode, toCode: state.deviceCode, goodsId: state.goodsId, quantity: 1 }, state.superToken),
    { status: 400, includes: "不能相同" }
  );
  await expectError(
    "盘点实盘数不能为负数",
    () => req("POST", "/stocktakes", { deviceCode: state.deviceCode, items: [{ goodsId: state.goodsId, actualQuantity: -1 }] }, state.superToken),
    { status: 400, includes: "实盘" }
  );
  await step("专项柜机盘点可保存并导出", async () => {
    state.stocktake = await req("POST", "/stocktakes", {
      deviceCode: state.deviceCode,
      note: "专项盘点",
      items: [{ goodsId: state.goodsId, actualQuantity: 5 }]
    }, state.superToken);
    const exported = await req("GET", `/stocktakes/${state.stocktake.id}/export`, undefined, state.superToken, { raw: true });
    assert(exported.body.includes(state.deviceCode), "盘点导出未包含柜机");
  });

  await expectError(
    "预约设置超时阈值过小会被拒绝",
    () => req("PATCH", "/reservations/settings", { maxTimeouts: 0 }, state.superToken),
    { status: 400, includes: "阈值" }
  );
  await step("预约设置开启", async () => {
    const settings = await req("PATCH", "/reservations/settings", { enabled: true, holdMinutes: 30, maxTimeouts: 2 }, state.superToken);
    assert(settings.enabled === true && settings.maxTimeouts === 2, "预约设置未保存");
  });
  await expectError(
    "预约数量不能为 0",
    () => req("POST", "/reservations", {
      deviceCode: state.deviceCode,
      doorNum: "1",
      intentItems: [{ goodsId: state.goodsId, goodsName: state.goods.name, category: "daily", quantity: 0 }]
    }, state.specialToken),
    { status: 400, includes: "数量" }
  );
  await step("用户可预约专项货品", async () => {
    state.reservation = await req("POST", "/reservations", {
      deviceCode: state.deviceCode,
      doorNum: "1",
      intentItems: [{ goodsId: state.goodsId, goodsName: state.goods.name, category: "daily", quantity: 1 }]
    }, state.specialToken);
    assert(state.reservation.status === "active", "预约未激活");
  });
  await expectError(
    "其他用户不能取消别人的预约",
    () => req("POST", `/reservations/${state.reservation.id}/cancel`, undefined, state.otherSpecialToken),
    { status: 403, includes: "其他用户" }
  );
  await step("本人可取消预约", async () => {
    const cancelled = await req("POST", `/reservations/${state.reservation.id}/cancel`, undefined, state.specialToken);
    assert(cancelled.status === "cancelled", "预约未取消");
  });

  await expectError(
    "用户不能替其他手机号开柜",
    () => req("POST", "/cabinet-events/open/pre-settlement", {
      phone: state.otherSpecialPhone,
      deviceCode: state.deviceCode,
      doorNum: "1",
      intentItems: [{ goodsId: state.goodsId, goodsName: state.goods.name, category: "daily", quantity: 1 }]
    }, state.specialToken),
    { status: 403, includes: "其他手机号" }
  );
  await step("用户开柜预结算在额度内", async () => {
    const preview = await req("POST", "/cabinet-events/open/pre-settlement", {
      phone: state.specialPhone,
      deviceCode: state.deviceCode,
      doorNum: "1",
      intentItems: [{ goodsId: state.goodsId, goodsName: state.goods.name, category: "daily", quantity: 1 }]
    }, state.specialToken);
    assert(preview.preSettlement.payableAmount === 0, "额度内应为免费");
  });

  await expectError(
    "商家不能访问人员管理",
    () => req("GET", "/users", undefined, state.merchantA.token),
    { status: 403, includes: "无权" }
  );
  await expectError(
    "用户不能访问后台货品总览",
    () => req("GET", "/goods-overview", undefined, state.specialToken),
    { status: 403, includes: "无权" }
  );
  await expectError(
    "用户不能提交商家补货",
    () => req("POST", "/merchant-restocks", {
      templateId: "missing",
      deviceCode: state.deviceCode,
      quantity: 1,
      productionDate: "2026-06-01",
      confirmed: true
    }, state.specialToken),
    { status: 403, includes: "无权" }
  );

  await expectError(
    "商家模板默认数量不能为 0",
    () => req("POST", "/merchant-goods-templates", {
      goodsName: `非法模板${runId}`,
      category: "daily",
      defaultQuantity: 0,
      defaultShelfLifeDays: 2
    }, state.merchantA.token),
    { status: 400, includes: "默认数量" }
  );
  await expectError(
    "商家模板保质期天数不能为 0",
    () => req("POST", "/merchant-goods-templates", {
      goodsName: `非法保质期${runId}`,
      category: "daily",
      defaultQuantity: 1,
      defaultShelfLifeDays: 0
    }, state.merchantA.token),
    { status: 400, includes: "保质期" }
  );
  await step("商家 A 可新增自己的常用商品模板", async () => {
    state.templateA = await req("POST", "/merchant-goods-templates", {
      goodsCode: `MTA${runId}`,
      goodsName: `商家A物资${runId}`,
      category: "daily",
      categoryName: state.category.name,
      defaultQuantity: 2,
      defaultShelfLifeDays: 5,
      specification: "1份"
    }, state.merchantA.token);
    assert(state.templateA.ownerUserId === state.merchantA.userId, "模板归属异常");
  });
  await expectError(
    "商家 B 不能修改商家 A 的常用商品模板",
    () => req("PATCH", `/merchant-goods-templates/${state.templateA.id}`, { goodsName: `越权修改${runId}` }, state.merchantB.token),
    { status: 403, includes: "不能修改" }
  );
  await step("商家 A 补货事件完成关门确认", async () => {
    state.merchantRestockEvent = await req("POST", "/cabinet-events/open", {
      phone: state.merchantA.phone,
      deviceCode: state.deviceCode,
      doorNum: "1",
      hasInboundGoods: true
    }, state.merchantA.token);
    await req("POST", "/cabinet-events/callbacks/door-status", {
      eventId: state.merchantRestockEvent.eventId,
      deviceCode: state.deviceCode,
      status: "SUCCESS",
      doorIsOpen: "Y"
    });
    await req("POST", "/cabinet-events/callbacks/door-status", {
      eventId: state.merchantRestockEvent.eventId,
      deviceCode: state.deviceCode,
      status: "CLOSED",
      doorIsOpen: "N"
    });
  });
  await expectError(
    "商家补货生产日期格式错误会被拒绝",
    () => req("POST", "/merchant-restocks", {
      templateId: state.templateA.id,
      deviceCode: state.deviceCode,
      cabinetEventId: state.merchantRestockEvent.eventId,
      quantity: 1,
      productionDate: "not-a-date",
      confirmed: true
    }, state.merchantA.token),
    { status: 400, includes: "生产日期" }
  );
  await step("商家 A 可补货并只在自己追踪中看到", async () => {
    await req("POST", "/merchant-restocks", {
      templateId: state.templateA.id,
      deviceCode: state.deviceCode,
      cabinetEventId: state.merchantRestockEvent.eventId,
      quantity: 1,
      productionDate: "2026-06-01",
      confirmed: true,
      note: "专项商家补货"
    }, state.merchantA.token);
    const traceA = await req("GET", "/merchant-restock-traces", undefined, state.merchantA.token);
    const traceB = await req("GET", "/merchant-restock-traces", undefined, state.merchantB.token);
    assert(traceA.batches.some((entry) => entry.sourceUserId === state.merchantA.userId), "商家A看不到自己的补货批次");
    assert(!traceB.batches.some((entry) => entry.sourceUserId === state.merchantA.userId), "商家B看到了商家A补货批次");
  });

  await step("创建受限管理员并校验权限下发边界", async () => {
    state.limitedAdmin = await req("POST", "/users", {
      role: "admin",
      phone: uniquePhone("135"),
      name: `受限管理员${runId}`,
      status: "active",
      regionId: state.region.id,
      regionName: state.regionName
    }, state.superToken);
    await req("POST", "/auth/backoffice-credentials", {
      userId: state.limitedAdmin.id,
      username: `limited-${runId}`,
      password: `Limit${runId}`,
      role: "admin",
      permissions: ["dashboard:view", "backoffice-credentials:manage", "users:view"]
    }, state.superToken);
    state.limitedSession = await req("POST", "/auth/backoffice-login", { username: `limited-${runId}`, password: `Limit${runId}` });
    assert(hasNoProviderPermissions(state.limitedSession.user.permissions), "管理员不应含全局工作台权限");
  });
  await expectError(
    "受限管理员不能访问全局工作台",
    () => req("GET", "/platform/overview", undefined, state.limitedSession.token),
    { status: 403, includes: "无权" }
  );
  await expectError(
    "受限管理员不能下发自己没有的权限",
    () => req("POST", "/auth/backoffice-credentials", {
      userId: state.limitedAdmin.id,
      username: `limited-copy-${runId}`,
      password: `LimitCopy${runId}`,
      role: "admin",
      permissions: ["goods:manage"]
    }, state.limitedSession.token),
    { status: 403, includes: "自身没有" }
  );
  await expectError(
    "管理员身份不能拥有服务商全局权限",
    () => req("POST", "/auth/backoffice-credentials", {
      userId: state.limitedAdmin.id,
      username: `bad-provider-${runId}`,
      password: `BadProvider${runId}`,
      role: "admin",
      permissions: ["platform-overview:view"]
    }, state.superToken),
    { status: 403, includes: "身份不允许" }
  );

  await step("用户反馈会绑定本人且后台可处理", async () => {
    state.feedback = await req("POST", "/alerts/feedback", {
      type: "机器故障",
      deviceCode: state.deviceCode,
      detail: `专项反馈${runId}`,
      contact: state.specialPhone
    }, state.specialToken);
    assert(state.feedback.targetUserId === state.specialUserId, "反馈未绑定当前用户");
    const resolved = await req("PATCH", `/alerts/${state.feedback.id}/resolve`, { note: "专项处理" }, state.superToken);
    assert(resolved.status === "resolved", "反馈未处理");
  });

  await step("后台核心数据页面接口可读取", async () => {
    const dashboard = await req("GET", "/analytics/dashboard", undefined, state.superToken);
    const dataMonitor = await req("GET", "/analytics/data-monitor", undefined, state.superToken);
    const goodsOverview = await req("GET", "/goods-overview", undefined, state.superToken);
    const warehouse = await req("GET", "/warehouse-inventory", undefined, state.superToken);
    const logs = await req("GET", "/operation-logs", undefined, state.superToken);
    assert(dashboard && dataMonitor && goodsOverview && warehouse && Array.isArray(logs), "核心数据接口结构异常");
  });

  await step("操作日志导出需要权限且服务商可导出", async () => {
    await expectError(
      "受限管理员不能导出操作日志",
      () => req("GET", "/operation-logs/export/file", undefined, state.limitedSession.token, { raw: true }),
      { status: 403, includes: "无权" }
    );
    const exported = await req("GET", "/operation-logs/export/file", undefined, state.superToken, { raw: true });
    assert(exported.body.includes("<table"), "导出内容不是表格");
  });

  const failed = results.filter((entry) => !entry.ok);
  const summary = {
    passed: results.length - failed.length,
    failed: failed.length,
    total: results.length,
    runId,
    deviceCode: state.deviceCode,
    goodsId: state.goodsId,
    specialPhone: state.specialPhone,
    merchantAPhone: state.merchantA?.phone,
    failedItems: failed
  };

  console.log(JSON.stringify(summary, null, 2));
  process.exitCode = failed.length ? 1 : 0;
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
