import "reflect-metadata";

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after } from "node:test";

import type { ExecutionContext } from "@nestjs/common";
import { ForbiddenException, UnauthorizedException } from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import type { BackofficePermission, UserRole } from "@vm/shared-types";

import { RoleGuard } from "../src/common/guards/role.guard";
import { InMemoryStoreService } from "../src/common/store/in-memory-store.service";
import { AlertsController } from "../src/modules/alerts/alerts.controller";
import { AuthService } from "../src/modules/auth/auth.service";
import { CabinetEventsController } from "../src/modules/cabinet-events/cabinet-events.controller";
import { DevicesController } from "../src/modules/devices/devices.controller";
import { OperationLogsController } from "../src/modules/operation-logs/operation-logs.controller";
import { LegacyRefundController } from "../src/modules/payments/legacy-refund.controller";
import { PaymentsController } from "../src/modules/payments/payments.controller";
import { RegistrationApplicationsController } from "../src/modules/registration-applications/registration-applications.controller";
import { RegistrationApplicationsService } from "../src/modules/registration-applications/registration-applications.service";
import { ReservationsController } from "../src/modules/reservations/reservations.controller";
import { SpecialAccessPoliciesController } from "../src/modules/special-access-policies/special-access-policies.controller";
import { UsersController } from "../src/modules/users/users.controller";

interface ControllerConstructor {
  readonly name: string;
  readonly prototype: object;
}

interface RouteTarget {
  controller: ControllerConstructor;
  method: string;
  label: string;
}

interface SharedBackofficePermissionRoute extends RouteTarget {
  permission: BackofficePermission;
}

interface RouteRequest {
  headers: Record<string, string | undefined>;
  query: Record<string, string | undefined>;
  body: Record<string, unknown>;
  authUser?: {
    id: string;
    role: UserRole;
    name: string;
    permissions?: BackofficePermission[];
  };
}

const temporaryDirectories: string[] = [];
const originalEnvironment = {
  API_DATA_FILE: process.env.API_DATA_FILE,
  ENABLE_TEST_DEVICE_BOOTSTRAP: process.env.ENABLE_TEST_DEVICE_BOOTSTRAP
};

const createIsolatedStore = () => {
  const directory = mkdtempSync(join(tmpdir(), "vm-mobile-admin-route-"));
  temporaryDirectories.push(directory);
  process.env.API_DATA_FILE = join(directory, "store.json");
  process.env.ENABLE_TEST_DEVICE_BOOTSTRAP = "false";
  return new InMemoryStoreService();
};

after(() => {
  for (const [key, value] of Object.entries(originalEnvironment)) {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }

  for (const directory of temporaryDirectories) {
    rmSync(directory, { recursive: true, force: true });
  }
});

const mobileAdminRoutes: RouteTarget[] = [
  { controller: RegistrationApplicationsController, method: "list", label: "注册申请列表" },
  { controller: RegistrationApplicationsController, method: "review", label: "注册申请审核" },
  { controller: UsersController, method: "list", label: "人员列表" },
  { controller: UsersController, method: "detail", label: "人员详情" },
  { controller: UsersController, method: "updateUser", label: "人员基础信息更新" },
  { controller: UsersController, method: "batchUpdate", label: "人员批量更新" },
  { controller: UsersController, method: "manualAdjustment", label: "人员库存手工调整" },
  { controller: SpecialAccessPoliciesController, method: "list", label: "领取策略列表" },
  { controller: SpecialAccessPoliciesController, method: "batchAssign", label: "领取策略批量绑定" },
  { controller: DevicesController, method: "monitoring", label: "柜机监控" },
  { controller: DevicesController, method: "refresh", label: "柜机状态刷新" },
  { controller: AlertsController, method: "resolve", label: "告警处理" },
  { controller: OperationLogsController, method: "list", label: "操作日志列表" },
  { controller: OperationLogsController, method: "detail", label: "操作日志详情" },
  { controller: OperationLogsController, method: "undo", label: "操作日志撤销" }
];

const backofficeOnlyRoutes: RouteTarget[] = [
  { controller: RegistrationApplicationsController, method: "detail", label: "未被移动端使用的申请详情" },
  { controller: UsersController, method: "createUser", label: "创建人员" },
  { controller: UsersController, method: "removeUser", label: "删除人员" },
  { controller: UsersController, method: "batchRemove", label: "批量删除人员" },
  { controller: UsersController, method: "importUsers", label: "导入人员" },
  { controller: UsersController, method: "saveAccessPolicy", label: "创建个人领取策略" },
  { controller: SpecialAccessPoliciesController, method: "create", label: "创建策略模板" },
  { controller: SpecialAccessPoliciesController, method: "update", label: "修改策略模板" },
  { controller: CabinetEventsController, method: "manualSettlementCandidates", label: "缺失结算候选" },
  { controller: CabinetEventsController, method: "createManualSettlement", label: "人工结算补记" },
  { controller: CabinetEventsController, method: "linkManualSettlementOrder", label: "人工结算订单号后补" },
  { controller: CabinetEventsController, method: "completeManualSettlementPlatform", label: "人工结算平台回写" },
  { controller: CabinetEventsController, method: "revertManualSettlement", label: "人工结算撤销" },
  { controller: CabinetEventsController, method: "resolveManualSettlementConflict", label: "人工结算冲突处理" },
  { controller: DevicesController, method: "remoteOpen", label: "远程开门" },
  { controller: PaymentsController, method: "refund", label: "支付退款" },
  { controller: PaymentsController, method: "reconcileOrder", label: "支付主动核对" },
  { controller: PaymentsController, method: "reconcileRefund", label: "退款主动核对" },
  { controller: PaymentsController, method: "closeUnpaidOrder", label: "未支付订单关单" },
  { controller: LegacyRefundController, method: "refund", label: "兼容业务订单退款" },
  { controller: OperationLogsController, method: "export", label: "操作日志导出" },
  { controller: OperationLogsController, method: "exportSystemFile", label: "系统审计导出" },
  { controller: OperationLogsController, method: "systemAudit", label: "系统审计查看" }
];

const sharedBackofficePermissionRoutes: SharedBackofficePermissionRoute[] = [
  {
    controller: CabinetEventsController,
    method: "list",
    label: "柜机事件列表",
    permission: "operation-logs:view"
  },
  {
    controller: CabinetEventsController,
    method: "detail",
    label: "柜机事件详情",
    permission: "operation-logs:view"
  },
  {
    controller: ReservationsController,
    method: "cancel",
    label: "管理员取消预约",
    permission: "reservations:manage"
  }
];

const authorizeRoute = (
  store: InMemoryStoreService,
  target: RouteTarget,
  token: string
) => {
  const prototype = target.controller.prototype as Record<string, unknown>;
  const handler = prototype[target.method];
  assert.equal(typeof handler, "function", `${target.label} 缺少对应控制器方法`);

  const request: RouteRequest = {
    headers: { authorization: `Bearer ${token}` },
    query: {},
    body: {}
  };
  const context = {
    getClass: () => target.controller,
    getHandler: () => handler,
    switchToHttp: () => ({
      getRequest: () => request
    })
  } as unknown as ExecutionContext;
  const guard = new RoleGuard(new Reflector(), store);

  return {
    allowed: guard.canActivate(context),
    request
  };
};

test("普通移动管理员会话可访问移动管理页映射的业务接口", () => {
  const store = createIsolatedStore();
  const admin = store.users.find(
    (entry) =>
      entry.role === "admin" &&
      entry.status === "active" &&
      Boolean(store.findAdminCredentialByUserId(entry.id)) &&
      Boolean(store.findBackofficeCredentialByUserId(entry.id, "admin"))
  );
  assert.ok(admin);
  const token = store.createSession(admin);

  for (const target of mobileAdminRoutes) {
    assert.equal(authorizeRoute(store, target, token).allowed, true, target.label);
  }
});

test("普通移动管理员可在真实控制器路径列出并审核注册申请", () => {
  const store = createIsolatedStore();
  const admin = store.users.find(
    (entry) =>
      entry.role === "admin" &&
      entry.status === "active" &&
      Boolean(store.findAdminCredentialByUserId(entry.id)) &&
      Boolean(store.findBackofficeCredentialByUserId(entry.id, "admin"))
  );
  const region = store.regions[0];
  assert.ok(admin);
  assert.ok(region);
  const token = store.createSession(admin);
  const application = {
    id: "application-mobile-admin-route",
    phone: "13900009991",
    requestedRole: "special" as const,
    profile: {
      name: "移动审核测试用户",
      regionId: region.id,
      regionName: region.name,
      neighborhood: region.name
    },
    status: "pending" as const,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };
  store.registrationApplications.unshift(application);
  const service = new RegistrationApplicationsService(
    store,
    { verifyCode: async () => true } as never,
    { get: () => "false" } as never
  );
  const controller = new RegistrationApplicationsController(service);

  authorizeRoute(
    store,
    { controller: RegistrationApplicationsController, method: "list", label: "注册申请列表" },
    token
  );
  const listed = controller.list("pending");
  assert.ok(listed.data.some((entry) => entry.id === application.id));

  const reviewAuthorization = authorizeRoute(
    store,
    { controller: RegistrationApplicationsController, method: "review", label: "注册申请审核" },
    token
  );
  const reviewed = controller.review(
    application.id,
    { decision: "approved" },
    { authUser: reviewAuthorization.request.authUser }
  );

  assert.equal(reviewed.data.status, "approved");
  assert.ok(reviewed.data.linkedUserId);
  assert.equal(
    store.logs.find((entry) => entry.type === "review-registration-approve")?.actor.id,
    admin.id
  );
});

test("非管理员会话仍被所有移动管理专用接口拒绝", () => {
  const store = createIsolatedStore();
  const special = store.users.find((entry) => entry.role === "special" && entry.status === "active");
  assert.ok(special);
  const token = store.createSession(special);

  for (const target of mobileAdminRoutes) {
    assert.throws(
      () => authorizeRoute(store, target, token),
      ForbiddenException,
      target.label
    );
  }
});

test("受限后台管理员会话缺少对应权限时仍被拒绝", () => {
  const store = createIsolatedStore();
  const credential = store.backofficeCredentials.find((entry) => entry.role === "admin");
  const admin = store.users.find((entry) => entry.id === credential?.userId && entry.role === "admin");
  assert.ok(credential);
  assert.ok(admin);
  credential.permissions = [];
  const token = store.createBackofficeSession(admin, credential.role, credential.tenantId);

  for (const target of mobileAdminRoutes) {
    assert.throws(
      () => authorizeRoute(store, target, token),
      ForbiddenException,
      target.label
    );
  }
});

test("受限后台管理员缺少共享业务路由权限时仍被拒绝", () => {
  for (const target of sharedBackofficePermissionRoutes) {
    const store = createIsolatedStore();
    const credential = store.backofficeCredentials.find((entry) => entry.role === "admin");
    const admin = store.users.find((entry) => entry.id === credential?.userId && entry.role === "admin");
    assert.ok(credential);
    assert.ok(admin);
    credential.permissions = [];
    const token = store.createBackofficeSession(admin, credential.role, credential.tenantId);

    assert.throws(
      () => authorizeRoute(store, target, token),
      ForbiddenException,
      `${target.label} 缺少 ${target.permission} 时应拒绝`
    );
  }
});

test("共享业务路由保留移动管理员访问并按后台权限精确放行", () => {
  for (const target of sharedBackofficePermissionRoutes) {
    const store = createIsolatedStore();
    const credential = store.backofficeCredentials.find((entry) => entry.role === "admin");
    const admin = store.users.find(
      (entry) =>
        entry.id === credential?.userId &&
        entry.role === "admin" &&
        Boolean(store.findAdminCredentialByUserId(entry.id))
    );
    assert.ok(credential);
    assert.ok(admin);

    const mobileToken = store.createSession(admin);
    assert.equal(
      authorizeRoute(store, target, mobileToken).allowed,
      true,
      `${target.label} 应保留移动管理员访问`
    );

    credential.permissions = [target.permission];
    const backofficeToken = store.createBackofficeSession(admin, credential.role, credential.tenantId);
    assert.equal(
      authorizeRoute(store, target, backofficeToken).allowed,
      true,
      `${target.label} 具备 ${target.permission} 时应放行`
    );
  }
});

test("后台凭证租户变化或凭证删除后，旧会话不能沿用默认权限访问业务接口", () => {
  const target = {
    controller: DevicesController,
    method: "monitoring",
    label: "柜机监控"
  };

  for (const mutation of ["tenant", "removed"] as const) {
    const store = createIsolatedStore();
    const credential = store.backofficeCredentials.find((entry) => entry.role === "admin");
    const admin = store.users.find((entry) => entry.id === credential?.userId && entry.role === "admin");
    assert.ok(credential);
    assert.ok(admin);
    const token = store.createBackofficeSession(admin, credential.role, credential.tenantId);

    if (mutation === "tenant") {
      credential.tenantId = "tenant-changed-after-login";
    } else {
      store.backofficeCredentials.splice(store.backofficeCredentials.indexOf(credential), 1);
    }

    assert.throws(() => authorizeRoute(store, target, token), ForbiddenException, mutation);
    assert.equal(store.sessions.has(token), false, `${mutation} 后旧会话应被撤销`);
  }
});

test("移动管理员会话创建时绑定当前租户且外租户凭证不能读取当前实例", () => {
  const store = createIsolatedStore();
  const credential = store.backofficeCredentials.find((entry) => entry.role === "admin");
  const admin = store.users.find((entry) => entry.id === credential?.userId && entry.role === "admin");
  assert.ok(credential);
  assert.ok(admin);
  credential.tenantId = "tenant-future";

  const token = store.createSession(admin);
  assert.equal(store.sessions.get(token)?.tenantId, "tenant-future");
  assert.throws(
    () =>
      authorizeRoute(
        store,
        { controller: DevicesController, method: "monitoring", label: "柜机监控" },
        token
      ),
    ForbiddenException
  );
  assert.equal(store.sessions.has(token), false);
});

test("移动管理员会话在租户或任一登录凭证变化后动态失效", () => {
  const target = {
    controller: DevicesController,
    method: "monitoring",
    label: "柜机监控"
  };

  for (const mutation of ["tenant", "backoffice-removed", "mobile-removed"] as const) {
    const store = createIsolatedStore();
    const credential = store.backofficeCredentials.find((entry) => entry.role === "admin");
    const admin = store.users.find((entry) => entry.id === credential?.userId && entry.role === "admin");
    const mobileCredential = store.adminCredentials.find((entry) => entry.userId === admin?.id);
    assert.ok(credential);
    assert.ok(admin);
    assert.ok(mobileCredential);
    const token = store.createSession(admin);
    assert.equal(store.sessions.get(token)?.tenantId, store.getDefaultTenantId());

    if (mutation === "tenant") {
      credential.tenantId = "tenant-changed-after-login";
    } else if (mutation === "backoffice-removed") {
      store.backofficeCredentials.splice(store.backofficeCredentials.indexOf(credential), 1);
    } else {
      store.adminCredentials.splice(store.adminCredentials.indexOf(mobileCredential), 1);
    }

    assert.throws(() => authorizeRoute(store, target, token), ForbiddenException, mutation);
    assert.equal(store.sessions.has(token), false, `${mutation} 后旧移动管理员会话应被撤销`);
  }
});

test("移动管理员租户校验不影响普通业务会话，服务商进入实例后才可访问业务路由", () => {
  const store = createIsolatedStore();
  const special = store.users.find((entry) => entry.role === "special" && entry.status === "active");
  const merchant = store.users.find((entry) => entry.role === "merchant" && entry.status === "active");
  const superCredential = store.backofficeCredentials.find((entry) => entry.role === "super_admin");
  const superAdmin = store.users.find((entry) => entry.id === superCredential?.userId);
  assert.ok(special);
  assert.ok(merchant);
  assert.ok(superCredential);
  assert.ok(superAdmin);

  const specialToken = store.createSession(special);
  const merchantToken = store.createSession(merchant);
  assert.equal(store.getSessionUser(specialToken)?.id, special.id);
  assert.equal(store.getSessionUser(merchantToken)?.id, merchant.id);

  const superToken = store.createBackofficeSession(
    superAdmin,
    superCredential.role,
    superCredential.tenantId
  );
  assert.throws(
    () =>
      authorizeRoute(
        store,
        { controller: DevicesController, method: "monitoring", label: "柜机监控" },
        superToken
      ),
    ForbiddenException
  );

  const tenantSuperToken = store.createBackofficeSession(
    superAdmin,
    superCredential.role,
    store.getDefaultTenantId()
  );
  assert.equal(
    authorizeRoute(
      store,
      { controller: DevicesController, method: "monitoring", label: "柜机监控" },
      tenantSuperToken
    ).allowed,
    true
  );
});

test("普通移动管理员不能越过仍属后台专用的账号、远程操作和敏感导出边界", () => {
  const store = createIsolatedStore();
  const admin = store.users.find(
    (entry) =>
      entry.role === "admin" &&
      entry.status === "active" &&
      Boolean(store.findAdminCredentialByUserId(entry.id)) &&
      Boolean(store.findBackofficeCredentialByUserId(entry.id, "admin"))
  );
  assert.ok(admin);
  const token = store.createSession(admin);

  for (const target of backofficeOnlyRoutes) {
    assert.throws(
      () => authorizeRoute(store, target, token),
      ForbiddenException,
      target.label
    );
  }
});

test("普通管理员即使存在后台凭证也不能把移动会话升级成后台会话", () => {
  const store = createIsolatedStore();
  const admin = store.users.find(
    (entry) =>
      entry.role === "admin" &&
      entry.status === "active" &&
      Boolean(store.findAdminCredentialByUserId(entry.id)) &&
      Boolean(store.findBackofficeCredentialByUserId(entry.id, "admin"))
  );
  assert.ok(admin);
  const token = store.createSession(admin);
  const authService = new AuthService(
    {} as never,
    {} as never,
    {} as never,
    store,
    {} as never,
    {} as never
  );

  assert.throws(() => authService.getBackofficeSession(token), UnauthorizedException);
});
