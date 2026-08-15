import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after } from "node:test";

import { ConfigService } from "@nestjs/config";

import { InMemoryStoreService } from "../src/common/store/in-memory-store.service";
import { AuthService } from "../src/modules/auth/auth.service";
import { RegistrationApplicationsService } from "../src/modules/registration-applications/registration-applications.service";

const temporaryDirectories: string[] = [];

after(() => {
  for (const directory of temporaryDirectories) {
    rmSync(directory, { recursive: true, force: true });
  }
});

const createHarness = () => {
  const directory = mkdtempSync(join(tmpdir(), "vm-unified-mobile-auth-"));
  temporaryDirectories.push(directory);
  process.env.API_DATA_FILE = join(directory, "store.json");
  process.env.ENABLE_TEST_DEVICE_BOOTSTRAP = "false";
  process.env.NODE_ENV = "test";

  const store = new InMemoryStoreService();
  const verificationCodeService = {
    requestCode: async (phone: string) => ({
      phone,
      expiresInSeconds: 300,
      provider: "mock" as const
    }),
    verifyCode: async () => true,
    verifyCodeWithContext: async () => ({
      verified: true,
      provider: "mock" as const
    })
  };
  const config = new ConfigService({
    PUBLIC_ADMIN_REGISTRATION_ENABLED: "false"
  });
  const registrationApplicationsService = new RegistrationApplicationsService(
    store,
    verificationCodeService as never,
    config
  );
  const authService = new AuthService(
    {
      findByPhone: (phone: string) =>
        store.users.find((entry) => entry.phone === phone && entry.status === "active"),
      findById: (userId: string) => store.users.find((entry) => entry.id === userId)
    } as never,
    {
      getQuotaSummaryForUser: () => undefined
    } as never,
    registrationApplicationsService,
    store,
    verificationCodeService as never,
    config
  );

  return {
    authService,
    registrationApplicationsService,
    store
  };
};

test("一次验证码识别到后台导入账号后直接进入预填资料确认", async () => {
  const { authService, store } = createHarness();
  const importedUser = store.users.find(
    (entry) =>
      entry.role === "special" &&
      entry.status === "active" &&
      entry.mobileProfileCompleted === false
  );
  assert.ok(importedUser);

  const result = await authService.appLogin(importedUser.phone, "123456");

  assert.equal(result.state, "needs_profile");
  if (result.state !== "needs_profile") {
    return;
  }
  assert.equal(result.isExistingUser, true);
  assert.equal(result.role, importedUser.role);
  assert.equal(result.profile?.name, importedUser.name);
  assert.equal(result.profile?.regionId, importedUser.regionId);
  assert.equal(result.profile?.regionName, importedUser.regionName);
  assert.equal(result.draft.linkedUserId, importedUser.id);
  assert.equal(store.getSessionUser(result.draft.token), undefined);
});

test("新用户提交资料后审核凭证跨服务重启保活且仍不能访问业务会话", async () => {
  const { authService, store } = createHarness();
  const phone = "13700009991";
  const loginResult = await authService.appLogin(phone, "123456");
  assert.equal(loginResult.state, "needs_profile");
  if (loginResult.state !== "needs_profile") {
    return;
  }
  assert.equal(loginResult.role, undefined);
  assert.equal(loginResult.draft.requestedRole, undefined);
  assert.equal(loginResult.profile, undefined);

  const submitted = authService.submitMobileProfile({
    draftToken: loginResult.draft.token,
    requestedRole: "special",
    profile: {
      name: "待审核用户",
      neighborhood: "扬名街道",
      regionId: store.regions[0]?.id,
      regionName: store.regions[0]?.name ?? "扬名街道"
    }
  });
  assert.equal(submitted.state, "pending_review");
  if (submitted.state !== "pending_review") {
    return;
  }
  const onboardingToken = submitted.draft.token;
  assert.equal(store.getSessionUser(onboardingToken), undefined);
  store.persist();

  const restartedStore = new InMemoryStoreService();
  const restartedRegistrationApplicationsService = new RegistrationApplicationsService(
    restartedStore,
    {
      verifyCode: async () => true
    } as never,
    new ConfigService({ PUBLIC_ADMIN_REGISTRATION_ENABLED: "false" })
  );
  const restartedAuthService = new AuthService(
    {
      findByPhone: (candidate: string) =>
        restartedStore.users.find((entry) => entry.phone === candidate && entry.status === "active"),
      findById: (userId: string) => restartedStore.users.find((entry) => entry.id === userId)
    } as never,
    { getQuotaSummaryForUser: () => undefined } as never,
    restartedRegistrationApplicationsService,
    restartedStore,
    {} as never,
    new ConfigService({ PUBLIC_ADMIN_REGISTRATION_ENABLED: "false" })
  );

  const restored = restartedAuthService.getAppSession(onboardingToken);
  assert.equal(restored.state, "pending_review");
  assert.equal(restartedStore.getSessionUser(onboardingToken), undefined);
  const persistedText = readFileSync(process.env.API_DATA_FILE!, "utf8");
  assert.equal(persistedText.includes(onboardingToken), false);
  assert.equal(persistedText.includes(phone), true);
});

test("预导入账号确认时不能改写身份和片区", async () => {
  const { authService, store } = createHarness();
  const importedUser = store.users.find(
    (entry) =>
      entry.role === "special" &&
      entry.status === "active" &&
      entry.mobileProfileCompleted === false &&
      Boolean(entry.regionId)
  );
  assert.ok(importedUser);
  const originalRegionId = importedUser.regionId;
  const originalRegionName = importedUser.regionName;
  const originalNeighborhood = importedUser.neighborhood;
  const loginResult = await authService.appLogin(importedUser.phone, "123456");
  assert.equal(loginResult.state, "needs_profile");
  if (loginResult.state !== "needs_profile") {
    return;
  }

  const confirmed = authService.submitMobileProfile({
    draftToken: loginResult.draft.token,
    requestedRole: "merchant",
    profile: {
      name: importedUser.name,
      neighborhood: "被篡改片区",
      regionId: "region-tampered",
      regionName: "被篡改片区"
    }
  });
  assert.equal(confirmed.state, "approved");
  assert.equal(importedUser.role, "special");
  assert.equal(importedUser.regionId, originalRegionId);
  assert.equal(importedUser.regionName, originalRegionName);
  assert.equal(importedUser.neighborhood, originalNeighborhood);
});

test("审核通过后原审核凭证自动升级为永久移动端会话", async () => {
  const { authService, registrationApplicationsService, store } = createHarness();
  const loginResult = await authService.appLogin("13700009992", "123456");
  assert.equal(loginResult.state, "needs_profile");
  if (loginResult.state !== "needs_profile") {
    return;
  }
  const submitted = authService.submitMobileProfile({
    draftToken: loginResult.draft.token,
    requestedRole: "special",
    profile: {
      name: "审核通过用户",
      neighborhood: store.regions[0]?.name,
      regionId: store.regions[0]?.id,
      regionName: store.regions[0]?.name
    }
  });
  assert.equal(submitted.state, "pending_review");
  if (submitted.state !== "pending_review") {
    return;
  }
  registrationApplicationsService.review(submitted.application.id, {
    decision: "approved"
  });
  store.persist();

  const upgraded = authService.getAppSession(submitted.draft.token);
  assert.equal(upgraded.state, "approved");
  if (upgraded.state !== "approved") {
    return;
  }
  assert.equal(upgraded.token, submitted.draft.token);
  assert.equal(store.getSessionUser(upgraded.token)?.phone, submitted.application.phone);
  assert.equal(store.getOnboardingSession(submitted.draft.token), undefined);

  const retriedAfterLostResponse = authService.getAppSession(submitted.draft.token);
  assert.equal(retriedAfterLostResponse.state, "approved");
  if (retriedAfterLostResponse.state !== "approved") {
    return;
  }
  assert.equal(retriedAfterLostResponse.token, submitted.draft.token);
  store.persist();

  const restartedStore = new InMemoryStoreService();
  assert.equal(
    restartedStore.getSessionUser(submitted.draft.token)?.phone,
    submitted.application.phone
  );
});

test("审核凭证不能升级为其他实例的用户会话", async () => {
  const { authService, registrationApplicationsService, store } = createHarness();
  const loginResult = await authService.appLogin("13700009994", "123456");
  assert.equal(loginResult.state, "needs_profile");
  if (loginResult.state !== "needs_profile") return;
  const submitted = authService.submitMobileProfile({
    draftToken: loginResult.draft.token,
    requestedRole: "special",
    profile: {
      name: "跨实例审核测试",
      regionId: store.regions[0]?.id,
      regionName: store.regions[0]?.name,
      neighborhood: store.regions[0]?.name
    }
  });
  assert.equal(submitted.state, "pending_review");
  if (submitted.state !== "pending_review") return;
  registrationApplicationsService.review(submitted.application.id, {
    decision: "approved"
  });
  const linkedUser = store.users.find((entry) => entry.id === submitted.application.linkedUserId);
  assert.ok(linkedUser);
  linkedUser.tenantId = "tenant-other";

  assert.throws(
    () => authService.getAppSession(submitted.draft.token),
    /审核结果缺少可用账号/
  );
  assert.ok(store.getOnboardingSession(submitted.draft.token));
  assert.equal(store.getSessionUser(submitted.draft.token), undefined);
});

test("审核驳回后凭原审核凭证修改资料并重新提交，不再接收第二次验证码", async () => {
  const { authService, registrationApplicationsService, store } = createHarness();
  const loginResult = await authService.appLogin("13700009993", "123456");
  assert.equal(loginResult.state, "needs_profile");
  if (loginResult.state !== "needs_profile") return;

  const submitted = authService.submitMobileProfile({
    draftToken: loginResult.draft.token,
    requestedRole: "special",
    profile: {
      name: "待补资料用户",
      regionId: store.regions[0]?.id,
      regionName: store.regions[0]?.name,
      neighborhood: store.regions[0]?.name
    }
  });
  assert.equal(submitted.state, "pending_review");
  if (submitted.state !== "pending_review") return;
  registrationApplicationsService.review(submitted.application.id, {
    decision: "rejected",
    reason: "请补充备注"
  });

  const resubmitted = authService.submitMobileProfile({
    draftToken: submitted.draft.token,
    requestedRole: "special",
    profile: {
      ...submitted.application.profile,
      note: "已补充"
    }
  });
  assert.equal(resubmitted.state, "pending_review");
  if (resubmitted.state !== "pending_review") return;
  assert.equal(resubmitted.application.status, "pending");
  assert.equal(resubmitted.application.profile.note, "已补充");
  assert.notEqual(resubmitted.draft.token, submitted.draft.token);
  assert.equal(store.getOnboardingSession(submitted.draft.token), undefined);
});
