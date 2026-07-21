import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after } from "node:test";

import type { CallHandler, ExecutionContext } from "@nestjs/common";
import { firstValueFrom, of } from "rxjs";

import { PersistenceInterceptor } from "../src/common/store/persistence.interceptor";
import { InMemoryStoreService } from "../src/common/store/in-memory-store.service";
import { AuthController } from "../src/modules/auth/auth.controller";
import { AuthService } from "../src/modules/auth/auth.service";
import { VerificationCodeService } from "../src/modules/auth/verification-code.service";
import { UsersService } from "../src/modules/users/users.service";

const temporaryDirectories: string[] = [];
const createTemporaryDirectory = (prefix: string) => {
  const directory = mkdtempSync(join(tmpdir(), prefix));
  temporaryDirectories.push(directory);
  return directory;
};

after(() => {
  for (const directory of temporaryDirectories) {
    rmSync(directory, { recursive: true, force: true });
  }
});

const createIsolatedStore = () => {
  const directory = createTemporaryDirectory("vm-auth-store-");
  process.env.API_DATA_FILE = join(directory, "store.json");
  process.env.ENABLE_TEST_DEVICE_BOOTSTRAP = "false";
  return new InMemoryStoreService();
};

const createAuthService = (
  store: InMemoryStoreService,
  verificationCodeService: {
    requestCode: (phone: string, purpose?: string) => Promise<{
      phone: string;
      expiresInSeconds: number;
      provider: "mock";
    }>;
    verifyCode: (phone: string, code: string, purpose?: string) => Promise<boolean>;
  } = {
    requestCode: async (phone) => ({
      phone,
      expiresInSeconds: 300,
      provider: "mock" as const
    }),
    verifyCode: async () => true
  }
) =>
  new AuthService(
    {
      findByPhone: (phone: string) =>
        store.users.find((entry) => entry.phone === phone && entry.status === "active"),
      findById: (userId: string) => store.users.find((entry) => entry.id === userId)
    } as never,
    {
      getQuotaSummaryForUser: () => undefined
    } as never,
    {
      findLatestByPhone: () => undefined
    } as never,
    store,
    verificationCodeService as never,
    {
      get: () => "true"
    } as never
  );

const createVerificationCodeService = (store: InMemoryStoreService) => {
  process.env.NODE_ENV = "test";
  const values: Record<string, string> = {
    VERIFICATION_CODE_PROVIDER: "mock",
    VERIFICATION_CODE_PREVIEW_ENABLED: "true",
    PUBLIC_BASE_URL: "http://127.0.0.1:4000"
  };

  return new VerificationCodeService(
    {
      get: (key: string) => values[key]
    } as never,
    store
  );
};

test("系统审计日志递归脱敏认证信息，且保留普通业务字段", async () => {
  const directory = createTemporaryDirectory("vm-auth-audit-");
  const systemLogFile = join(directory, "system-audit.ndjson");
  process.env.SYSTEM_LOG_FILE = systemLogFile;
  let persistedCount = 0;

  const interceptor = new PersistenceInterceptor({
    persist() {
      persistedCount += 1;
    }
  } as InMemoryStoreService);
  const responseBody = {
    data: {
      profile: {
        displayName: "可见业务字段",
        securityContext: {
          accessToken: "live-session-token",
          refresh_token: "live-refresh-token",
          clientSecret: "live-client-secret",
          apiKey: "live-api-key",
          accessKeyId: "live-access-key-id",
          public_key: "live-public-key",
          previewCode: "live-preview-code",
          Authorization: "Bearer live-authorization",
          Cookie: "sid=live-cookie"
        }
      }
    }
  };
  const context = {
    switchToHttp: () => ({
      getRequest: () => ({
        method: "POST",
        path: "/api/auth/backoffice-login",
        body: {
          account: {
            password: "live-password"
          }
        },
        headers: {}
      }),
      getResponse: () => ({ statusCode: 200 })
    })
  } as ExecutionContext;
  const next = {
    handle: () => of(responseBody)
  } as CallHandler;

  await firstValueFrom(interceptor.intercept(context, next));

  assert.equal(persistedCount, 1);
  const serialized = readFileSync(systemLogFile, "utf8");
  assert.match(serialized, /可见业务字段/);
  for (const secret of [
    "live-session-token",
    "live-refresh-token",
    "live-client-secret",
    "live-api-key",
    "live-access-key-id",
    "live-public-key",
    "live-preview-code",
    "live-authorization",
    "live-cookie",
    "live-password"
  ]) {
    assert.doesNotMatch(serialized, new RegExp(secret));
  }
});

test("读取请求保留审计记录，但不触发全量业务状态写盘", async () => {
  const directory = createTemporaryDirectory("vm-read-audit-");
  const systemLogFile = join(directory, "system-audit.ndjson");
  process.env.SYSTEM_LOG_FILE = systemLogFile;
  let persistedCount = 0;
  const interceptor = new PersistenceInterceptor({
    persist() {
      persistedCount += 1;
    }
  } as InMemoryStoreService);
  const context = {
    switchToHttp: () => ({
      getRequest: () => ({
        method: "GET",
        path: "/api/auth/mobile-session",
        headers: {}
      }),
      getResponse: () => ({ statusCode: 200 })
    })
  } as ExecutionContext;

  await firstValueFrom(
    interceptor.intercept(context, {
      handle: () => of({ data: { user: { id: "user-001" } } })
    } as CallHandler)
  );

  assert.equal(persistedCount, 0);
  assert.match(readFileSync(systemLogFile, "utf8"), /mobile-session/);
});

test("失败状态的写请求保留审计记录，但不触发业务状态写盘", async () => {
  const directory = createTemporaryDirectory("vm-failed-write-audit-");
  const systemLogFile = join(directory, "system-audit.ndjson");
  process.env.SYSTEM_LOG_FILE = systemLogFile;
  let persistedCount = 0;
  const interceptor = new PersistenceInterceptor({
    persist() {
      persistedCount += 1;
    }
  } as InMemoryStoreService);
  const context = {
    switchToHttp: () => ({
      getRequest: () => ({
        method: "POST",
        path: "/api/auth/mobile-login",
        body: { phone: "13987654321", code: "111222" },
        headers: {}
      }),
      getResponse: () => ({ statusCode: 401 })
    })
  } as ExecutionContext;

  await firstValueFrom(
    interceptor.intercept(context, {
      handle: () => of({ code: 401, message: "手机号或验证码不正确。" })
    } as CallHandler)
  );

  assert.equal(persistedCount, 0);
  const serialized = readFileSync(systemLogFile, "utf8");
  assert.match(serialized, /mobile-login/);
  assert.doesNotMatch(serialized, /111222/);
});

test("登录态和资料草稿使用高熵 token，并由服务端拒绝过期记录", () => {
  const store = createIsolatedStore();
  const user = store.users.find((entry) => entry.status === "active");
  assert.ok(user);

  const firstToken = store.createSession(user);
  const secondToken = store.createSession(user);
  const firstSession = store.sessions.get(firstToken) as { expiresAt?: string } | undefined;

  assert.notEqual(firstToken, secondToken);
  assert.ok(firstToken.length >= 40);
  assert.ok(firstSession?.expiresAt);
  assert.ok(new Date(firstSession.expiresAt).getTime() > Date.now());

  firstSession.expiresAt = new Date(Date.now() - 1_000).toISOString();
  assert.equal(store.getSession(firstToken), undefined);
  assert.equal(store.sessions.has(firstToken), false);

  const inactiveToken = store.createSession(user);
  user.status = "inactive";
  assert.equal(store.getSessionUser(inactiveToken), undefined);
  assert.equal(store.sessions.has(inactiveToken), false);
  user.status = "active";

  const draftToken = store.createDraftSession({ phone: user.phone });
  const draft = store.draftSessions.get(draftToken) as { expiresAt?: string } | undefined;
  assert.ok(draftToken.length >= 40);
  assert.ok(draft?.expiresAt);

  draft.expiresAt = new Date(Date.now() - 1_000).toISOString();
  assert.equal(store.getDraftSession(draftToken), undefined);
  assert.equal(store.draftSessions.has(draftToken), false);
});

test("用户角色或后台租户凭证变化后，旧会话会在服务端失效", () => {
  const store = createIsolatedStore();
  const specialUser = store.users.find((entry) => entry.role === "special" && entry.status === "active");
  const credential = store.backofficeCredentials.find((entry) => entry.role !== "super_admin");
  const backofficeUser = store.users.find(
    (entry) => entry.id === credential?.userId && entry.status === "active"
  );
  assert.ok(specialUser);
  assert.ok(credential);
  assert.ok(backofficeUser);

  const mobileToken = store.createSession(specialUser);
  specialUser.role = "admin";
  assert.equal(store.getSessionUser(mobileToken), undefined);
  assert.equal(store.sessions.has(mobileToken), false);

  const backofficeToken = store.createBackofficeSession(
    backofficeUser,
    credential.role,
    credential.tenantId
  );
  credential.tenantId = "tenant-changed";
  assert.equal(store.getBackofficeSessionUser(backofficeToken), undefined);
  assert.equal(store.sessions.has(backofficeToken), false);
});

test("业务数据完成租户分区前，非当前实例的后台会话必须失败关闭", () => {
  const store = createIsolatedStore();
  const credential = store.backofficeCredentials.find((entry) => entry.role === "admin");
  const user = store.users.find((entry) => entry.id === credential?.userId && entry.status === "active");
  assert.ok(credential);
  assert.ok(user);

  const token = store.createBackofficeSession(user, credential.role, "tenant-future");
  credential.tenantId = "tenant-future";

  assert.equal(store.getSessionUser(token), undefined);
  assert.equal(store.sessions.has(token), false);
});

test("统一退出接口可撤销移动端和后台当前 token，且重复退出保持幂等", () => {
  const store = createIsolatedStore();
  const authService = createAuthService(store);
  const controller = new AuthController(authService);
  const mobileUser = store.users.find((entry) => entry.role === "special" && entry.status === "active");
  const adminUser = store.users.find((entry) => entry.role === "admin" && entry.status === "active");
  assert.ok(mobileUser);
  assert.ok(adminUser);

  const mobileToken = store.createSession(mobileUser);
  const backofficeToken = store.createBackofficeSession(adminUser, "admin", store.getDefaultTenantId());

  assert.deepEqual(controller.logout(`Bearer ${mobileToken}`), {
    code: 200,
    message: "已退出登录。",
    data: { revoked: true }
  });
  assert.equal(store.getSession(mobileToken), undefined);
  assert.deepEqual(controller.logout(`Bearer ${backofficeToken}`), {
    code: 200,
    message: "已退出登录。",
    data: { revoked: true }
  });
  assert.equal(store.getSession(backofficeToken), undefined);
  assert.deepEqual(controller.logout(`Bearer ${backofficeToken}`), {
    code: 200,
    message: "已退出登录。",
    data: { revoked: false }
  });
});

test("后台密码变更撤销该用户全部旧会话，并只返回一个新会话", async () => {
  const store = createIsolatedStore();
  const authService = createAuthService(store);
  const first = await authService.backofficeLogin("admin", "admin");
  const second = await authService.backofficeLogin("admin", "admin");

  const changed = authService.changeBackofficePassword(
    first.token,
    "admin",
    "new-secure-password"
  );

  assert.notEqual(changed.token, first.token);
  assert.equal(store.getSession(first.token), undefined);
  assert.equal(store.getSession(second.token), undefined);
  assert.equal(store.getSession(changed.token)?.userId, changed.user.id);
  assert.equal(authService.getBackofficeSession(changed.token).token, changed.token);
  await assert.rejects(
    () => authService.backofficeLogin("admin", "admin"),
    /账号或密码不正确/
  );
});

test("旧管理员密码接口变更密码时同样旋转会话", async () => {
  const store = createIsolatedStore();
  const authService = createAuthService(store);
  const first = await authService.adminPasswordLogin("admin", "admin");
  const second = await authService.adminPasswordLogin("admin", "admin");

  const changed = authService.changeAdminPassword(
    first.token,
    "admin",
    "new-admin-password"
  );

  assert.notEqual(changed.token, first.token);
  assert.equal(store.getSession(first.token), undefined);
  assert.equal(store.getSession(second.token), undefined);
  assert.equal(authService.getAdminSession(changed.token).token, changed.token);
});

test("新设和修改后台密码至少八位，既有短密码仍可登录后迁移", async () => {
  const store = createIsolatedStore();
  const authService = createAuthService(store);

  const legacyAdmin = await authService.adminPasswordLogin("admin", "admin");
  assert.throws(
    () => authService.changeAdminPassword(legacyAdmin.token, "admin", "1234567"),
    /至少需要 8 位/
  );
  assert.ok(store.getSession(legacyAdmin.token));

  const legacyBackoffice = await authService.backofficeLogin("admin", "admin");
  assert.throws(
    () => authService.changeBackofficePassword(legacyBackoffice.token, "admin", "1234567"),
    /至少需要 8 位/
  );
  assert.ok(store.getSession(legacyBackoffice.token));

  const superAdmin = await authService.backofficeLogin("super", "super123");
  const merchantCredential = store.findBackofficeCredentialByUsername("merchant");
  assert.ok(merchantCredential);
  const credentialPayload = {
    userId: merchantCredential.userId,
    username: merchantCredential.username,
    role: merchantCredential.role,
    tenantId: merchantCredential.tenantId
  };
  assert.throws(
    () =>
      authService.createBackofficeCredential(superAdmin.token, {
        ...credentialPayload,
        password: "1234567"
      }),
    /至少需要 8 位/
  );
  assert.doesNotThrow(() =>
    authService.createBackofficeCredential(superAdmin.token, {
      ...credentialPayload,
      password: "12345678"
    })
  );

  const migrated = authService.changeAdminPassword(
    legacyAdmin.token,
    "admin",
    "12345678"
  );
  assert.ok(store.getSession(migrated.token));
});

test("非管理员使用后台验证码登录失败时，不遗留可用会话", async () => {
  const store = createIsolatedStore();
  const authService = createAuthService(store);
  const specialUser = store.users.find((entry) => entry.role === "special" && entry.status === "active");
  assert.ok(specialUser);
  const sessionCountBefore = store.sessions.size;

  await assert.rejects(
    () => authService.adminLogin(specialUser.phone, "123456"),
    /当前账号不是管理员/
  );
  assert.equal(store.sessions.size, sessionCountBefore);

  const adminUser = store.users.find(
    (entry) => entry.role === "admin" && store.findAdminCredentialByUserId(entry.id)
  );
  assert.ok(adminUser);
  const credentialIndex = store.adminCredentials.findIndex(
    (entry) => entry.userId === adminUser.id
  );
  assert.ok(credentialIndex >= 0);
  store.adminCredentials.splice(credentialIndex, 1);

  await assert.rejects(
    () => authService.adminLogin(adminUser.phone, "123456"),
    /未配置登录凭证/
  );
  assert.equal(store.sessions.size, sessionCountBefore);
});

test("停用用户时，单个更新和批量更新都会立即撤销其已有会话", () => {
  const store = createIsolatedStore();
  const usersService = new UsersService(store, {} as never, {} as never);
  const specialUser = store.users.find((entry) => entry.role === "special" && entry.status === "active");
  const merchantUser = store.users.find((entry) => entry.role === "merchant" && entry.status === "active");
  assert.ok(specialUser);
  assert.ok(merchantUser);

  const specialToken = store.createSession(specialUser);
  const specialDraftToken = store.createDraftSession({
    phone: specialUser.phone,
    linkedUserId: specialUser.id,
    requestedRole: specialUser.role
  });
  usersService.updateUser(specialUser.id, { status: "inactive" });
  assert.equal(store.sessions.has(specialToken), false);
  assert.equal(store.draftSessions.has(specialDraftToken), false);

  const merchantToken = store.createSession(merchantUser);
  usersService.batchUpdate({
    userIds: [merchantUser.id],
    patch: { status: "inactive" }
  });
  assert.equal(store.sessions.has(merchantToken), false);
});

test("管理员重置其他后台账号密码时，目标账号旧会话立即失效", async () => {
  const store = createIsolatedStore();
  const authService = createAuthService(store);
  const superAdmin = await authService.backofficeLogin("super", "super123");
  const merchant = await authService.backofficeLogin("merchant", "merchant123");
  const merchantCredential = store.findBackofficeCredentialByUsername("merchant");
  assert.ok(merchantCredential);

  authService.createBackofficeCredential(superAdmin.token, {
    userId: merchantCredential.userId,
    username: merchantCredential.username,
    password: "merchant-new-password",
    role: merchantCredential.role,
    tenantId: merchantCredential.tenantId
  });

  assert.equal(store.getSession(merchant.token), undefined);
  const refreshedMerchant = await authService.backofficeLogin("merchant", "merchant-new-password");
  assert.equal(refreshedMerchant.user.id, merchant.user.id);
});

test("验证码成功后立即消费，同一验证码不能再次使用", async () => {
  const store = createIsolatedStore();
  const verificationCodes = createVerificationCodeService(store);
  const phone = "13812345678";
  const issued = await verificationCodes.requestCode(phone, "register");
  assert.ok(issued.previewCode);

  assert.equal(await verificationCodes.verifyCode(phone, issued.previewCode, "register"), true);
  assert.equal(await verificationCodes.verifyCode(phone, issued.previewCode, "register"), false);
  await assert.rejects(
    () => verificationCodes.requestCode(phone, "register"),
    /验证码发送过于频繁/
  );
});

test("验证码不会写入业务快照或运行数据文件", async () => {
  const store = createIsolatedStore();
  const verificationCodes = createVerificationCodeService(store);
  const issued = await verificationCodes.requestCode("13812345682", "register");
  assert.ok(issued.previewCode);

  store.persist();

  const serialized = readFileSync(process.env.API_DATA_FILE!, "utf8");
  assert.doesNotMatch(serialized, new RegExp(issued.previewCode));
  assert.deepEqual(JSON.parse(serialized).verificationCodes, []);
});

test("API 显式监听非回环地址时，即使是 mock 提供方也不返回验证码预览", async () => {
  const store = createIsolatedStore();
  process.env.NODE_ENV = "test";
  const service = new VerificationCodeService(
    {
      get: (key: string) =>
        ({
          VERIFICATION_CODE_PROVIDER: "mock",
          VERIFICATION_CODE_PREVIEW_ENABLED: "true",
          PUBLIC_BASE_URL: "http://127.0.0.1:4000",
          API_HOST: "0.0.0.0"
        })[key]
    } as never,
    store
  );

  const issued = await service.requestCode("13812345683", "register");
  assert.equal(issued.previewCode, undefined);
});

test("真实短信校验并发返回成功时，也只有一次能消费本地验证码状态", async () => {
  const store = createIsolatedStore();
  process.env.NODE_ENV = "test";
  const service = new VerificationCodeService(
    {
      get: (key: string) =>
        ({
          VERIFICATION_CODE_PROVIDER: "aliyun"
        })[key]
    } as never,
    store
  );
  const phone = "13812345684";
  store.rememberVerificationRequest(phone, "app-login");
  (service as unknown as { verifyAliyunCode: () => Promise<boolean> }).verifyAliyunCode =
    async () => true;

  const results = await Promise.all([
    service.verifyCode(phone, "123456", "app-login"),
    service.verifyCode(phone, "123456", "app-login")
  ]);

  assert.deepEqual(results.sort(), [false, true]);
});

test("同一手机号的发码冷却和验证码按用途隔离", async () => {
  const store = createIsolatedStore();
  const verificationCodes = createVerificationCodeService(store);
  const phone = "13812345679";
  const registerCode = await verificationCodes.requestCode(phone, "register");
  const loginCode = await verificationCodes.requestCode(phone, "app-login");
  assert.ok(registerCode.previewCode);
  assert.ok(loginCode.previewCode);

  await assert.rejects(
    () => verificationCodes.requestCode(phone, "register"),
    /验证码发送过于频繁/
  );
  assert.equal(
    await verificationCodes.verifyCode(phone, registerCode.previewCode, "app-login"),
    false
  );
  assert.equal(
    await verificationCodes.verifyCode(phone, registerCode.previewCode, "register"),
    true
  );
  assert.equal(
    await verificationCodes.verifyCode(phone, loginCode.previewCode, "app-login"),
    true
  );
});

test("同一手机号和用途连续五次校验失败后锁定当前验证码，但不影响其他用途", async () => {
  const store = createIsolatedStore();
  const verificationCodes = createVerificationCodeService(store);
  const phone = "13812345680";
  const registerCode = await verificationCodes.requestCode(phone, "register");
  const loginCode = await verificationCodes.requestCode(phone, "app-login");
  assert.ok(registerCode.previewCode);
  assert.ok(loginCode.previewCode);

  for (let attempt = 0; attempt < 5; attempt += 1) {
    assert.equal(await verificationCodes.verifyCode(phone, "000000", "register"), false);
  }

  assert.equal(
    await verificationCodes.verifyCode(phone, registerCode.previewCode, "register"),
    false
  );
  assert.equal(
    await verificationCodes.verifyCode(phone, loginCode.previewCode, "app-login"),
    true
  );
});

test("应用登录发码不公开手机号注册状态，并将用途传给发码和校验服务", async () => {
  const store = createIsolatedStore();
  const requestedPurposes: Array<string | undefined> = [];
  const verifiedPurposes: Array<string | undefined> = [];
  const authService = createAuthService(store, {
    requestCode: async (phone, purpose) => {
      requestedPurposes.push(purpose);
      return { phone, expiresInSeconds: 300, provider: "mock" };
    },
    verifyCode: async (_phone, _code, purpose) => {
      verifiedPurposes.push(purpose);
      return true;
    }
  });
  const unknownPhone = "13899999999";

  const issued = await authService.requestCode(unknownPhone, "app-login");
  assert.deepEqual(issued, {
    phone: unknownPhone,
    expiresInSeconds: 300,
    provider: "mock"
  });
  assert.deepEqual(requestedPurposes, ["app-login"]);

  const loginResult = await authService.appLogin(unknownPhone, "123456");
  assert.equal(loginResult.state, "not_registered");
  assert.deepEqual(verifiedPurposes, ["app-login"]);
});

test("未知验证码用途统一归入 general，不能靠伪造用途绕过发码冷却", async () => {
  const store = createIsolatedStore();
  const verificationCodes = createVerificationCodeService(store);
  const phone = "13812345681";

  await verificationCodes.requestCode(phone, "bypass-a" as never);
  await assert.rejects(
    () => verificationCodes.requestCode(phone, "bypass-b" as never),
    /验证码发送过于频繁/
  );
});
