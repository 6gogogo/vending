import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after } from "node:test";

import type { CallHandler, ExecutionContext } from "@nestjs/common";
import { ConflictException, ServiceUnavailableException } from "@nestjs/common";
import { firstValueFrom, of, throwError } from "rxjs";

import {
  PersistenceInterceptor,
  REQUEST_PERSISTENCE_HANDLED
} from "../src/common/store/persistence.interceptor";
import { InMemoryStoreService } from "../src/common/store/in-memory-store.service";
import {
  PersistedStateWriteError,
  type VerificationPurpose
} from "../src/common/store/persistence";
import { AuthController } from "../src/modules/auth/auth.controller";
import {
  changeAdminBackofficePasswordWithCurrentPassword,
  initializeFirstBackofficePassword,
  MIN_FIRST_BACKOFFICE_PASSWORD_LENGTH,
  MIN_ADMIN_BACKOFFICE_PASSWORD_RECOVERY_LENGTH,
  recoverAdminBackofficePassword
} from "../src/modules/auth/first-backoffice-password";
import {
  initializeFirstSuperAdminPassword,
  MIN_FIRST_SUPER_ADMIN_PASSWORD_LENGTH,
  MIN_SUPER_ADMIN_BACKOFFICE_PASSWORD_RECOVERY_LENGTH,
  recoverSuperAdminBackofficePassword
} from "../src/modules/auth/first-super-admin-password";
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
    describeCodeRequest?: (phone: string) => {
      phone: string;
      expiresInSeconds: number;
      provider: "mock" | "aliyun_pnvs" | "manual";
    };
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
      findLatestByPhone: () => undefined,
      resolvePublicTenantId: () => store.getDefaultTenantId()
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

test("已在服务内原子持久化的密码找回请求不会被拦截器重复写盘", async () => {
  const directory = createTemporaryDirectory("vm-reset-persistence-audit-");
  const systemLogFile = join(directory, "system-audit.ndjson");
  process.env.SYSTEM_LOG_FILE = systemLogFile;
  let persistedCount = 0;
  const interceptor = new PersistenceInterceptor({
    persist() {
      persistedCount += 1;
    }
  } as InMemoryStoreService);
  const request = {
    method: "POST",
    path: "/api/auth/backoffice-password-reset",
    headers: {},
    [REQUEST_PERSISTENCE_HANDLED]: true
  };
  const context = {
    switchToHttp: () => ({
      getRequest: () => request,
      getResponse: () => ({ statusCode: 200 })
    })
  } as ExecutionContext;

  await firstValueFrom(
    interceptor.intercept(context, {
      handle: () => of({ data: { reset: true } })
    } as CallHandler)
  );

  assert.equal(persistedCount, 0);
  assert.match(
    readFileSync(systemLogFile, "utf8"),
    /backoffice-password-reset/
  );
});

test("密码找回在文件已替换后失败时向调用方报告不可重复提交的 409", async () => {
  const directory = createTemporaryDirectory("vm-reset-indeterminate-audit-");
  process.env.SYSTEM_LOG_FILE = join(directory, "system-audit.ndjson");
  const interceptor = new PersistenceInterceptor({
    persist() {
      throw new Error("不应执行第二次持久化");
    }
  } as unknown as InMemoryStoreService);
  const context = {
    switchToHttp: () => ({
      getRequest: () => ({
        method: "POST",
        path: "/api/auth/backoffice-password-reset",
        headers: {}
      }),
      getResponse: () => ({ statusCode: 500 })
    })
  } as ExecutionContext;

  await assert.rejects(
    firstValueFrom(
      interceptor.intercept(context, {
        handle: () =>
          throwError(
            () =>
              new PersistedStateWriteError(
                "injected-post-rename-durability-failure",
                true
              )
          )
      } as CallHandler)
    ),
    (error: unknown) => {
      if (!(error instanceof ConflictException) || error.getStatus() !== 409) {
        return false;
      }

      const response = error.getResponse();
      return (
        typeof response === "object" &&
        response !== null &&
        "code" in response &&
        response.code === "operation_indeterminate" &&
        "retryable" in response &&
        response.retryable === false
      );
    }
  );
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
        body: {
          phone: "13987654321",
          code: "111222",
          mobileProfileCompleted: true
        },
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
  assert.match(serialized, /"mobileProfileCompleted":true/);
  assert.doesNotMatch(serialized, /111222/);
  assert.doesNotMatch(serialized, /13987654321/);
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

  const draftToken = store.createDraftSession({
    tenantId: store.getUserTenantId(user)!,
    phone: user.phone
  });
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

test("首次后台密码初始化允许六位密码、仅允许默认 admin，并撤销旧会话", () => {
  const store = createIsolatedStore();
  const credential = store.findBackofficeCredentialByUsername("admin");
  const user = store.users.find((entry) => entry.id === credential?.userId);
  assert.ok(credential);
  assert.ok(user);

  const existingSession = store.createBackofficeSession(user, credential.role, credential.tenantId);
  const password = "904281";
  assert.equal(MIN_FIRST_BACKOFFICE_PASSWORD_LENGTH, 6);
  const result = initializeFirstBackofficePassword(store, password);

  assert.equal(result.credential.username, "admin");
  assert.equal(result.credential.usesDefaultPassword, false);
  assert.equal(
    verifyAdminPassword(password, result.credential.passwordSalt, result.credential.passwordHash),
    true
  );
  const legacyCredential = store.findAdminCredentialByUsername("admin");
  assert.ok(legacyCredential);
  assert.equal(legacyCredential.usesDefaultPassword, false);
  assert.equal(
    verifyAdminPassword(password, legacyCredential.passwordSalt, legacyCredential.passwordHash),
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

test("服务商超级管理员首次改密只处理固定默认账号、保持常规八位规则并撤销旧会话", () => {
  const store = createIsolatedStore();
  const candidates = store.backofficeCredentials.filter((credential) =>
    store.isDefaultSuperAdminBootstrapCredential(credential)
  );
  assert.equal(candidates.length, 1);
  const [credential] = candidates;
  const user = store.users.find((entry) => entry.id === credential.userId);
  assert.ok(user);
  assert.equal(credential.role, "super_admin");
  assert.equal(credential.tenantId, undefined);

  const renamedStore = createIsolatedStore();
  const renamedCredential = renamedStore.backofficeCredentials.find((entry) =>
    renamedStore.isDefaultSuperAdminBootstrapCredential(entry)
  );
  assert.ok(renamedCredential);
  renamedCredential.username = "renamed-super-admin";
  assert.equal(renamedStore.isDefaultSuperAdminBootstrapCredential(renamedCredential), false);

  const existingSession = store.createBackofficeSession(user, credential.role, credential.tenantId);
  const password = "s".repeat(MIN_FIRST_SUPER_ADMIN_PASSWORD_LENGTH);
  assert.equal(MIN_FIRST_SUPER_ADMIN_PASSWORD_LENGTH, 8);
  const result = initializeFirstSuperAdminPassword(store, password);

  assert.equal(result.credential.role, "super_admin");
  assert.equal(result.credential.usesDefaultPassword, false);
  assert.equal(store.isDefaultSuperAdminBootstrapCredential(result.credential), false);
  assert.equal(
    verifyAdminPassword(password, result.credential.passwordSalt, result.credential.passwordHash),
    true
  );
  assert.equal(store.getSession(existingSession), undefined);
  assert.ok(
    store.logs.some(
      (entry) =>
        entry.type === "initialize-first-super-admin-password" &&
        entry.metadata?.initializationMethod === "local-tty"
    )
  );
  assert.throws(
    () => initializeFirstSuperAdminPassword(store, password),
    /不处于可首次改密的默认状态/u
  );
  assert.throws(
    () =>
      initializeFirstSuperAdminPassword(
        createIsolatedStore(),
        "x".repeat(MIN_FIRST_SUPER_ADMIN_PASSWORD_LENGTH - 1)
      ),
    /至少需要/u
  );
});

test("本机服务商密码恢复处理凭据导入生成的 live provider 并撤销旧会话", async () => {
  const store = createIsolatedStore();
  const initialCredential = store.backofficeCredentials.find((credential) =>
    store.isDefaultSuperAdminBootstrapCredential(credential)
  );
  const user = store.users.find((entry) => entry.id === initialCredential?.userId);
  assert.ok(initialCredential);
  assert.ok(user);

  const initialized = initializeFirstSuperAdminPassword(
    store,
    "initial-provider-password"
  );
  user.id = "live-provider-test";
  initialized.credential.userId = user.id;
  initialized.credential.username = "live-provider";
  const authService = createAuthService(store);
  const existingSession = await authService.backofficeLogin(
    "live-provider",
    "initial-provider-password"
  );
  const recoveredPassword = "recovered-provider-password";

  assert.equal(MIN_SUPER_ADMIN_BACKOFFICE_PASSWORD_RECOVERY_LENGTH, 8);
  const result = recoverSuperAdminBackofficePassword(store, recoveredPassword);

  assert.equal(result.credential.userId, user.id);
  assert.equal(result.credential.username, "live-provider");
  assert.equal(result.credential.role, "super_admin");
  assert.equal(result.credential.tenantId, undefined);
  assert.equal(result.credential.usesDefaultPassword, false);
  assert.equal(
    verifyAdminPassword(
      recoveredPassword,
      result.credential.passwordSalt,
      result.credential.passwordHash
    ),
    true
  );
  assert.equal(store.getSession(existingSession.token), undefined);
  assert.ok(
    store.logs.some(
      (entry) =>
        entry.type === "recover-super-admin-backoffice-password" &&
        entry.metadata?.recoveryMethod === "local-tty"
    )
  );
});

test("本机服务商密码恢复在存在多个有效 super_admin 时失败关闭", () => {
  const store = createIsolatedStore();
  const initialCredential = store.backofficeCredentials.find((credential) =>
    store.isDefaultSuperAdminBootstrapCredential(credential)
  );
  const user = store.users.find((entry) => entry.id === initialCredential?.userId);
  assert.ok(user);

  const initialized = initializeFirstSuperAdminPassword(
    store,
    "initial-provider-password"
  );
  const duplicateUser = {
    ...user,
    id: "live-provider-duplicate"
  };
  store.users.push(duplicateUser);
  store.backofficeCredentials.push({
    ...initialized.credential,
    userId: duplicateUser.id,
    username: "duplicate-live-provider"
  });

  assert.throws(
    () => recoverSuperAdminBackofficePassword(store, "recovered-provider-password"),
    /不存在唯一有效的服务商超级管理员/u
  );
});

test("实例找回页对服务商和未知账号统一无副作用拒绝", async () => {
  const store = createIsolatedStore();
  const initialCredential = store.backofficeCredentials.find((credential) =>
    store.isDefaultSuperAdminBootstrapCredential(credential)
  );
  const user = store.users.find((entry) => entry.id === initialCredential?.userId);
  assert.ok(user);

  const initialized = initializeFirstSuperAdminPassword(
    store,
    "initial-provider-password"
  );
  user.id = "live-provider-reset-boundary";
  initialized.credential.userId = user.id;
  initialized.credential.username = "live-provider";
  let requestCalls = 0;
  let verificationCalls = 0;
  const authService = createAuthService(store, {
    requestCode: async (phone) => {
      requestCalls += 1;
      return {
        phone,
        expiresInSeconds: 300,
        provider: "mock"
      };
    },
    describeCodeRequest: (phone) => ({
      phone,
      expiresInSeconds: 300,
      provider: "mock"
    }),
    verifyCode: async () => {
      verificationCalls += 1;
      return true;
    }
  });

  const providerRequest = await authService.requestCode(
    user.phone,
    "password-reset",
    "live-provider"
  );
  const unknownRequest = await authService.requestCode(
    user.phone,
    "password-reset",
    "unknown-provider"
  );
  assert.deepEqual(providerRequest, unknownRequest);
  assert.equal(requestCalls, 0);

  const adminCredential = store.findBackofficeCredentialByUsername("admin");
  const adminUser = store.users.find((entry) => entry.id === adminCredential?.userId);
  assert.ok(adminUser);
  const instanceRequest = await authService.requestCode(
    adminUser.phone,
    "password-reset",
    "admin"
  );
  assert.equal(instanceRequest.phone, adminUser.phone);
  assert.equal(requestCalls, 1);

  await assert.rejects(
    () =>
      authService.resetOwnBackofficePassword({
        username: "live-provider",
        phone: user.phone,
        code: "123456",
        newPassword: "should-not-replace-provider-password"
      }),
    /账号、手机号或验证码不正确/u
  );
  await assert.rejects(
    () =>
      authService.resetOwnBackofficePassword({
        username: "unknown-provider",
        phone: user.phone,
        code: "123456",
        newPassword: "should-not-replace-provider-password"
      }),
    /账号、手机号或验证码不正确/u
  );
  assert.equal(verificationCalls, 0);
  const login = await authService.backofficeLogin(
    "live-provider",
    "initial-provider-password"
  );
  assert.equal(login.user.backofficeRole, "super_admin");
});

test("启动时会修复旧 admin 凭据仍标记默认密码的历史状态", () => {
  const store = createIsolatedStore();
  const password = "904281";
  initializeFirstBackofficePassword(store, password);

  const legacyCredential = store.findAdminCredentialByUsername("admin");
  assert.ok(legacyCredential);
  legacyCredential.usesDefaultPassword = true;
  store.persist();

  const restarted = new InMemoryStoreService();
  const repairedLegacyCredential = restarted.findAdminCredentialByUsername("admin");
  assert.ok(repairedLegacyCredential);
  assert.equal(repairedLegacyCredential.usesDefaultPassword, false);
  assert.equal(
    verifyAdminPassword(
      password,
      repairedLegacyCredential.passwordSalt,
      repairedLegacyCredential.passwordHash
    ),
    true
  );
  assert.equal(restarted.flushBootstrapPersistence(), true);

  const reloaded = new InMemoryStoreService();
  const persistedLegacyCredential = reloaded.findAdminCredentialByUsername("admin");
  assert.ok(persistedLegacyCredential);
  assert.equal(persistedLegacyCredential.usesDefaultPassword, false);
});

test("本机 admin 维护会先验证当前密码，再允许已初始化账号改为六位并撤销旧会话", () => {
  const store = createIsolatedStore();
  const initialPassword = "714628";
  initializeFirstBackofficePassword(store, initialPassword);
  const credential = store.findBackofficeCredentialByUsername("admin");
  const user = store.users.find((entry) => entry.id === credential?.userId);
  assert.ok(credential);
  assert.ok(user);

  const existingSession = store.createBackofficeSession(user, credential.role, credential.tenantId);
  assert.throws(
    () =>
      changeAdminBackofficePasswordWithCurrentPassword(
        store,
        "not-the-current-password",
        "817529"
      ),
    /当前 admin 密码不正确/u
  );
  assert.equal(store.getSession(existingSession)?.userId, user.id);
  assert.equal(
    verifyAdminPassword(initialPassword, credential.passwordSalt, credential.passwordHash),
    true
  );

  const updatedPassword = "817529";
  const result = changeAdminBackofficePasswordWithCurrentPassword(
    store,
    initialPassword,
    updatedPassword
  );

  assert.equal(result.credential.username, "admin");
  assert.equal(result.credential.usesDefaultPassword, false);
  assert.equal(
    verifyAdminPassword(
      updatedPassword,
      result.credential.passwordSalt,
      result.credential.passwordHash
    ),
    true
  );
  const legacyCredential = store.findAdminCredentialByUsername("admin");
  assert.ok(legacyCredential);
  assert.equal(legacyCredential.usesDefaultPassword, false);
  assert.equal(
    verifyAdminPassword(updatedPassword, legacyCredential.passwordSalt, legacyCredential.passwordHash),
    true
  );
  assert.equal(store.getSession(existingSession), undefined);
  assert.ok(
    store.logs.some(
      (entry) =>
        entry.type === "change-admin-backoffice-password-with-current-password" &&
        entry.metadata?.passwordChangeMethod === "local-tty-current-password"
    )
  );
  assert.throws(
    () =>
      changeAdminBackofficePasswordWithCurrentPassword(
        store,
        updatedPassword,
        updatedPassword
      ),
    /新密码不能与当前密码相同/u
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
  const synchronizedBackoffice = await authService.backofficeLogin("admin", "new-admin-password");
  assert.equal(synchronizedBackoffice.user.id, changed.user.id);
});

test("唯一 admin 可验证当前密码后改为六位，其他后台账号仍至少八位", async () => {
  const store = createIsolatedStore();
  const authService = createAuthService(store);

  const legacyAdmin = await authService.adminPasswordLogin("admin", "admin");
  assert.throws(
    () => authService.changeAdminPassword(legacyAdmin.token, "admin", "12345"),
    /至少需要 6 位/
  );
  assert.ok(store.getSession(legacyAdmin.token));
  const updatedLegacyAdmin = authService.changeAdminPassword(
    legacyAdmin.token,
    "admin",
    "123456"
  );
  assert.equal(store.getSession(legacyAdmin.token), undefined);
  assert.ok(store.getSession(updatedLegacyAdmin.token));

  await assert.rejects(
    () => authService.backofficeLogin("admin", "admin"),
    /账号或密码不正确/
  );
  const legacyBackoffice = await authService.backofficeLogin("admin", "123456");
  assert.throws(
    () => authService.changeBackofficePassword(legacyBackoffice.token, "错误的当前密码", "654321"),
    /当前密码不正确/
  );
  assert.ok(store.getSession(legacyBackoffice.token));
  assert.throws(
    () => authService.changeBackofficePassword(legacyBackoffice.token, "123456", "12345"),
    /至少需要 6 位/
  );
  assert.ok(store.getSession(legacyBackoffice.token));
  const updatedBackoffice = authService.changeBackofficePassword(
    legacyBackoffice.token,
    "123456",
    "654321"
  );
  assert.equal(store.getSession(legacyBackoffice.token), undefined);
  assert.ok(store.getSession(updatedBackoffice.token));

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
        newPassword: "12345678",
        reason: "平台全局态越权测试"
      }),
    /请先进入目标客户实例/
  );
  const scopedSuperAdmin = authService.enterPlatformTenant(
    superAdmin.token,
    store.getDefaultTenantId()
  );
  assert.throws(
    () =>
      authService.resetBackofficePasswordAsSuperAdmin(scopedSuperAdmin.token, {
        ...credentialPayload,
        newPassword: "1234567",
        reason: "密码长度测试"
      }),
    /至少需要 8 位/
  );
  assert.doesNotThrow(() =>
    authService.resetBackofficePasswordAsSuperAdmin(scopedSuperAdmin.token, {
      ...credentialPayload,
      newPassword: "12345678",
      reason: "密码长度测试"
    })
  );

  await assert.rejects(
    () => authService.adminPasswordLogin("admin", "123456"),
    /账号或密码不正确/
  );
  const refreshedLegacyAdmin = await authService.adminPasswordLogin("admin", "654321");
  const migrated = authService.changeAdminPassword(
    refreshedLegacyAdmin.token,
    "654321",
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
    tenantId: store.getUserTenantId(specialUser)!,
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
  const scopedSuperAdmin = authService.enterPlatformTenant(
    superAdmin.token,
    store.getDefaultTenantId()
  );
  const merchant = await authService.backofficeLogin("merchant", "merchant123");
  const merchantCredential = store.findBackofficeCredentialByUsername("merchant");
  assert.ok(merchantCredential);

  authService.resetBackofficePasswordAsSuperAdmin(scopedSuperAdmin.token, {
    userId: merchantCredential.userId,
    role: merchantCredential.role,
    newPassword: "merchant-new-password",
    reason: "受控测试重置"
  });

  assert.equal(store.getSession(merchant.token), undefined);
  const refreshedMerchant = await authService.backofficeLogin("merchant", "merchant-new-password");
  assert.equal(refreshedMerchant.user.id, merchant.user.id);
});

test("服务商代重置成功后解除目标用户名级登录失败锁定", async () => {
  const store = createIsolatedStore();
  const authService = createAuthService(store);
  const superAdmin = await authService.backofficeLogin("super", "super123");
  const scopedSuperAdmin = authService.enterPlatformTenant(
    superAdmin.token,
    store.getDefaultTenantId()
  );
  const merchantCredential =
    store.findBackofficeCredentialByUsername("merchant");
  assert.ok(merchantCredential);

  for (let attempt = 0; attempt < 5; attempt += 1) {
    await assert.rejects(
      () =>
        authService.backofficeLogin(
          "merchant",
          "definitely-wrong-password",
          `provider-reset-lock-source-${attempt}`
        ),
      /账号或密码不正确/
    );
  }

  authService.resetBackofficePasswordAsSuperAdmin(scopedSuperAdmin.token, {
    userId: merchantCredential.userId,
    role: merchantCredential.role,
    newPassword: "merchant-provider-reset",
    reason: "账号忘记密码，由服务商受控恢复"
  });

  const refreshedMerchant = await authService.backofficeLogin(
    "merchant",
    "merchant-provider-reset",
    "provider-reset-success-source"
  );
  assert.equal(refreshedMerchant.user.id, merchantCredential.userId);
});

test("服务提供商不能重置与当前人员身份不匹配的历史后台凭据", async () => {
  const store = createIsolatedStore();
  const authService = createAuthService(store);
  const superAdmin = await authService.backofficeLogin("super", "super123");
  const scopedSuperAdmin = authService.enterPlatformTenant(
    superAdmin.token,
    store.getDefaultTenantId()
  );
  const merchantCredential = store.findBackofficeCredentialByUsername("merchant");
  assert.ok(merchantCredential);

  store.upsertBackofficeCredential({
    ...merchantCredential,
    username: "historical-merchant-admin",
    role: "admin"
  });

  assert.throws(
    () =>
      authService.resetBackofficePasswordAsSuperAdmin(scopedSuperAdmin.token, {
        userId: merchantCredential.userId,
        role: "admin",
        newPassword: "historical-admin-new-password",
        reason: "历史凭据不能再作为当前身份使用"
      }),
    /目标后台账号与当前人员身份不匹配/
  );
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

test("实例管理员不能把人员管理等管理员权限授予商户账号", async () => {
  const store = createIsolatedStore();
  const authService = createAuthService(store);
  const admin = await authService.backofficeLogin("admin", "admin");
  const merchantCredential = store.findBackofficeCredentialByUsername("merchant");
  assert.ok(merchantCredential);

  assert.throws(
    () =>
      authService.createBackofficeCredential(admin.token, {
        userId: merchantCredential.userId,
        username: merchantCredential.username,
        role: "merchant",
        tenantId: merchantCredential.tenantId,
        permissions: ["merchant-workbench:view", "users:manage"]
      }),
    /不能发放目标后台身份不允许的权限/
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

test("账号本人找回密码成功后解除用户名级登录失败锁定", async () => {
  const store = createIsolatedStore();
  const verificationCodes = createVerificationCodeService(store);
  const authService = createAuthService(store, verificationCodes);
  const merchant = await authService.backofficeLogin("merchant", "merchant123");

  for (let attempt = 0; attempt < 5; attempt += 1) {
    await assert.rejects(
      () =>
        authService.backofficeLogin(
          "merchant",
          "definitely-wrong-password",
          `lock-test-source-${attempt}`
        ),
      /账号或密码不正确/
    );
  }

  const issued = await verificationCodes.requestCode(
    merchant.user.phone,
    "password-reset"
  );
  assert.ok(issued.previewCode);
  await authService.resetOwnBackofficePassword({
    username: "merchant",
    phone: merchant.user.phone,
    code: issued.previewCode,
    newPassword: "merchant-lock-cleared"
  });

  const refreshedMerchant = await authService.backofficeLogin(
    "merchant",
    "merchant-lock-cleared",
    "lock-test-success-source"
  );
  assert.equal(refreshedMerchant.user.id, merchant.user.id);
});

test("本人找回最终持久化失败时回滚密码、会话和验证码消费", async () => {
  const store = createIsolatedStore();
  const verificationCodes = createVerificationCodeService(store);
  const authService = createAuthService(store, verificationCodes);
  const merchant = await authService.backofficeLogin("merchant", "merchant123");
  const issued = await verificationCodes.requestCode(merchant.user.phone, "password-reset");
  const previewCode = issued.previewCode;
  assert.ok(previewCode);
  const merchantRecord = store.users.find(
    (entry) => entry.id === merchant.user.id
  );
  assert.ok(merchantRecord);
  const draftToken = store.createDraftSession({
    tenantId: store.getUserTenantId(merchantRecord)!,
    phone: merchant.user.phone,
    linkedUserId: merchant.user.id,
    requestedRole: merchantRecord.role
  });
  const originalPersist = store.persist.bind(store);

  store.persist = () => {
    throw new Error("injected-password-reset-persistence-failure");
  };

  await assert.rejects(
    () =>
      authService.resetOwnBackofficePassword({
        username: "merchant",
        phone: merchant.user.phone,
        code: previewCode,
        newPassword: "merchant-persist-retry"
      }),
    /injected-password-reset-persistence-failure/
  );

  store.persist = originalPersist;
  assert.ok(store.getSession(merchant.token));
  assert.ok(store.getDraftSession(draftToken));
  const oldPasswordSession = await authService.backofficeLogin("merchant", "merchant123");
  assert.equal(oldPasswordSession.user.id, merchant.user.id);

  const result = await authService.resetOwnBackofficePassword({
    username: "merchant",
    phone: merchant.user.phone,
    code: previewCode,
    newPassword: "merchant-persist-retry"
  });
  assert.deepEqual(result, { reset: true });
});

test("本人找回在数据文件已替换但耐久性未确认时保留新运行态", async () => {
  const store = createIsolatedStore();
  const verificationCodes = createVerificationCodeService(store);
  const authService = createAuthService(store, verificationCodes);
  const merchant = await authService.backofficeLogin("merchant", "merchant123");
  const issued = await verificationCodes.requestCode(merchant.user.phone, "password-reset");
  const previewCode = issued.previewCode;
  assert.ok(previewCode);
  const originalPersist = store.persist.bind(store);

  store.persist = () => {
    throw new PersistedStateWriteError(
      "injected-post-rename-durability-failure",
      true
    );
  };

  await assert.rejects(
    () =>
      authService.resetOwnBackofficePassword({
        username: "merchant",
        phone: merchant.user.phone,
        code: previewCode,
        newPassword: "merchant-committed-state"
      }),
    (error: unknown) =>
      error instanceof PersistedStateWriteError && error.committed
  );

  store.persist = originalPersist;
  assert.equal(store.getSession(merchant.token), undefined);
  await assert.rejects(
    () => authService.backofficeLogin("merchant", "merchant123"),
    /账号或密码不正确/
  );
  const newPasswordSession = await authService.backofficeLogin(
    "merchant",
    "merchant-committed-state"
  );
  assert.equal(newPasswordSession.user.id, merchant.user.id);
  assert.equal(
    (
      await verificationCodes.verifyCodeWithContext(
        merchant.user.phone,
        previewCode,
        "password-reset"
      )
    ).verified,
    false
  );
});

test("后台密码策略失败不会提前消费本人找回验证码", async () => {
  const store = createIsolatedStore();
  const verificationCodes = createVerificationCodeService(store);
  const authService = createAuthService(store, verificationCodes);
  const merchant = await authService.backofficeLogin("merchant", "merchant123");
  const issued = await verificationCodes.requestCode(merchant.user.phone, "password-reset");
  const previewCode = issued.previewCode;
  assert.ok(previewCode);

  await assert.rejects(
    () =>
      authService.resetOwnBackofficePassword({
        username: "merchant",
        phone: merchant.user.phone,
        code: previewCode,
        newPassword: "654321"
      }),
    /至少需要 8 位/
  );

  const result = await authService.resetOwnBackofficePassword({
    username: "merchant",
    phone: merchant.user.phone,
    code: previewCode,
    newPassword: "merchant-valid-reset"
  });
  assert.deepEqual(result, { reset: true });
});

test("新密码与当前密码相同时不会提前消费本人找回验证码", async () => {
  const store = createIsolatedStore();
  const verificationCodes = createVerificationCodeService(store);
  const authService = createAuthService(store, verificationCodes);
  const merchant = await authService.backofficeLogin("merchant", "merchant123");
  const issued = await verificationCodes.requestCode(merchant.user.phone, "password-reset");
  const previewCode = issued.previewCode;
  assert.ok(previewCode);

  await assert.rejects(
    () =>
      authService.resetOwnBackofficePassword({
        username: "merchant",
        phone: merchant.user.phone,
        code: previewCode,
        newPassword: "merchant123"
      }),
    /新密码不能与当前密码相同/
  );

  const result = await authService.resetOwnBackofficePassword({
    username: "merchant",
    phone: merchant.user.phone,
    code: previewCode,
    newPassword: "merchant-retry-reset"
  });
  assert.deepEqual(result, { reset: true });
});

test("本人找回拒绝历史角色凭据且不消费可用于当前身份的验证码", async () => {
  const store = createIsolatedStore();
  const verificationCodes = createVerificationCodeService(store);
  const authService = createAuthService(store, verificationCodes);
  const merchant = await authService.backofficeLogin("merchant", "merchant123");
  const merchantCredential = store.findBackofficeCredentialByUsername("merchant");
  assert.ok(merchantCredential);
  store.upsertBackofficeCredential({
    ...merchantCredential,
    username: "historical-owner-admin",
    role: "admin"
  });
  const issued = await verificationCodes.requestCode(merchant.user.phone, "password-reset");
  const previewCode = issued.previewCode;
  assert.ok(previewCode);

  await assert.rejects(
    () =>
      authService.resetOwnBackofficePassword({
        username: "historical-owner-admin",
        phone: merchant.user.phone,
        code: previewCode,
        newPassword: "historical-owner-reset"
      }),
    /账号、手机号或验证码不正确/
  );

  const result = await authService.resetOwnBackofficePassword({
    username: "merchant",
    phone: merchant.user.phone,
    code: previewCode,
    newPassword: "merchant-current-role-reset"
  });
  assert.deepEqual(result, { reset: true });
});

test("登录和本人找回拒绝仍指向其他实例的同角色历史凭据", async () => {
  const store = createIsolatedStore();
  const verificationCodes = createVerificationCodeService(store);
  const authService = createAuthService(store, verificationCodes);
  const merchant = await authService.backofficeLogin("merchant", "merchant123");
  const merchantCredential = store.findBackofficeCredentialByUsername("merchant");
  assert.ok(merchantCredential);
  const currentTenantId = merchantCredential.tenantId;
  merchantCredential.tenantId = "tenant-historical-owner";
  const issued = await verificationCodes.requestCode(merchant.user.phone, "password-reset");
  const previewCode = issued.previewCode;
  assert.ok(previewCode);

  await assert.rejects(
    () => authService.backofficeLogin("merchant", "merchant123"),
    /账号或密码不正确/
  );
  await assert.rejects(
    () =>
      authService.resetOwnBackofficePassword({
        username: "merchant",
        phone: merchant.user.phone,
        code: previewCode,
        newPassword: "merchant-cross-tenant-reset"
      }),
    /账号、手机号或验证码不正确/
  );

  merchantCredential.tenantId = currentTenantId;
  const result = await authService.resetOwnBackofficePassword({
    username: "merchant",
    phone: merchant.user.phone,
    code: previewCode,
    newPassword: "merchant-current-tenant-reset"
  });
  assert.deepEqual(result, { reset: true });
});

test("多实例旧快照不能用后台凭据反向补写缺失的人员归属", async () => {
  const store = createIsolatedStore();
  const defaultTenant = store.platformTenants[0];
  const adminCredential = store.findBackofficeCredentialByUsername("admin");
  assert.ok(defaultTenant);
  assert.ok(adminCredential);
  store.platformTenants.push({
    ...defaultTenant,
    id: "tenant-migration-target",
    code: "tenant-migration-target",
    name: "迁移攻击目标实例",
    instanceUrl: "https://tenant-migration-target.example.test"
  });
  store.users.push({
    id: "legacy-ambiguous-admin",
    role: "admin",
    phone: "18800000098",
    name: "缺失归属的旧管理员",
    status: "active",
    tags: [],
    mobileProfileCompleted: true
  });
  store.backofficeCredentials.push({
    ...adminCredential,
    userId: "legacy-ambiguous-admin",
    username: "legacy-ambiguous-admin",
    tenantId: "tenant-migration-target"
  });
  store.persist();

  const restartedStore = new InMemoryStoreService();
  const restartedUser = restartedStore.users.find(
    (entry) => entry.id === "legacy-ambiguous-admin"
  );
  const restartedAuth = createAuthService(restartedStore);
  assert.ok(restartedUser);
  assert.equal(restartedUser.tenantId, undefined);
  await assert.rejects(
    () =>
      restartedAuth.backofficeLogin(
        "legacy-ambiguous-admin",
        "admin"
      ),
    /账号或密码不正确/
  );
});

test("普通实例管理员不能借历史 super_admin 凭据提权或找回服务商密码", async () => {
  const store = createIsolatedStore();
  const verificationCodes = createVerificationCodeService(store);
  const authService = createAuthService(store, verificationCodes);
  const admin = await authService.backofficeLogin("admin", "admin");
  const adminCredential = store.findBackofficeCredentialByUsername("admin");
  assert.ok(adminCredential);
  store.upsertBackofficeCredential({
    ...adminCredential,
    username: "historical-provider-admin",
    role: "super_admin",
    tenantId: undefined
  });
  const issued = await verificationCodes.requestCode(
    admin.user.phone,
    "password-reset"
  );
  const previewCode = issued.previewCode;
  assert.ok(previewCode);

  await assert.rejects(
    () =>
      authService.backofficeLogin(
        "historical-provider-admin",
        "admin"
      ),
    /账号或密码不正确/
  );
  await assert.rejects(
    () =>
      authService.resetOwnBackofficePassword({
        username: "historical-provider-admin",
        phone: admin.user.phone,
        code: previewCode,
        newPassword: "historical-provider-reset"
      }),
    /账号、手机号或验证码不正确/
  );

  const result = await authService.resetOwnBackofficePassword({
    username: "admin",
    phone: admin.user.phone,
    code: previewCode,
    newPassword: "historical-provider-reset"
  });
  assert.deepEqual(result, { reset: true });
});

test("初始实例管理员通过绑定手机号找回密码时沿用已授权的六位密码策略", async () => {
  const store = createIsolatedStore();
  const verificationCodes = createVerificationCodeService(store);
  const authService = createAuthService(store, verificationCodes);
  const admin = await authService.backofficeLogin("admin", "admin");
  const issued = await verificationCodes.requestCode(admin.user.phone, "password-reset");
  assert.ok(issued.previewCode);

  const result = await authService.resetOwnBackofficePassword({
    username: "admin",
    phone: admin.user.phone,
    code: issued.previewCode,
    newPassword: "654321"
  });

  assert.deepEqual(result, { reset: true });
  assert.equal(store.getSession(admin.token), undefined);
  const refreshedAdmin = await authService.backofficeLogin("admin", "654321");
  assert.equal(refreshedAdmin.user.id, admin.user.id);
});

test("删除用户时立即撤销关联会话和资料草稿", () => {
  const store = createIsolatedStore();
  const usersService = new UsersService(store, {} as never, {} as never);
  const user = store.users.find((entry) => entry.role === "special" && entry.status === "active");
  assert.ok(user);
  const token = store.createSession(user);
  const draftToken = store.createDraftSession({
    tenantId: store.getUserTenantId(user)!,
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

test("mock 验证结果只可消费校验时绑定的同一代挑战", async () => {
  const store = createIsolatedStore();
  const verificationCodes = createVerificationCodeService(store);
  const phone = "13812345679";
  const firstCode = store.issueVerificationCode(phone, "password-reset");
  const checked = await verificationCodes.checkCodeWithContext(
    phone,
    firstCode,
    "password-reset"
  );
  assert.equal(checked.verified, true);

  const secondCode = store.issueVerificationCode(phone, "password-reset");
  assert.notEqual(secondCode, firstCode);
  assert.equal(
    verificationCodes.consumeCheckedCode(phone, "password-reset", checked),
    false
  );
  assert.equal(
    (
      await verificationCodes.verifyCodeWithContext(
        phone,
        secondCode,
        "password-reset"
      )
    ).verified,
    true
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

test("全真模拟 manual 模式只接受后台签发短期码，不接受静态通用验证码", async () => {
  const store = createIsolatedStore();
  const service = new VerificationCodeService(
    {
      get: (key: string) =>
        ({
          VM_DATA_PLANE: "simulation",
          VM_SIMULATION_PROFILE: "full",
          VM_FULL_SIMULATION_VERIFICATION_MODE: "manual",
          VERIFICATION_CODE_PROVIDER: "mock"
        })[key]
    } as never,
    store
  );

  await assert.rejects(
    () => service.requestCode("13812345684", "app-login"),
    /后台签发/
  );
  assert.equal(
    await service.verifyCode("13812345684", "246810", "app-login"),
    false
  );
  assert.equal(store.getVerificationRecord("13812345684", "app-login"), undefined);

  const targetUser = store.users.find(
    (entry) =>
      entry.status === "active" &&
      store.getUserTenantId(entry) !== undefined
  );
  assert.ok(targetUser);
  const targetTenantId = store.getUserTenantId(targetUser);
  assert.ok(targetTenantId);
  store.issueManualVerificationGrant({
    phone: targetUser.phone,
    purpose: "app-login",
    code: "654321",
    issuerUserId: "manual-mode-test-issuer",
    targetUserId: targetUser.id,
    tenantId: targetTenantId,
    expiresInSeconds: 300
  });
  assert.equal(
    await service.verifyCode(targetUser.phone, "654321", "app-login"),
    true
  );
});

test("本机 admin 密码恢复允许非默认账号、仅恢复唯一 admin 并撤销旧会话", () => {
  const store = createIsolatedStore();
  const initialPassword = "662931";
  initializeFirstBackofficePassword(store, initialPassword);
  const credential = store.findBackofficeCredentialByUsername("admin");
  const user = store.users.find((entry) => entry.id === credential?.userId);
  assert.ok(credential);
  assert.ok(user);

  const existingSession = store.createBackofficeSession(user, credential.role, credential.tenantId);
  const recoveredPassword = "993216";
  assert.equal(MIN_ADMIN_BACKOFFICE_PASSWORD_RECOVERY_LENGTH, 6);
  const result = recoverAdminBackofficePassword(store, recoveredPassword);

  assert.equal(result.credential.username, "admin");
  assert.equal(result.credential.role, "admin");
  assert.equal(result.credential.usesDefaultPassword, false);
  assert.equal(
    verifyAdminPassword(
      recoveredPassword,
      result.credential.passwordSalt,
      result.credential.passwordHash
    ),
    true
  );
  assert.equal(store.getSession(existingSession), undefined);
  assert.ok(
    store.logs.some(
      (entry) =>
        entry.type === "recover-admin-backoffice-password" &&
        entry.metadata?.recoveryMethod === "local-tty"
    )
  );
  assert.throws(
    () =>
      recoverAdminBackofficePassword(
        createIsolatedStore(),
        "x".repeat(MIN_ADMIN_BACKOFFICE_PASSWORD_RECOVERY_LENGTH - 1)
      ),
    /至少需要/u
  );
});

test("历史脏数据出现重复手机号时，公共登录必须失败关闭而不能选取首个租户账号", async () => {
  const store = createIsolatedStore();
  const original = store.users.find((entry) => entry.status === "active");
  assert.ok(original);
  store.users.push({
    ...structuredClone(original),
    id: `${original.id}-duplicate`,
    tenantId: "tenant-duplicate"
  });
  const authService = createAuthService(store);

  await assert.rejects(
    () => authService.appLogin(original.phone, "123456"),
    /账号身份异常|验证码不正确/
  );
  await assert.rejects(
    () => authService.mobileLogin(original.phone, "123456"),
    /账号身份异常|手机号或验证码不正确/
  );
});

test("PNVS 只校验由本应用 PNVS 发码创建的挑战", async () => {
  const store = createIsolatedStore();
  const phone = "13812345685";
  store.issueVerificationCode(phone, "app-login");

  const pnvsService = new VerificationCodeService(
    {
      get: (key: string) =>
        ({
          VERIFICATION_CODE_PROVIDER: "aliyun_pnvs",
          ALIYUN_PNVS_ACCESS_KEY_ID: "test-access-key",
          ALIYUN_PNVS_ACCESS_KEY_SECRET: "test-access-secret"
        })[key]
    } as never,
    store
  );
  let checkCalls = 0;
  (
    pnvsService as unknown as {
      createAliyunPnvsClient: () => {
        checkSmsVerifyCode: () => Promise<unknown>;
      };
    }
  ).createAliyunPnvsClient = () => ({
    checkSmsVerifyCode: async () => {
      checkCalls += 1;
      return {
        body: { code: "OK", success: true, model: { verifyResult: "PASS" } }
      };
    }
  });

  assert.equal(await pnvsService.verifyCode(phone, "123456", "app-login"), false);
  assert.equal(checkCalls, 0);
});

test("PNVS 旧校验结果不能授权或消费重新发送的新挑战", async () => {
  const store = createIsolatedStore();
  const phone = "13812345686";
  let now = Date.now();
  const originalDateNow = Date.now;
  Date.now = () => now;

  try {
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
    let checkCalls = 0;
    let markFirstCheckStarted!: () => void;
    const firstCheckStarted = new Promise<void>((resolve) => {
      markFirstCheckStarted = resolve;
    });
    let resolveFirstCheck!: (response: unknown) => void;
    const firstCheckResponse = new Promise<unknown>((resolve) => {
      resolveFirstCheck = resolve;
    });
    (
      service as unknown as {
        createAliyunPnvsClient: () => {
          sendSmsVerifyCode: () => Promise<unknown>;
          checkSmsVerifyCode: () => Promise<unknown>;
        };
      }
    ).createAliyunPnvsClient = () => ({
      sendSmsVerifyCode: async () => ({ body: { code: "OK", success: true } }),
      checkSmsVerifyCode: async () => {
        checkCalls += 1;
        if (checkCalls === 1) {
          markFirstCheckStarted();
          return firstCheckResponse;
        }
        return {
          body: { code: "OK", success: true, model: { verifyResult: "PASS" } }
        };
      }
    });

    await service.requestCode(phone, "app-login");
    const firstVerification = service.verifyCode(phone, "123456", "app-login");
    await firstCheckStarted;

    now += 61_000;
    await service.requestCode(phone, "app-login");
    resolveFirstCheck({
      body: { code: "OK", success: true, model: { verifyResult: "PASS" } }
    });

    assert.equal(await firstVerification, false);
    assert.equal(await service.verifyCode(phone, "654321", "app-login"), true);
    assert.equal(checkCalls, 2);
  } finally {
    Date.now = originalDateNow;
  }
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
  store.rememberVerificationRequest(phone, "app-login", "aliyun_pnvs");
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

test("阿里云 PNVS 上游异常统一为 503，且不泄露供应商细节", async () => {
  const store = createIsolatedStore();
  const upstreamDetail = "provider-internal-recommendation";
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
        sendSmsVerifyCode: () => Promise<unknown>;
        checkSmsVerifyCode: () => Promise<unknown>;
      };
    }
  ).createAliyunPnvsClient = () => ({
    sendSmsVerifyCode: async () => ({ body: { code: "OK", success: true } }),
    checkSmsVerifyCode: async () => ({
      body: { code: "ProviderError", success: false, message: upstreamDetail }
    })
  });

  const phone = "13812345689";
  await service.requestCode(phone, "app-login");
  await assert.rejects(
    () => service.verifyCode(phone, "123456", "app-login"),
    (error: unknown) => {
      assert.ok(error instanceof ServiceUnavailableException);
      assert.equal(error.getStatus(), 503);
      assert.doesNotMatch(JSON.stringify(error.getResponse()), new RegExp(upstreamDetail));
      return true;
    }
  );
  assert.equal(store.canAttemptVerification(phone, "app-login"), true);
});

test("真实 PNVS 挑战在 API 重启后仍可校验，并在未登记时进入注册分支", async () => {
  const directory = createTemporaryDirectory("vm-pnvs-restart-");
  process.env.API_DATA_FILE = join(directory, "store.json");
  process.env.ENABLE_TEST_DEVICE_BOOTSTRAP = "false";
  process.env.NODE_ENV = "test";
  const phone = "13812345687";
  const code = "123456";
  const config = {
    get: (key: string) =>
      ({
        VERIFICATION_CODE_PROVIDER: "aliyun_pnvs",
        ALIYUN_PNVS_ACCESS_KEY_ID: "test-access-key",
        ALIYUN_PNVS_ACCESS_KEY_SECRET: "test-access-secret",
        ALIYUN_PNVS_SIGN_NAME: "test-sign",
        ALIYUN_PNVS_TEMPLATE_CODE: "test-template"
      })[key]
  } as never;

  const sendingStore = new InMemoryStoreService();
  const sendingService = new VerificationCodeService(config, sendingStore);
  (
    sendingService as unknown as {
      createAliyunPnvsClient: () => {
        sendSmsVerifyCode: () => Promise<unknown>;
      };
    }
  ).createAliyunPnvsClient = () => ({
    sendSmsVerifyCode: async () => ({ body: { code: "OK", success: true } })
  });

  await sendingService.requestCode(phone, "app-login");
  sendingStore.persist();

  const persistedText = readFileSync(process.env.API_DATA_FILE, "utf8");
  const persistedState = JSON.parse(persistedText) as {
    verificationCodes: Array<
      [
        string,
        {
          code?: string;
          externalChallenge?: boolean;
          externalProvider?: string;
          externalChallengeId?: string;
        }
      ]
    >;
  };
  assert.equal(persistedState.verificationCodes.length, 1);
  assert.match(persistedState.verificationCodes[0][0], /^challenge:v1:[a-f0-9]{64}$/);
  assert.equal(persistedState.verificationCodes[0][1].externalChallenge, true);
  assert.equal(
    persistedState.verificationCodes[0][1].externalProvider,
    "aliyun_pnvs"
  );
  assert.match(
    persistedState.verificationCodes[0][1].externalChallengeId ?? "",
    /^challenge_[A-Za-z0-9_-]{43}$/
  );
  assert.equal(persistedState.verificationCodes[0][1].code, "");
  assert.doesNotMatch(persistedText, new RegExp(`${phone}|${code}`));

  const restartedStore = new InMemoryStoreService();
  const checkingService = new VerificationCodeService(config, restartedStore);
  let checkCalls = 0;
  (
    checkingService as unknown as {
      createAliyunPnvsClient: () => {
        checkSmsVerifyCode: () => Promise<unknown>;
      };
    }
  ).createAliyunPnvsClient = () => ({
    checkSmsVerifyCode: async () => {
      checkCalls += 1;
      return {
        body: { code: "OK", success: true, model: { verifyResult: "PASS" } }
      };
    }
  });
  const authService = createAuthService(restartedStore, checkingService);

  const result = await authService.appLogin(phone, code);
  assert.equal(result.state, "not_registered");
  assert.equal(checkCalls, 1);
  await assert.rejects(
    () => authService.appLogin(phone, code),
    /验证码不正确或已失效/
  );
  assert.equal(checkCalls, 1);
  assert.equal(
    await checkingService.verifyCode("13812345688", code, "app-login"),
    false
  );
  assert.equal(checkCalls, 1);

  const secondRestartStore = new InMemoryStoreService();
  const secondRestartService = new VerificationCodeService(config, secondRestartStore);
  let secondRestartCheckCalls = 0;
  (
    secondRestartService as unknown as {
      verifyAliyunPnvsCode: () => Promise<boolean>;
    }
  ).verifyAliyunPnvsCode = async () => {
    secondRestartCheckCalls += 1;
    return true;
  };
  await assert.rejects(
    () => createAuthService(secondRestartStore, secondRestartService).appLogin(phone, code),
    /验证码不正确或已失效/
  );
  assert.equal(secondRestartCheckCalls, 0);
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
