import { randomUUID } from "node:crypto";

export const PUBLIC_API_BASE_URL = "https://vending.5gogogo.top/api";
export const MANUAL_VERIFICATION_CODE_TTL_SECONDS = 300;

class AcceptanceStageError extends Error {
  constructor(stage, status = undefined, recoveryReference = undefined) {
    super(
      status === undefined
        ? `受控公网验收未能完成“${stage}”。`
        : `受控公网验收未能完成“${stage}”（HTTP ${status}）。`
    );
    this.name = "AcceptanceStageError";
    this.stage = stage;
    this.status = status;
    this.recoveryReference = recoveryReference;
  }
}

const isRecord = (value) => Boolean(value) && typeof value === "object" && !Array.isArray(value);

const asString = (value) => (typeof value === "string" ? value.trim() : "");

const assertExactPublicApiBaseUrl = (value) => {
  if (value !== PUBLIC_API_BASE_URL) {
    throw new Error("受控公网验收只允许固定的 HTTPS 业务入口。");
  }

  return value;
};

const assertInputs = (inputs) => {
  const adminPassword = asString(inputs?.adminPassword);
  const manualCode = asString(inputs?.manualCode);

  if (!adminPassword) {
    throw new Error("本机后台密码不能为空。");
  }
  if (!/^\d{6}$/u.test(manualCode)) {
    throw new Error("人工验证码必须为 6 位数字。");
  }

  return { adminPassword, manualCode };
};

const createAcceptanceTestPhone = (runReference) => {
  const compactReference = runReference.replace(/-/gu, "");
  const suffix = (BigInt(`0x${compactReference.slice(-16)}`) % 10_000_000_000n)
    .toString()
    .padStart(10, "0");

  return `1${suffix}`;
};

const reportStage = (report, stage, outcome) => {
  if (typeof report === "function") {
    report({ stage, outcome });
  }
};

const buildHeaders = ({ token, hasBody = false }) => {
  const headers = {};

  if (token) {
    headers.authorization = `Bearer ${token}`;
  }
  if (hasBody) {
    headers["content-type"] = "application/json";
  }

  return headers;
};

const createRequestClient = ({ fetchImpl, publicApiBaseUrl }) => {
  if (typeof fetchImpl !== "function") {
    throw new Error("当前运行环境不支持受控 HTTPS 验收请求。");
  }

  const request = async ({ stage, path, method = "GET", token, body, expectedStatuses }) => {
    let response;

    try {
      response = await fetchImpl(`${publicApiBaseUrl}${path}`, {
        method,
        headers: buildHeaders({ token, hasBody: body !== undefined }),
        body: body === undefined ? undefined : JSON.stringify(body),
        redirect: "error"
      });
    } catch {
      throw new AcceptanceStageError(stage);
    }

    const status = Number(response?.status);

    if (!expectedStatuses.includes(status)) {
      throw new AcceptanceStageError(stage, status);
    }

    let payload = {};
    try {
      payload = await response.json();
    } catch {
      if (status >= 200 && status < 300) {
        throw new AcceptanceStageError(stage, status);
      }
    }

    return {
      status,
      data: isRecord(payload) && Object.hasOwn(payload, "data") ? payload.data : undefined
    };
  };

  return { request };
};

const assertManualSimulationConfig = (value) => {
  if (!isRecord(value)) {
    throw new Error("公网验收配置响应无效，未开始认证或写入。");
  }

  if (value.runtimeDataPlane !== "simulation") {
    throw new Error("当前不是隔离模拟数据平面，受控验收已停止。");
  }
  if (value.verificationProvider !== "manual") {
    throw new Error("当前未启用人工验证码，受控验收已停止。");
  }
  if (value.verificationPreviewEnabled !== false) {
    throw new Error("验证码预览状态不安全，受控验收已停止。");
  }
};

const requiredBackofficePermissions = new Set([
  "users:manage",
  "users:rules:manage",
  "verification-codes:manage",
  "devices:view"
]);

const assertBackofficePermissions = (value) => {
  if (!isRecord(value) || !isRecord(value.user) || value.user.backofficeRole !== "admin") {
    throw new Error("当前后台会话不是当前实例管理员，未创建任何验收数据。");
  }

  const permissions = new Set(
    Array.isArray(value.user.permissions)
      ? value.user.permissions.filter((entry) => typeof entry === "string")
      : []
  );
  if ([...requiredBackofficePermissions].some((permission) => !permissions.has(permission))) {
    throw new Error("当前后台会话缺少受控验收所需权限，未创建任何验收数据。");
  }
};

const assertAppSession = (value) => {
  if (!isRecord(value) || !isRecord(value.user) || value.user.role !== "special") {
    throw new AcceptanceStageError("核验 App 会话");
  }
};

export const preflightPublicAppAcceptance = async ({
  fetchImpl = globalThis.fetch,
  publicApiBaseUrl = PUBLIC_API_BASE_URL,
  report = undefined
} = {}) => {
  const apiBaseUrl = assertExactPublicApiBaseUrl(publicApiBaseUrl);
  const { request } = createRequestClient({ fetchImpl, publicApiBaseUrl: apiBaseUrl });
  const configResponse = await request({
    stage: "核验公网模拟配置",
    path: "/public-config",
    expectedStatuses: [200]
  });
  assertManualSimulationConfig(configResponse.data);
  reportStage(report, "核验公网模拟配置", "passed");
  return true;
};

const assertReservationEnabled = (value) => {
  if (!isRecord(value) || value.enabled !== true) {
    throw new Error("预约功能未启用，未创建任何验收数据。");
  }
};

const selectReservationCandidate = (value) => {
  if (!Array.isArray(value)) {
    throw new Error("柜机列表响应无效，未创建任何验收数据。");
  }

  for (const device of value) {
    if (!isRecord(device) || device.status !== "online") {
      continue;
    }
    const deviceCode = asString(device.deviceCode);

    if (!deviceCode || !Array.isArray(device.doors)) {
      continue;
    }

    for (const door of device.doors) {
      if (!isRecord(door) || !Array.isArray(door.goods)) {
        continue;
      }
      const doorNum = asString(door.doorNum);

      if (!doorNum) {
        continue;
      }

      for (const goods of door.goods) {
        if (!isRecord(goods) || Number(goods.stock) < 1) {
          continue;
        }
        const goodsId = asString(goods.goodsId);
        const goodsName = asString(goods.name);
        const category = asString(goods.category);

        if (
          goodsId &&
          goodsName &&
          ["food", "drink", "daily"].includes(category)
        ) {
          return { deviceCode, doorNum, goodsId, goodsName, category };
        }
      }
    }
  }

  throw new Error("没有可安全预约的现有模拟库存，未创建任何验收数据。");
};

const expectRecordId = (value, stage) => {
  const id = isRecord(value) ? asString(value.id) : "";

  if (!id) {
    throw new AcceptanceStageError(stage);
  }

  return id;
};

const expectToken = (value, stage) => {
  const token = isRecord(value) ? asString(value.token) : "";

  if (!token) {
    throw new AcceptanceStageError(stage);
  }

  return token;
};

const createAcceptanceUserPayload = (phone, runReference) => ({
  role: "special",
  phone,
  name: `公网验收专用账号-${runReference}`,
  status: "active",
  quota: {
    dailyLimit: 1,
    categoryLimit: { food: 1, drink: 1, daily: 1 }
  }
});

const createAccessPolicyPayload = (candidate) => ({
  name: "公网验收临时预约规则",
  weekdays: [0, 1, 2, 3, 4, 5, 6],
  startHour: 0,
  endHour: 24,
  goodsLimits: [{ goodsId: candidate.goodsId, quantity: 1 }],
  status: "active"
});

const runCleanup = async ({
  request,
  report,
  reservationId,
  appToken,
  userId,
  policyId,
  manualGrantId,
  manualCodeConsumed,
  adminToken
}) => {
  const failures = [];
  let fixtureRemoved = false;
  let reservationCancelled = !reservationId;

  if (reservationId) {
    try {
      await request({
        stage: "取消本次预约",
        path: `/reservations/${encodeURIComponent(reservationId)}/cancel`,
        method: "POST",
        token: appToken || adminToken,
        expectedStatuses: [200]
      });
      reservationCancelled = true;
      reportStage(report, "取消本次预约", "passed");
    } catch (error) {
      failures.push(error);
      reportStage(report, "取消本次预约", "failed");
    }
  }

  if (appToken) {
    try {
      await request({
        stage: "注销移动验收会话",
        path: "/auth/logout",
        method: "POST",
        token: appToken,
        expectedStatuses: [200, 201]
      });
      reportStage(report, "注销移动验收会话", "passed");
    } catch (error) {
      failures.push(error);
      reportStage(report, "注销移动验收会话", "failed");
    }
  }

  if (manualGrantId && !manualCodeConsumed && adminToken) {
    try {
      await request({
        stage: "撤销未消费人工验证码",
        path: `/auth/manual-verification-codes/${encodeURIComponent(manualGrantId)}/revoke`,
        method: "POST",
        token: adminToken,
        body: { reason: "验收失败清理" },
        expectedStatuses: [200, 201]
      });
      reportStage(report, "撤销未消费人工验证码", "passed");
    } catch (error) {
      failures.push(error);
      reportStage(report, "撤销未消费人工验证码", "failed");
    }
  }

  if (userId && adminToken && reservationCancelled) {
    try {
      await request({
        stage: "删除自建验收夹具",
        path: `/users/${encodeURIComponent(userId)}`,
        method: "DELETE",
        token: adminToken,
        expectedStatuses: [200]
      });
      fixtureRemoved = true;
      reportStage(report, "删除自建验收夹具", "passed");
    } catch (error) {
      failures.push(error);
      reportStage(report, "删除自建验收夹具", "failed");

      if (policyId) {
        try {
          await request({
            stage: "停用自建验收规则",
            path: `/users/${encodeURIComponent(userId)}/access-policies/${encodeURIComponent(policyId)}`,
            method: "DELETE",
            token: adminToken,
            expectedStatuses: [200]
          });
          reportStage(report, "停用自建验收规则", "passed");
        } catch (policyError) {
          failures.push(policyError);
          reportStage(report, "停用自建验收规则", "failed");
        }
      }
    }
  } else if (userId && adminToken) {
    const preservationError = new AcceptanceStageError("保留未取消预约的验收夹具");
    failures.push(preservationError);
    reportStage(report, "保留未取消预约的验收夹具", "failed");
  }

  if (adminToken) {
    try {
      await request({
        stage: "注销后台验收会话",
        path: "/auth/logout",
        method: "POST",
        token: adminToken,
        expectedStatuses: [200, 201]
      });
      reportStage(report, "注销后台验收会话", "passed");
    } catch (error) {
      failures.push(error);
      reportStage(report, "注销后台验收会话", "failed");
    }
  }

  return { failures, fixtureRemoved, reservationCancelled };
};

/**
 * 以固定 HTTPS 入口走一次正常权限链路。调用方只负责从 Spark VNC 本机隐藏读取口令，
 * 本模块不读取环境、文件或服务状态，也不会操作柜机、支付、库存和系统设置。
 */
export const runPublicAppAcceptance = async ({
  fetchImpl = globalThis.fetch,
  publicApiBaseUrl = PUBLIC_API_BASE_URL,
  inputs,
  createRunReference = () => randomUUID(),
  report = undefined
} = {}) => {
  const apiBaseUrl = assertExactPublicApiBaseUrl(publicApiBaseUrl);
  const { adminPassword, manualCode } = assertInputs(inputs);
  const { request } = createRequestClient({ fetchImpl, publicApiBaseUrl: apiBaseUrl });
  const runReference = asString(createRunReference());
  if (!/^[a-f0-9-]{16,64}$/u.test(runReference)) {
    throw new Error("受控公网验收运行参考号无效。");
  }
  const testPhone = createAcceptanceTestPhone(runReference);
  let adminToken;
  let appToken;
  let userId;
  let policyId;
  let manualGrantId;
  let manualCodeConsumed = false;
  let reservationId;
  let primaryError;
  let publicIngressVerified = false;
  let manualCodeReplayRejected = false;
  let reservationCancelled = false;

  try {
    const configResponse = await request({
      stage: "核验公网模拟配置",
      path: "/public-config",
      expectedStatuses: [200]
    });
    assertManualSimulationConfig(configResponse.data);
    publicIngressVerified = true;
    reportStage(report, "核验公网模拟配置", "passed");

    const backofficeLogin = await request({
      stage: "后台管理员登录",
      path: "/auth/backoffice-login",
      method: "POST",
      body: { username: "admin", password: adminPassword },
      expectedStatuses: [201]
    });
    adminToken = expectToken(backofficeLogin.data, "后台管理员登录");
    reportStage(report, "后台管理员登录", "passed");

    const backofficeSession = await request({
      stage: "核验后台验收权限",
      path: "/auth/backoffice-session",
      token: adminToken,
      expectedStatuses: [200]
    });
    assertBackofficePermissions(backofficeSession.data);
    reportStage(report, "核验后台验收权限", "passed");

    const reservationSettings = await request({
      stage: "核验预约开关",
      path: "/reservations/settings",
      token: adminToken,
      expectedStatuses: [200]
    });
    assertReservationEnabled(reservationSettings.data);
    reportStage(report, "核验预约开关", "passed");

    const deviceList = await request({
      stage: "核验可用模拟库存",
      path: "/devices",
      token: adminToken,
      expectedStatuses: [200]
    });
    const candidate = selectReservationCandidate(deviceList.data);
    reportStage(report, "核验可用模拟库存", "passed");

    const createdUser = await request({
      stage: "创建自建验收夹具",
      path: "/users",
      method: "POST",
      token: adminToken,
      body: createAcceptanceUserPayload(testPhone, runReference),
      expectedStatuses: [201]
    });
    userId = expectRecordId(createdUser.data, "创建自建验收夹具");
    reportStage(report, "创建自建验收夹具", "passed");

    const createdPolicy = await request({
      stage: "设置自建预约规则",
      path: `/users/${encodeURIComponent(userId)}/access-policies`,
      method: "POST",
      token: adminToken,
      body: createAccessPolicyPayload(candidate),
      expectedStatuses: [201]
    });
    policyId = expectRecordId(createdPolicy.data, "设置自建预约规则");
    reportStage(report, "设置自建预约规则", "passed");

    const issuedCode = await request({
      stage: "签发一次性人工验证码",
      path: "/auth/manual-verification-codes",
      method: "POST",
      token: adminToken,
      body: {
        userId,
        purpose: "app-login",
        code: manualCode,
        expiresInSeconds: MANUAL_VERIFICATION_CODE_TTL_SECONDS
      },
      expectedStatuses: [201]
    });
    manualGrantId = expectRecordId(issuedCode.data, "签发一次性人工验证码");
    reportStage(report, "签发一次性人工验证码", "passed");

    const appLogin = await request({
      stage: "App 人工码登录",
      path: "/auth/app-login",
      method: "POST",
      body: { phone: testPhone, code: manualCode },
      expectedStatuses: [201]
    });
    if (!isRecord(appLogin.data) || appLogin.data.state !== "approved") {
      throw new AcceptanceStageError("App 人工码登录");
    }
    appToken = expectToken(appLogin.data, "App 人工码登录");
    reportStage(report, "App 人工码登录", "passed");

    const appSession = await request({
      stage: "核验 App 会话",
      path: "/auth/app-session",
      token: appToken,
      expectedStatuses: [200]
    });
    assertAppSession(appSession.data);
    reportStage(report, "核验 App 会话", "passed");

    const appReservationSettings = await request({
      stage: "核验 App 预约开关",
      path: "/reservations/settings",
      token: appToken,
      expectedStatuses: [200]
    });
    assertReservationEnabled(appReservationSettings.data);
    reportStage(report, "核验 App 预约开关", "passed");

    const appDeviceList = await request({
      stage: "核验 App 可见柜机",
      path: "/devices",
      token: appToken,
      expectedStatuses: [200]
    });
    if (
      !Array.isArray(appDeviceList.data) ||
      !appDeviceList.data.some((device) => isRecord(device) && device.deviceCode === candidate.deviceCode)
    ) {
      throw new AcceptanceStageError("核验 App 可见柜机");
    }
    reportStage(report, "核验 App 可见柜机", "passed");

    const appDeviceDetail = await request({
      stage: "核验 App 柜机详情",
      path: `/devices/${encodeURIComponent(candidate.deviceCode)}`,
      token: appToken,
      expectedStatuses: [200]
    });
    if (!isRecord(appDeviceDetail.data) || appDeviceDetail.data.deviceCode !== candidate.deviceCode) {
      throw new AcceptanceStageError("核验 App 柜机详情");
    }
    reportStage(report, "核验 App 柜机详情", "passed");

    const createdReservation = await request({
      stage: "创建 App 预约",
      path: "/reservations",
      method: "POST",
      token: appToken,
      body: {
        deviceCode: candidate.deviceCode,
        doorNum: candidate.doorNum,
        intentItems: [
          {
            goodsId: candidate.goodsId,
            goodsName: candidate.goodsName,
            category: candidate.category,
            quantity: 1
          }
        ]
      },
      expectedStatuses: [200]
    });
    if (!isRecord(createdReservation.data) || createdReservation.data.status !== "active") {
      throw new AcceptanceStageError("创建 App 预约");
    }
    reservationId = expectRecordId(createdReservation.data, "创建 App 预约");
    reportStage(report, "创建 App 预约", "passed");

    const myReservations = await request({
      stage: "核验 App 当前预约",
      path: "/reservations/my",
      token: appToken,
      expectedStatuses: [200]
    });
    if (
      !Array.isArray(myReservations.data) ||
      !myReservations.data.some(
        (reservation) =>
          isRecord(reservation) &&
          reservation.id === reservationId &&
          reservation.status === "active"
      )
    ) {
      throw new AcceptanceStageError("核验 App 当前预约");
    }
    reportStage(report, "核验 App 当前预约", "passed");

    await request({
      stage: "拒绝人工码重放",
      path: "/auth/app-login",
      method: "POST",
      body: { phone: testPhone, code: manualCode },
      expectedStatuses: [401]
    });
    manualCodeReplayRejected = true;
    reportStage(report, "拒绝人工码重放", "passed");

    const manualGrantHistory = await request({
      stage: "核验人工码已消费",
      path: "/auth/manual-verification-codes",
      token: adminToken,
      expectedStatuses: [200]
    });
    if (
      !Array.isArray(manualGrantHistory.data) ||
      !manualGrantHistory.data.some(
        (grant) => isRecord(grant) && grant.id === manualGrantId && grant.status === "consumed"
      )
    ) {
      throw new AcceptanceStageError("核验人工码已消费");
    }
    manualCodeConsumed = true;
    reportStage(report, "核验人工码已消费", "passed");
  } catch (error) {
    if (
      !userId &&
      error instanceof AcceptanceStageError &&
      error.stage === "创建自建验收夹具"
    ) {
      error.recoveryReference = runReference;
    }
    primaryError = error;
  }

  const cleanup = await runCleanup({
    request,
    report,
    reservationId,
    appToken,
    userId,
    policyId,
    manualGrantId,
    manualCodeConsumed,
    adminToken
  });
  reservationCancelled = Boolean(reservationId) && cleanup.reservationCancelled;

  if (primaryError) {
    throw primaryError;
  }
  if (cleanup.failures.length > 0) {
    throw new Error("受控公网验收的清理步骤未完整通过，已停止并保留审计证据。");
  }

  return {
    publicIngressVerified,
    manualCodeReplayRejected,
    reservationCancelled,
    fixtureRemoved: cleanup.fixtureRemoved
  };
};
