import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after } from "node:test";

import type { CallHandler, ExecutionContext } from "@nestjs/common";
import { firstValueFrom, of, throwError } from "rxjs";

import { PersistenceInterceptor } from "../src/common/store/persistence.interceptor";
import { InMemoryStoreService } from "../src/common/store/in-memory-store.service";
import type { VerificationPurpose } from "../src/common/store/persistence";
import { AuthController } from "../src/modules/auth/auth.controller";
import {
  initializeFirstBackofficePassword,
  MIN_FIRST_BACKOFFICE_PASSWORD_LENGTH
} from "../src/modules/auth/first-backoffice-password";
import { verifyAdminPassword } from "../src/modules/auth/admin-password.utils";
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
    requestCode: (phone: string, purpose?: VerificationPurpose) => Promise<{
      phone: string;
      expiresInSeconds: number;
      provider: "mock" | "aliyun_pnvs" | "manual";
    }>;
    verifyCode: (phone: string, code: string, purpose?: VerificationPurpose) => Promise<boolean>;
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

test("健康探测不写入审计日志或业务状态，但其他读取请求仍保留审计", async () => {
  const directory = createTemporaryDirectory("vm-health-audit-");
  const systemLogFile = join(directory, "system-audit.ndjson");
  process.env.SYSTEM_LOG_FILE = systemLogFile;
  let persistedCount = 0;
  const interceptor = new PersistenceInterceptor({
    persist() {
      persistedCount += 1;
    }
  } as InMemoryStoreService);

  for (const request of [
    { method: "GET", path: "/api/health", headers: {} },
    { method: "HEAD", url: "/api/health?probe=load-balancer", headers: {} },
    { method: "GET", path: "/api/health/production-readiness", headers: {} },
    { method: "HEAD", url: "/api/health/production-readiness?probe=gateway", headers: {} }
  ]) {
    const context = {
      switchToHttp: () => ({
        getRequest: () => request,
        getResponse: () => ({ statusCode: 200 })
      })
    } as ExecutionContext;

    await firstValueFrom(
      interceptor.intercept(context, {
        handle: () => of({ data: { status: "正常" } })
      } as CallHandler)
    );
  }

  assert.equal(persistedCount, 0);
  assert.equal(existsSync(systemLogFile), false);

  const errorContext = {
    switchToHttp: () => ({
      getRequest: () => ({ method: "GET", path: "/api/health/production-readiness", headers: {} }),
      getResponse: () => ({ statusCode: 503 })
    })
  } as ExecutionContext;
  await assert.rejects(
    firstValueFrom(
      interceptor.intercept(errorContext, {
        handle: () => throwError(() => new Error("health probe unavailable"))
      } as CallHandler)
    )
  );
  assert.equal(existsSync(systemLogFile), false);
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

test("首次后台密码初始化仅允许仍为默认密码的 admin，并撤销旧会话", () => {
  const store = createIsolatedStore();
  const credential = store.findBackofficeCredentialByUsername("admin");
  const user = store.users.find((entry) => entry.id === credential?.userId);
  assert.ok(credential);
  assert.ok(user);

  const existingSession = store.createBackofficeSession(user, credential.role, credential.tenantId);
  const password = "first-backoffice-password";
  const result = initializeFirstBackofficePassword(store, password);

  assert.equal(result.credential.username, "admin");
  assert.equal(result.credential.usesDefaultPassword, false);
  assert.equal(
    verifyAdminPassword(password, result.credential.passwordSalt, result.credential.passwordHash),
    true
  );
  assert.equal(store.getSession(existingSession), undefined);
  assert.ok(
    store.logs.some(
      (entry) =>
        entry.type === "initialize-first-backoffice-password" &&
        entry.metadata?.initializationMethod === "local-tty"
    )
  );
  assert.throws(
    () => initializeFirstBackofficePassword(store, password),
    /不处于可初始化的默认密码状态/
  );
  assert.throws(
    () =>
      initializeFirstBackofficePassword(
        createIsolatedStore(),
        "x".repeat(MIN_FIRST_BACKOFFICE_PASSWORD_LENGTH - 1)
      ),
    /至少需要/
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
    role: merchantCredential.role
  };
  assert.throws(
    () =>
      authService.resetBackofficePasswordAsSuperAdmin(superAdmin.token, {
        ...credentialPayload,
        newPassword: "1234567",
        reason: "密码长度测试"
      }),
    /至少需要 8 位/
  );
  assert.doesNotThrow(() =>
    authService.resetBackofficePasswordAsSuperAdmin(superAdmin.token, {
      ...credentialPayload,
      newPassword: "12345678",
      reason: "密码长度测试"
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

test("超级管理员重置其他后台账号密码时，目标账号旧会话立即失效", async () => {
  const store = createIsolatedStore();
  const authService = createAuthService(store);
  const superAdmin = await authService.backofficeLogin("super", "super123");
  const merchant = await authService.backofficeLogin("merchant", "merchant123");
  const merchantCredential = store.findBackofficeCredentialByUsername("merchant");
  assert.ok(merchantCredential);

  authService.resetBackofficePasswordAsSuperAdmin(superAdmin.token, {
    userId: merchantCredential.userId,
    role: merchantCredential.role,
    newPassword: "merchant-new-password",
    reason: "受控测试重置"
  });

  assert.equal(store.getSession(merchant.token), undefined);
  const refreshedMerchant = await authService.backofficeLogin("merchant", "merchant-new-password");
  assert.equal(refreshedMerchant.user.id, merchant.user.id);
});

test("普通后台管理员不能重置其他账号密码，通用账号配置接口也拒绝已有账号密码字段", async () => {
  const store = createIsolatedStore();
  const authService = createAuthService(store);
  const admin = await authService.backofficeLogin("admin", "admin");
  const merchantCredential = store.findBackofficeCredentialByUsername("merchant");
  assert.ok(merchantCredential);

  assert.throws(
    () =>
      authService.resetBackofficePasswordAsSuperAdmin(admin.token, {
        userId: merchantCredential.userId,
        role: merchantCredential.role,
        newPassword: "merchant-new-password",
        reason: "越权测试"
      }),
    /只有超级管理员/
  );

  assert.throws(
    () =>
      authService.createBackofficeCredential(admin.token, {
        userId: merchantCredential.userId,
        username: merchantCredential.username,
        password: "merchant-new-password",
        role: merchantCredential.role,
        tenantId: merchantCredential.tenantId
      }),
    /不能通过通用账号配置接口重置密码/
  );
});

test("账号本人通过手机号验证码重置后台密码会撤销旧会话", async () => {
  const store = createIsolatedStore();
  const verificationCodes = createVerificationCodeService(store);
  const authService = createAuthService(store, verificationCodes);
  const merchant = await authService.backofficeLogin("merchant", "merchant123");
  const issued = await verificationCodes.requestCode(merchant.user.phone, "password-reset");
  assert.ok(issued.previewCode);

  const result = await authService.resetOwnBackofficePassword({
    username: "merchant",
    phone: merchant.user.phone,
    code: issued.previewCode,
    newPassword: "merchant-owner-reset"
  });

  assert.deepEqual(result, { reset: true });
  assert.equal(store.getSession(merchant.token), undefined);
  const refreshedMerchant = await authService.backofficeLogin("merchant", "merchant-owner-reset");
  assert.equal(refreshedMerchant.user.id, merchant.user.id);
});

test("删除用户时立即撤销关联会话和资料草稿", () => {
  const store = createIsolatedStore();
  const usersService = new UsersService(store, {} as never, {} as never);
  const user = store.users.find((entry) => entry.role === "special" && entry.status === "active");
  assert.ok(user);
  const token = store.createSession(user);
  const draftToken = store.createDraftSession({
    phone: user.phone,
    linkedUserId: user.id,
    requestedRole: user.role
  });

  usersService.removeUser(user.id);

  assert.equal(store.sessions.has(token), false);
  assert.equal(store.draftSessions.has(draftToken), false);
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

test("全真模拟可使用手动设置的验证码，且仍受一次性校验保护", async () => {
  const store = createIsolatedStore();
  const service = new VerificationCodeService(
    {
      get: (key: string) =>
        ({
          VM_DATA_PLANE: "simulation",
          VM_SIMULATION_PROFILE: "full",
          VM_FULL_SIMULATION_VERIFICATION_MODE: "manual",
          VERIFICATION_CODE_PROVIDER: "mock",
          VERIFICATION_CODE_MANUAL_VALUE: "246810"
        })[key]
    } as never,
    store
  );

  const issued = await service.requestCode("13812345684", "app-login");

  assert.equal(issued.provider, "manual");
  assert.equal(issued.previewCode, undefined);
  assert.equal(await service.verifyCode("13812345684", "000000", "app-login"), false);
  assert.equal(await service.verifyCode("13812345684", "246810", "app-login"), true);
  assert.equal(await service.verifyCode("13812345684", "246810", "app-login"), false);
});

test("真实短信校验并发返回成功时，也只有一次能消费本地验证码状态", async () => {
  const store = createIsolatedStore();
  process.env.NODE_ENV = "test";
  const service = new VerificationCodeService(
    {
      get: (key: string) =>
        ({
          VERIFICATION_CODE_PROVIDER: "aliyun_pnvs"
        })[key]
    } as never,
    store
  );
  const phone = "13812345684";
  store.rememberVerificationRequest(phone, "app-login");
  (service as unknown as { verifyAliyunPnvsCode: () => Promise<boolean> }).verifyAliyunPnvsCode =
    async () => true;

  const results = await Promise.all([
    service.verifyCode(phone, "123456", "app-login"),
    service.verifyCode(phone, "123456", "app-login")
  ]);

  assert.deepEqual(results.sort(), [false, true]);
});

test("阿里云 PNVS 客户端按当前 SDK 的实际导出形态构造", () => {
  const store = createIsolatedStore();
  const service = new VerificationCodeService(
    {
      get: (key: string) =>
        ({
          ALIYUN_PNVS_ACCESS_KEY_ID: "test-access-key",
          ALIYUN_PNVS_ACCESS_KEY_SECRET: "test-access-secret"
        })[key]
    } as never,
    store
  );

  const client = (
    service as unknown as {
      createAliyunPnvsClient: () => {
        sendSmsVerifyCode: unknown;
        checkSmsVerifyCode: unknown;
      };
    }
  ).createAliyunPnvsClient();

  assert.equal(typeof client.sendSmsVerifyCode, "function");
  assert.equal(typeof client.checkSmsVerifyCode, "function");
});

test("阿里云 PNVS 按用途隔离发送和核验方案，且绝不返回真实验证码", async () => {
  const store = createIsolatedStore();
  const requests: Array<{ type: "send" | "check"; request: Record<string, unknown> }> = [];
  const service = new VerificationCodeService(
    {
      get: (key: string) =>
        ({
          VERIFICATION_CODE_PROVIDER: "aliyun_pnvs",
          ALIYUN_PNVS_ACCESS_KEY_ID: "test-access-key",
          ALIYUN_PNVS_ACCESS_KEY_SECRET: "test-access-secret",
          ALIYUN_PNVS_SIGN_NAME: "test-sign",
          ALIYUN_PNVS_TEMPLATE_CODE: "test-template",
          ALIYUN_PNVS_SCHEME_NAME_APP_LOGIN: "scheme-app-login",
          ALIYUN_PNVS_SCHEME_NAME_REGISTER: "scheme-register",
          ALIYUN_PNVS_SCHEME_NAME_GENERAL: "scheme-general",
          ALIYUN_PNVS_SCHEME_NAME_PASSWORD_RESET: "scheme-password-reset"
        })[key]
    } as never,
    store
  );
  (
    service as unknown as {
      createAliyunPnvsClient: () => {
        sendSmsVerifyCode: (request: Record<string, unknown>) => Promise<unknown>;
        checkSmsVerifyCode: (request: Record<string, unknown>) => Promise<unknown>;
      };
    }
  ).createAliyunPnvsClient = () => ({
    sendSmsVerifyCode: async (request) => {
      requests.push({ type: "send", request });
      return { body: { code: "OK", success: true } };
    },
    checkSmsVerifyCode: async (request) => {
      requests.push({ type: "check", request });
      return { body: { code: "OK", success: true, model: { verifyResult: "PASS" } } };
    }
  });

  const issued = await service.requestCode("13812345685", "password-reset");
  assert.equal(issued.provider, "aliyun_pnvs");
  assert.equal(issued.previewCode, undefined);
  assert.equal(await service.verifyCode("13812345685", "123456", "password-reset"), true);

  assert.deepEqual(
    requests.map(({ type, request }) => ({
      type,
      schemeName: request.schemeName,
      returnVerifyCode: request.returnVerifyCode,
      templateParam: request.templateParam
    })),
    [
      {
        type: "send",
        schemeName: "scheme-password-reset",
        returnVerifyCode: false,
        templateParam: JSON.stringify({ code: "##code##", min: "5" })
      },
      {
        type: "check",
        schemeName: "scheme-password-reset",
        returnVerifyCode: undefined,
        templateParam: undefined
      }
    ]
  );
});

test("阿里云 PNVS 未配置方案名称时发送和核验都使用默认方案", async () => {
  const store = createIsolatedStore();
  const requests: Array<{ type: "send" | "check"; request: Record<string, unknown> }> = [];
  const service = new VerificationCodeService(
    {
      get: (key: string) =>
        ({
          VERIFICATION_CODE_PROVIDER: "aliyun_pnvs",
          ALIYUN_PNVS_ACCESS_KEY_ID: "test-access-key",
          ALIYUN_PNVS_ACCESS_KEY_SECRET: "test-access-secret",
          ALIYUN_PNVS_SIGN_NAME: "test-sign",
          ALIYUN_PNVS_TEMPLATE_CODE: "test-template"
        })[key]
    } as never,
    store
  );
  (
    service as unknown as {
      createAliyunPnvsClient: () => {
        sendSmsVerifyCode: (request: Record<string, unknown>) => Promise<unknown>;
        checkSmsVerifyCode: (request: Record<string, unknown>) => Promise<unknown>;
      };
    }
  ).createAliyunPnvsClient = () => ({
    sendSmsVerifyCode: async (request) => {
      requests.push({ type: "send", request });
      return { body: { code: "OK", success: true } };
    },
    checkSmsVerifyCode: async (request) => {
      requests.push({ type: "check", request });
      return { body: { code: "OK", success: true, model: { verifyResult: "PASS" } } };
    }
  });

  const issued = await service.requestCode("13812345686", "app-login");
  assert.equal(issued.provider, "aliyun_pnvs");
  assert.equal(issued.previewCode, undefined);
  assert.equal(await service.verifyCode("13812345686", "123456", "app-login"), true);
  assert.deepEqual(
    requests.map(({ type, request }) => ({
      type,
      schemeName: request.schemeName
    })),
    [
      { type: "send", schemeName: undefined },
      { type: "check", schemeName: undefined }
    ]
  );
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
