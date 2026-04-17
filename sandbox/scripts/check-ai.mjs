import {
  authGetJson,
  ensureAdminToken,
  getSandboxConfig,
  getSystemAuditEntries,
  getJson,
  postJson,
  unwrapEnvelope
} from "./helpers.mjs";

const mode = (process.argv[2] ?? "full").trim().toLowerCase();
const sandboxConfig = getSandboxConfig();
const baseUrl = sandboxConfig.localApiBaseUrl.replace(/\/$/, "");

const readMessage = (payload) => {
  if (payload && typeof payload === "object" && typeof payload.message === "string") {
    return payload.message;
  }

  if (typeof payload === "string") {
    return payload;
  }

  return undefined;
};

const unwrapSuccess = (response, label) => {
  const envelope = response?.json;
  const code =
    envelope && typeof envelope === "object" && typeof envelope.code === "number"
      ? envelope.code
      : undefined;

  if (response.status < 200 || response.status >= 300 || (code !== undefined && code >= 400)) {
    throw new Error(
      `${label}失败：HTTP ${response.status}${readMessage(envelope) ? `，${readMessage(envelope)}` : ""}`
    );
  }

  return unwrapEnvelope(envelope);
};

const printSection = (title, payload) => {
  console.log(`\n=== ${title} ===`);
  console.log(JSON.stringify(payload, null, 2));
};

const requestAdminToken = async () => {
  const explicitToken = process.env.SANDBOX_ADMIN_TOKEN?.trim();

  if (explicitToken) {
    return {
      token: explicitToken,
      method: "SANDBOX_ADMIN_TOKEN"
    };
  }

  const phone = sandboxConfig.sandboxAdminPhone?.trim();

  if (!phone) {
    throw new Error("缺少 SANDBOX_ADMIN_PHONE，无法自动获取管理员登录态。");
  }

  const requestCodeResponse = await postJson(baseUrl, "/auth/request-code", {
    phone
  });
  const requestCodePayload = unwrapSuccess(requestCodeResponse, "请求管理员验证码");

  if (typeof requestCodePayload?.previewCode === "string" && requestCodePayload.previewCode.trim()) {
    const loginResponse = await postJson(baseUrl, "/auth/admin-login", {
      phone,
      code: requestCodePayload.previewCode.trim()
    });
    const loginPayload = unwrapSuccess(loginResponse, "使用预览验证码登录管理员");

    if (!loginPayload?.token) {
      throw new Error("管理员登录成功，但接口未返回 token。");
    }

    return {
      token: loginPayload.token,
      method: "request-code.previewCode"
    };
  }

  return {
    token: await ensureAdminToken(baseUrl),
    method: "SANDBOX_ADMIN_CODE"
  };
};

const run = async () => {
  const summary = {
    apiBaseUrl: baseUrl,
    mode,
    healthReachable: false,
    adminAuthOk: false,
    alertsOk: false,
    aiStatusOk: false,
    aiGenerationOk: false,
    likelyIssue: "unknown"
  };

  let token;
  let aiStatus;
  let generationError = "";

  try {
    const healthEnvelope = await getJson(baseUrl, "/health");
    const health = unwrapEnvelope(healthEnvelope);
    summary.healthReachable = true;

    printSection("1. 本地后端健康检查", {
      apiBaseUrl: baseUrl,
      status: health?.status,
      timestamp: health?.timestamp,
      ai: health?.ai
    });
  } catch (error) {
    summary.likelyIssue = "local_api_unreachable";
    throw new Error(
      `无法访问本地后端 ${baseUrl}。请先确认后端已启动，且接口地址配置正确。原始错误：${error instanceof Error ? error.message : String(error)}`
    );
  }

  try {
    const auth = await requestAdminToken();
    token = auth.token;
    summary.adminAuthOk = true;

    printSection("2. 管理员鉴权", {
      phone: sandboxConfig.sandboxAdminPhone,
      authMethod: auth.method,
      tokenObtained: Boolean(token)
    });
  } catch (error) {
    summary.likelyIssue = "admin_auth_failed";
    throw new Error(
      `管理员鉴权失败。请检查 SANDBOX_ADMIN_TOKEN 或 SANDBOX_ADMIN_PHONE / SANDBOX_ADMIN_CODE。原始错误：${error instanceof Error ? error.message : String(error)}`
    );
  }

  try {
    const alertsResponse = await authGetJson(baseUrl, "/alerts", token);
    const alerts = unwrapSuccess(alertsResponse, "读取 AI 工作台依赖的待办任务");
    summary.alertsOk = true;

    printSection("3. AI 工作台基础依赖：待办任务", {
      count: Array.isArray(alerts) ? alerts.length : 0,
      preview: Array.isArray(alerts) ? alerts.slice(0, 3).map((entry) => ({
        id: entry.id,
        title: entry.title,
        status: entry.status,
        grade: entry.grade
      })) : []
    });
  } catch (error) {
    summary.likelyIssue = "alerts_endpoint_failed";
    throw new Error(
      `AI 工作台初始化依赖 /alerts 调用失败。原始错误：${error instanceof Error ? error.message : String(error)}`
    );
  }

  try {
    const aiStatusResponse = await authGetJson(baseUrl, "/ai-insights/status", token);
    aiStatus = unwrapSuccess(aiStatusResponse, "读取 AI 状态");
    summary.aiStatusOk = true;

    printSection("4. AI 配置状态", aiStatus);
  } catch (error) {
    summary.likelyIssue = "ai_status_failed";
    throw new Error(
      `AI 工作台 /ai-insights/status 调用失败。原始错误：${error instanceof Error ? error.message : String(error)}`
    );
  }

  if (mode !== "status") {
    try {
      const reportResponse = await authGetJson(
        baseUrl,
        "/ai-insights/operations-report?reportType=morning",
        token
      );
      const report = unwrapSuccess(reportResponse, "生成 AI 运维晨报");
      summary.aiGenerationOk = true;

      printSection("5. AI 实际生成测试：运维晨报", {
        dateKey: report?.dateKey,
        reportType: report?.reportType,
        summary: report?.summary,
        meta: report?.meta,
        priorityItems: Array.isArray(report?.priorityItems) ? report.priorityItems.slice(0, 3) : []
      });
    } catch (error) {
      generationError = error instanceof Error ? error.message : String(error);
      summary.likelyIssue = "ai_generation_failed";

      printSection("5. AI 实际生成测试：运维晨报", {
        ok: false,
        error: generationError
      });
    }

    try {
      const auditEntries = await getSystemAuditEntries(baseUrl, token, {
        pathContains: "/external/openai",
        limit: 5
      });

      printSection("6. 最近 AI 上游审计日志", {
        count: Array.isArray(auditEntries) ? auditEntries.length : 0,
        entries: Array.isArray(auditEntries)
          ? auditEntries.slice(0, 3).map((entry) => ({
              occurredAt: entry.occurredAt,
              statusCode: entry.statusCode,
              path: entry.path,
              durationMs: entry.durationMs,
              error: entry.error?.message,
              response: entry.response
            }))
          : []
      });
    } catch (error) {
      printSection("6. 最近 AI 上游审计日志", {
        ok: false,
        error: error instanceof Error ? error.message : String(error)
      });
    }
  }

  if (summary.aiStatusOk && aiStatus?.enabled === false) {
    summary.likelyIssue = "openai_api_key_missing";
  } else if (generationError.includes("fetch failed")) {
    summary.likelyIssue = "upstream_openai_fetch_failed";
  } else if (summary.aiGenerationOk) {
    summary.likelyIssue = "none";
  }

  printSection("7. 总结", summary);
};

try {
  await run();
} catch (error) {
  console.error(
    JSON.stringify(
      {
        ok: false,
        apiBaseUrl: baseUrl,
        mode,
        error: error instanceof Error ? error.message : String(error)
      },
      null,
      2
    )
  );
  process.exitCode = 1;
}
