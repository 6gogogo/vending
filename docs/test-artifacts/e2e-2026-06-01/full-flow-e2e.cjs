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
    if (check.notIncludes && String(error.message).includes(check.notIncludes)) {
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
  assertStep("程序提供商后台登录", superSession.user.backofficeRole === "super_admin");

  const seededDevice = await req("GET", "/devices/91120149", undefined, superToken);
  const seededDoor = seededDevice.doors[0];
  await req(
    "POST",
    "/devices/mock/upsert",
    {
      deviceCode: seededDevice.deviceCode,
      name: seededDevice.name,
      location: seededDevice.location,
      address: seededDevice.address,
      longitude: seededDevice.longitude,
      latitude: seededDevice.latitude,
      status: "online",
      doorNum: seededDoor.doorNum,
      goods: seededDoor.goods.map((goods) => ({
        goodsId: goods.goodsId,
        goodsCode: goods.goodsCode,
        name: goods.name,
        category: goods.category,
        stock: goods.stock,
        price: goods.price,
        imageUrl: goods.imageUrl,
        expiresAt: goods.expiresAt
      }))
    },
    superToken
  );

  // 历史种子批次可能已经到期；为本次隔离流程补充无到期批次，避免用过期库存验证正常领取链路。
  await req(
    "POST",
    "/goods/goods-1001/batches",
    {
      deviceCode: "91120149",
      quantity: 12,
      confirmed: true,
      sourceType: "admin",
      note: "本地 E2E 有效库存夹具"
    },
    superToken
  );

  const superCheck = await req("GET", "/auth/backoffice-session", undefined, superToken);
  assertStep("后台会话可恢复", superCheck.user.id === superSession.user.id);
  await expectError("未登录不能查看我的预约", () => req("GET", "/reservations/my"));

  const adminRegPhone = uniquePhone("137");
  const adminRegCode = await codeFor(adminRegPhone, "register");
  await expectError(
    "公开注册不能申请管理员身份",
    () =>
      req("POST", "/registration-applications", {
        phone: adminRegPhone,
        code: adminRegCode,
        requestedRole: "admin",
        profile: {
          name: "公开管理员申请",
          regionId: "region-001",
          regionName: "扬名街道",
          organization: "测试单位",
          title: "测试"
        }
      }),
    { includes: "管理员账号" }
  );

  const pendingPhone = uniquePhone("139");
  const pendingRegisterCode = await codeFor(pendingPhone, "register");
  const pendingApplication = await req("POST", "/registration-applications", {
    phone: pendingPhone,
    code: pendingRegisterCode,
    requestedRole: "special",
    profile: {
      name: `待审核受助${pendingPhone.slice(-4)}`,
      regionId: "region-001",
      regionName: "扬名街道",
      note: "端到端流程测试"
    }
  });
  assertStep("小程序提交受助用户注册申请", pendingApplication.status === "pending", pendingApplication.id);

  const publicLookup = await req("GET", `/registration-applications/by-phone?phone=${pendingPhone}`);
  assertStep("公开手机号查询只返回审核状态", publicLookup.state === "pending");

  const pendingLoginCode = await codeFor(pendingPhone, "app-login");
  const pendingLogin = await req("POST", "/auth/app-login", { phone: pendingPhone, code: pendingLoginCode });
  assertStep("待审核用户登录进入审核状态", pendingLogin.state === "pending_review");

  try {
    await req("POST", "/auth/request-code", { phone: pendingPhone, scene: "app-login" });
    record("待审核用户可请求登录验证码", true, "request accepted");
  } catch (error) {
    if (String(error.message).includes("请等待审核")) {
      throw error;
    }
    record("待审核用户请求登录验证码不再被审核状态拦截", true, `${error.status || ""} ${error.message}`.trim());
  }

  // 另用一个独立手机号覆盖审核通过后的首次登录，避免绕过真实的一次性验证码与重发限流。
  const specialPhone = uniquePhone("139");
  const registerCode = await codeFor(specialPhone, "register");
  const createdApplication = await req("POST", "/registration-applications", {
    phone: specialPhone,
    code: registerCode,
    requestedRole: "special",
    profile: {
      name: `流程受助${specialPhone.slice(-4)}`,
      regionId: "region-001",
      regionName: "扬名街道",
      note: "端到端审核通过流程"
    }
  });

  const reviewed = await req(
    "PATCH",
    `/registration-applications/${createdApplication.id}/review`,
    { decision: "approved" },
    superToken
  );
  assertStep("后台审核通过注册申请", reviewed.status === "approved" && reviewed.linkedUserId, reviewed.linkedUserId || "");

  const approvedLoginCode = await codeFor(specialPhone, "app-login");
  const appSession = await req("POST", "/auth/app-login", { phone: specialPhone, code: approvedLoginCode });
  const appToken = appSession.token;
  assertStep("审核通过后小程序登录成功", appSession.state === "approved" && appSession.user.role === "special", appSession.user.id);

  const settings = await req(
    "PATCH",
    "/reservations/settings",
    { enabled: true, holdMinutes: 30, maxTimeouts: 3 },
    superToken
  );
  assertStep("后台预约设置可配置", settings.enabled === true && settings.holdMinutes === 30);

  await req(
    "PATCH",
    "/access-rules?role=special",
    { dailyLimit: 1, categoryLimit: { food: 1, drink: 1, daily: 1 } },
    superToken
  );
  record("后台将隔离测试用户每日免费总额度设为 1 件", true);

  const devices = await req("GET", "/devices", undefined, appToken);
  const device = devices.find((item) => item.readiness?.canOpen) || devices[0];
  assertStep("小程序可读取柜机列表", Boolean(device), device?.deviceCode || "");

  const goodsList = await req("POST", `/devices/${device.deviceCode}/goods/query?doorNum=1`, undefined, appToken);
  const goods = goodsList.find((item) => (item.stock ?? 0) >= 1) || goodsList[0];
  assertStep("小程序可读取柜机可用货品", Boolean(goods && (goods.stock ?? 0) >= 1), `${goods?.goodsId}/${goods?.name}/stock=${goods?.stock}`);

  const policy = await req(
    "POST",
    "/special-access-policies",
    {
      name: `E2E 当前时段 ${runId}`,
      weekdays: [0, 1, 2, 3, 4, 5, 6],
      startHour: 0,
      endHour: 24,
      goodsLimits: [
        {
          goodsId: goods.goodsId,
          goodsName: goods.name,
          category: goods.category || "daily",
          quantity: 1
        }
      ],
      applicableUserIds: [appSession.user.id],
      status: "active"
    },
    superToken
  );
  assertStep("后台可创建当前时段领取策略", policy.applicableUserIds.includes(appSession.user.id), policy.id);

  const quota = await req("GET", `/access-rules/summary?phone=${specialPhone}`, undefined, appToken);
  assertStep("小程序额度显示当前策略", (quota.remainingByGoods?.[goods.goodsId] ?? 0) >= 1);

  await expectError(
    "预约库存不足会被拦截",
    () =>
      req(
        "POST",
        "/reservations",
        {
          deviceCode: device.deviceCode,
          doorNum: "1",
          intentItems: [
            {
              goodsId: goods.goodsId,
              goodsName: goods.name,
              category: goods.category || "daily",
              quantity: Number(goods.stock ?? 0) + 1
            }
          ]
        },
        appToken
      ),
    { includes: "库存不足" }
  );

  const reservation = await req(
    "POST",
    "/reservations",
    {
      deviceCode: device.deviceCode,
      doorNum: "1",
      intentItems: [
        {
          goodsId: goods.goodsId,
          goodsName: goods.name,
          category: goods.category || "daily",
          quantity: 1
        }
      ]
    },
    appToken
  );
  assertStep(
    "小程序可提前预约货品",
    reservation.status === "active" &&
      reservation.inventoryReservationMode === "goods_quantity" &&
      reservation.batchAllocationTiming === "on_open",
    reservation.id
  );

  await expectError(
    "不能用其他手机号开柜",
    () =>
      req(
        "POST",
        "/cabinet-events/open",
        {
          phone: uniquePhone("139"),
          deviceCode: device.deviceCode,
          doorNum: "1",
          reservationId: reservation.id,
          intentItems: [
            {
              goodsId: goods.goodsId,
              goodsName: goods.name,
              category: goods.category || "daily",
              quantity: 1
            }
          ]
        },
        appToken
      ),
    { includes: "不能使用其他手机号" }
  );

  const preview = await req(
    "POST",
    "/cabinet-events/open/pre-settlement",
    {
      phone: specialPhone,
      deviceCode: device.deviceCode,
      doorNum: "1",
      reservationId: reservation.id,
      intentItems: [
        {
          goodsId: goods.goodsId,
          goodsName: goods.name,
          category: goods.category || "daily",
          quantity: 1
        }
      ]
    },
    appToken
  );
  assertStep("开柜前结算预览为免费额度内", preview.preSettlement?.payableAmount === 0, `payable=${preview.preSettlement?.payableAmount}`);

  const opened = await req(
    "POST",
    "/cabinet-events/open",
    {
      phone: specialPhone,
      deviceCode: device.deviceCode,
      doorNum: "1",
      reservationId: reservation.id,
      quoteId: preview.quoteId,
      intentItems: [
        {
          goodsId: goods.goodsId,
          goodsName: goods.name,
          category: goods.category || "daily",
          quantity: 1
        }
      ]
    },
    appToken
  );
  assertStep("小程序预约开柜成功", Boolean(opened.eventId && opened.orderNo), `${opened.eventId}/${opened.orderNo}`);
  await req("POST", "/cabinet-events/callbacks/door-status", {
    eventId: opened.eventId,
    deviceCode: device.deviceCode,
    status: "SUCCESS",
    doorIsOpen: "Y"
  });
  await req("POST", "/cabinet-events/callbacks/door-status", {
    eventId: opened.eventId,
    deviceCode: device.deviceCode,
    status: "CLOSED",
    doorIsOpen: "N"
  });

  // 关门只解决物理状态，账务回调仍未完成时不得开始下一次领取。
  await expectError(
    "关门但账务未决时阻止再次开柜",
    () =>
      req(
        "POST",
        "/cabinet-events/open/pre-settlement",
        {
          phone: specialPhone,
          deviceCode: device.deviceCode,
          doorNum: "1",
          intentItems: [
            {
              goodsId: goods.goodsId,
              goodsName: goods.name,
              category: goods.category || "daily",
              quantity: 1
            }
          ]
        },
        appToken
      ),
    { includes: "待完成结算" }
  );

  const firstSettlementPayload = {
    orderNo: opened.orderNo,
    eventId: opened.eventId,
    phone: specialPhone,
    deviceCode: device.deviceCode,
    amount: 0,
    notifyUrl: "/api/pay/container/paymentSuccess",
    detail: [{ goodsName: goods.name, quantity: 1, unitPrice: goods.price || 0, goodsId: goods.goodsId }]
  };
  await req("POST", "/cabinet-events/callbacks/settlement", firstSettlementPayload);

  // 新建有价格、但不在免费物资清单内的隔离货品，稳定覆盖服务端计价与支付绑定。
  const paidGoods = await req(
    "POST",
    "/goods",
    {
      goodsId: `e2e-paid-${runId}`,
      goodsCode: `PAY${runId}`,
      name: `E2E 付费货品 ${runId}`,
      category: goods.category || "daily",
      price: 500,
      imageUrl: ""
    },
    superToken
  );
  await req(
    "POST",
    `/goods/${paidGoods.goodsId}/batches`,
    {
      deviceCode: device.deviceCode,
      quantity: 2,
      confirmed: true,
      sourceType: "admin",
      note: "E2E 隔离支付链路"
    },
    superToken
  );
  const paidIntentItems = [
    {
      goodsId: paidGoods.goodsId,
      goodsName: paidGoods.name,
      category: paidGoods.category,
      quantity: 2
    }
  ];
  const paidPreview = await req(
    "POST",
    "/cabinet-events/open/pre-settlement",
    {
      phone: specialPhone,
      deviceCode: device.deviceCode,
      doorNum: "1",
      intentItems: paidIntentItems
    },
    appToken
  );
  assertStep(
    "超出额度预结算产生服务端支付金额",
    Number.isSafeInteger(paidPreview.preSettlement?.payableAmount) && paidPreview.preSettlement.payableAmount > 0,
    `payable=${paidPreview.preSettlement?.payableAmount}`
  );
  const paidOpened = await req(
    "POST",
    "/cabinet-events/open",
    {
      phone: specialPhone,
      deviceCode: device.deviceCode,
      doorNum: "1",
      quoteId: paidPreview.quoteId,
      intentItems: paidIntentItems
    },
    appToken
  );
  await expectError(
    "开柜前支付阶段保持关闭",
    () =>
      req(
        "POST",
        "/payments/orders",
        {
          provider: "wechat",
          phase: "pre_open",
          eventId: paidOpened.eventId,
          orderNo: paidOpened.orderNo,
          amount: paidOpened.preSettlement.payableAmount,
          subject: `E2E 开柜前支付 ${runId}`,
          deviceCode: device.deviceCode,
          payerUserId: appSession.user.id
        },
        appToken
      ),
    { includes: "开柜前支付阶段尚未启用" }
  );
  await req("POST", "/cabinet-events/callbacks/door-status", {
    eventId: paidOpened.eventId,
    deviceCode: device.deviceCode,
    status: "SUCCESS",
    doorIsOpen: "Y"
  });
  await req("POST", "/cabinet-events/callbacks/door-status", {
    eventId: paidOpened.eventId,
    deviceCode: device.deviceCode,
    status: "CLOSED",
    doorIsOpen: "N"
  });
  await req("POST", "/cabinet-events/callbacks/settlement", {
    orderNo: paidOpened.orderNo,
    eventId: paidOpened.eventId,
    phone: specialPhone,
    deviceCode: device.deviceCode,
    amount: paidOpened.preSettlement.payableAmount,
    notifyUrl: "/api/pay/container/paymentSuccess",
    detail: [
      {
        goodsName: paidGoods.name,
        quantity: 2,
        unitPrice: paidGoods.price,
        goodsId: paidGoods.goodsId
      }
    ]
  });
  const beforeRetiredCallback = await req(
    "GET",
    `/cabinet-events/event/${paidOpened.eventId}`,
    undefined,
    appToken
  );
  await expectError(
    "伪入站付款成功回调已停用",
    () =>
      req("POST", "/cabinet-events/callbacks/payment-success", {
        orderNo: paidOpened.orderNo,
        eventId: paidOpened.eventId,
        transactionId: `untrusted-${runId}`,
        deviceCode: device.deviceCode,
        amount: paidOpened.preSettlement.payableAmount
      }),
    { status: 410 }
  );
  const afterRetiredCallback = await req(
    "GET",
    `/cabinet-events/event/${paidOpened.eventId}`,
    undefined,
    appToken
  );
  assertStep(
    "停用回调不会改写支付状态",
    afterRetiredCallback.paymentNotifyStatus === beforeRetiredCallback.paymentNotifyStatus
  );
  const payment = await req(
    "POST",
    "/payments/orders",
    {
      provider: "wechat",
      phase: "post_settlement",
      eventId: paidOpened.eventId,
      orderNo: paidOpened.orderNo,
      amount: paidOpened.preSettlement.payableAmount,
      subject: `E2E 支付 ${runId}`,
      deviceCode: device.deviceCode,
      payerUserId: appSession.user.id
    },
    appToken
  );
  assertStep("小程序可创建模拟支付单", payment.order.status === "pending", payment.order.id);
  const paid = await req("POST", `/payments/orders/${payment.order.id}/mock-paid`, {}, appToken);
  assertStep("模拟支付可完成", paid.status === "paid");

  const bogusEventId = `bogus-${runId}`;
  await expectError(
    "非法柜机回调被签名校验拦截",
    () =>
      req("POST", "/cabinet-events/callbacks/door-status", {
        eventId: bogusEventId,
        deviceCode: device.deviceCode,
        status: "SUCCESS"
      }),
    { includes: "签名" }
  );
  const callbackLogs = await req("GET", "/cabinet-events/callback-logs?limit=30", undefined, superToken);
  assertStep("非法回调不会写入回调日志", !callbackLogs.some((entry) => JSON.stringify(entry.payload || {}).includes(bogusEventId)));

  await req("POST", "/cabinet-events/callbacks/door-status", {
    eventId: opened.eventId,
    deviceCode: device.deviceCode,
    status: "SUCCESS",
    doorIsOpen: "Y"
  });
  await req("POST", "/cabinet-events/callbacks/door-status", {
    eventId: opened.eventId,
    deviceCode: device.deviceCode,
    status: "CLOSED",
    doorIsOpen: "N"
  });
  record("本地模拟柜门开关回调通过", true);

  await req("POST", "/cabinet-events/callbacks/settlement", firstSettlementPayload);
  const eventDetail = await req("GET", `/cabinet-events/event/${opened.eventId}`, undefined, appToken);
  assertStep("结算回调后事件进入已结算链路", ["settled", "completed", "closed"].includes(eventDetail.status) || Boolean(eventDetail.settlement));

  const records = await req("GET", `/inventory-orders?userId=${appSession.user.id}&role=special`, undefined, appToken);
  assertStep("结算后生成领取库存流水", records.some((entry) => entry.orderNo === opened.orderNo && entry.goodsId === goods.goodsId));

  const myReservations = await req("GET", "/reservations/my", undefined, appToken);
  assertStep("预约在开柜后完成", myReservations.some((entry) => entry.id === reservation.id && entry.status === "fulfilled"));

  const merchantPhone = "13800000004";
  const merchantCode = await codeFor(merchantPhone, "general");
  const merchantDraft = await req("POST", "/auth/mobile-login", {
    phone: merchantPhone,
    code: merchantCode,
    requestedRole: "merchant"
  });
  assertStep("预登记商家先进入资料补全", merchantDraft.state === "needs_profile" && merchantDraft.draft?.token);
  const merchantSession = await req("POST", "/auth/mobile-profile", {
    draftToken: merchantDraft.draft.token,
    requestedRole: "merchant",
    profile: {
      name: "鲜食爱心商户",
      regionId: "region-001",
      regionName: "扬名街道",
      organization: "鲜食爱心商户",
      title: "补货负责人",
      note: "E2E 预登记资料补全"
    }
  });
  const merchantToken = merchantSession.token;
  assertStep("商家小程序登录成功", merchantSession.state === "approved" && merchantSession.user.role === "merchant", merchantSession.user.id);

  await expectError(
    "商家开柜必须选择是否有商品入柜",
    () =>
      req(
        "POST",
        "/cabinet-events/open",
        {
          phone: merchantPhone,
          deviceCode: device.deviceCode,
          doorNum: "1"
        },
        merchantToken
      ),
    { includes: "是否有商品入柜" }
  );
  const merchantOpen = await req(
    "POST",
    "/cabinet-events/open",
    { phone: merchantPhone, deviceCode: device.deviceCode, doorNum: "1", hasInboundGoods: true },
    merchantToken
  );
  assertStep("商家补货开柜成功", Boolean(merchantOpen.eventId));
  await req("POST", "/cabinet-events/callbacks/door-status", {
    eventId: merchantOpen.eventId,
    deviceCode: device.deviceCode,
    status: "SUCCESS",
    doorIsOpen: "Y"
  });
  await req("POST", "/cabinet-events/callbacks/door-status", {
    eventId: merchantOpen.eventId,
    deviceCode: device.deviceCode,
    status: "CLOSED",
    doorIsOpen: "N"
  });
  record("商家入柜事件完成关门确认", true);

  const templatesBefore = await req("GET", "/merchant-goods-templates", undefined, merchantToken);
  assertStep("商家可读取补货模板", Array.isArray(templatesBefore));
  const template = await req(
    "POST",
    "/merchant-goods-templates",
    {
      goodsId: `e2e-goods-${runId}`,
      goodsCode: `E2E${runId}`,
      goodsName: `E2E补货${runId}`,
      fullName: `E2E补货${runId}`,
      category: goods.category || "daily",
      categoryName: "日用品",
      packageForm: "件",
      specification: "1件",
      manufacturer: "E2E",
      defaultQuantity: 2,
      defaultShelfLifeDays: 30
    },
    merchantToken
  );
  assertStep("商家可新增补货模板", Boolean(template.id), template.id);
  await expectError(
    "未确认补货明细不能登记补货",
    () =>
      req(
        "POST",
        "/merchant-restocks",
        {
          templateId: template.id,
          deviceCode: device.deviceCode,
          cabinetEventId: merchantOpen.eventId,
          productionDate: "2026-06-01",
          quantity: 1,
          confirmed: false
        },
        merchantToken
      ),
    { includes: "确认补货明细" }
  );
  const restock = await req(
    "POST",
    "/merchant-restocks",
    {
      templateId: template.id,
      deviceCode: device.deviceCode,
      cabinetEventId: merchantOpen.eventId,
      productionDate: "2026-06-01",
      quantity: 1,
      note: "端到端补货测试",
      confirmed: true
    },
    merchantToken
  );
  assertStep("确认后补货入库成功", Boolean(restock.batch?.batchId), restock.batch?.batchId || "");

  const traces = await req("GET", "/merchant-restock-traces", undefined, merchantToken);
  assertStep("商家可查看补货追踪", traces.batches.some((entry) => entry.batchId === restock.batch.batchId));

  const users = await req("GET", "/users", undefined, superToken);
  assertStep("后台可查看人员数据", users.some((entry) => entry.id === appSession.user.id));
  const goodsOverview = await req("GET", "/goods-overview", undefined, superToken);
  assertStep("后台可查看货品总览", typeof goodsOverview.totalKinds === "number" && Array.isArray(goodsOverview.byDevice));
  const warehouse = await req("GET", "/warehouse-inventory", undefined, superToken);
  assertStep("后台可查看仓库库存", typeof warehouse.totalStock === "number");
  const monitoring = await req("GET", `/devices/${device.deviceCode}/monitoring`, undefined, superToken);
  assertStep("后台可查看柜机监控", monitoring.device.deviceCode === device.deviceCode);
  const logs = await req("GET", "/operation-logs", undefined, superToken);
  assertStep("后台可查看操作日志", Array.isArray(logs) && logs.length > 0);

  const delegatePhone = uniquePhone("138");
  const delegateUser = await req(
    "POST",
    "/users",
    {
      role: "admin",
      phone: delegatePhone,
      name: `权限下发${delegatePhone.slice(-4)}`,
      status: "active",
      regionId: "region-001",
      regionName: "扬名街道"
    },
    superToken
  );
  const delegateUsername = `delegate-${runId}`.toLowerCase();
  await req(
    "POST",
    "/auth/backoffice-credentials",
    {
      userId: delegateUser.id,
      username: delegateUsername,
      password: "Delegate123!",
      role: "admin",
      permissions: ["users:view", "backoffice-credentials:manage"]
    },
    superToken
  );
  const delegateSession = await req("POST", "/auth/backoffice-login", {
    username: delegateUsername,
    password: "Delegate123!"
  });
  assertStep("下发的管理员账号可登录后台", delegateSession.user.backofficeRole === "admin");
  await expectError(
    "管理员不能发放自己没有的权限",
    () =>
      req(
        "POST",
        "/auth/backoffice-credentials",
        {
          userId: delegateUser.id,
          username: delegateUsername,
          role: "admin",
          permissions: ["users:view", "backoffice-credentials:manage", "devices:manage"]
        },
        delegateSession.token
      ),
    { includes: "自身没有的权限" }
  );
  await expectError(
    "管理员不能创建程序提供商账号",
    () =>
      req(
        "POST",
        "/auth/backoffice-credentials",
        {
          userId: delegateUser.id,
          username: `${delegateUsername}-provider`,
          password: "Delegate123!",
          role: "super_admin"
        },
        delegateSession.token
      ),
    { includes: "服务商账号" }
  );

  const failed = results.filter((entry) => !entry.ok);
  console.log(
    JSON.stringify(
      {
        passed: results.length - failed.length,
        failed: failed.length,
        total: results.length,
        specialPhone,
        specialUserId: appSession.user.id,
        eventId: opened.eventId,
        orderNo: opened.orderNo
      },
      null,
      2
    )
  );
  if (failed.length) {
    process.exitCode = 1;
  }
})().catch((error) => {
  record("E2E 脚本异常", false, `${error.status || ""} ${error.message}`.trim());
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
