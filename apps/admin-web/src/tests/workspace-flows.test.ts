import { beforeEach, describe, expect, it, vi } from "vitest";
import { flushPromises, mount, type VueWrapper } from "@vue/test-utils";
import { createPinia } from "pinia";
import { defineComponent, h } from "vue";
import { createMemoryHistory, createRouter, RouterView } from "vue-router";
import { BACKOFFICE_PROVIDER_PERMISSIONS, BACKOFFICE_ROLE_DEFAULT_PERMISSIONS, type BackofficePermission, type BackofficeRole, type SystemSettingsSnapshot, type UserRecord } from "@vm/shared-types";
import AdminLayout from "../layouts/AdminLayout.vue";
import UsersPage from "../pages/UsersPage.vue";
import SystemSettingsPage from "../pages/SystemSettingsPage.vue";
import GoodsOverviewPage from "../pages/GoodsOverviewPage.vue";
import WarehousePage from "../pages/WarehousePage.vue";
import DashboardPage from "../pages/DashboardPage.vue";
import AlertsPage from "../pages/AlertsPage.vue";
import DeviceDetailPage from "../pages/DeviceDetailPage.vue";
import UserDetailPage from "../pages/UserDetailPage.vue";
import { useAdminSessionStore } from "../stores/session";

// 仅替换 API 边界，实际布局、人员页、设置页与 Vue Router 均参与测试。
const api = vi.hoisted(() => Object.fromEntries([
  "users", "devices", "policies", "regions", "goodsCatalog", "backofficeCredentials",
  "registrationApplications", "manualVerificationCodes", "goodsTaxonomy", "reservationSettings",
  "createUser", "systemSettings", "saveSystemSettings", "paymentDiagnostics", "logout", "exitPlatformTenant",
  "goodsOverview", "warehouseInventory", "goodsCategories", "goodsAlertPolicies", "platformGoodsSyncStatus",
  "createInventoryTransfer", "createExpiredBatchDisposition", "deviceDetail", "dashboard", "userDetail", "reservations", "manualSettlementCandidates", "alerts", "resolveAlert"
].map(name => [name, vi.fn()])));
vi.mock("../api/admin", () => ({ adminApi: api }));

const quotaKey = "SMARTVM_ADJUSTMENT_QUOTA_TIME_MODE";
const settings = (): SystemSettingsSnapshot => ({
  envFilePath: "test-only", loadedAt: "2026-09-22T00:00:00Z",
  settings: [{
    key: quotaKey, value: "auto", effectiveValue: "auto", group: "实例设置", label: "领取差异的额度归属",
    description: "测试额度日期", inputType: "select", options: [{ label: "自动", value: "auto" }, { label: "领取日", value: "original" }],
    sensitive: false, required: false, restartRequired: false, source: "runtime"
  }]
});
const person: UserRecord = { id: "test-person", role: "special", name: "流程测试人员", phone: "13900007777", tags: [], status: "active", regionId: "test-region", regionName: "测试地区" };
const warehouse = () => ({
  goodsExpiryMode: "enforced", warehouse: { code: "WAREHOUSE-LOCAL", name: "测试仓库" }, totalStock: 7,
  physicalTotalStock: 7, transferableTotalStock: 5, expiredTotalStock: 2, goodsKinds: 1,
  items: [{ goodsId: "g1", goodsName: "测试物资", currentStock: 7, physicalStock: 7, transferableStock: 5, expiredStock: 2, batchCount: 2, batches: [] }],
  physicalBatches: [], availableBatches: [],
  transferableBatches: [{ batchId: "batch-valid", deviceCode: "WAREHOUSE-LOCAL", goodsId: "g1", remainingQuantity: 5, expiresAt: "2099-01-01T00:00:00Z" }],
  expiredBatches: [{ batchId: "batch-expired", deviceCode: "WAREHOUSE-LOCAL", goodsId: "g1", remainingQuantity: 2, expiresAt: "2020-01-01T00:00:00Z" }],
  transfers: [], stocktakes: [], recentLogs: [], recentExpiredDispositions: []
});
const prepareInventory = () => {
  api.warehouseInventory.mockImplementation(async () => warehouse());
  api.devices.mockResolvedValue([{ deviceCode: "CAB-TEST", name: "测试柜机", doors: [] }]);
  api.deviceDetail.mockResolvedValue({ stockChanges: [] });
  api.goodsCatalog.mockResolvedValue([{ goodsId: "g1", name: "测试物资", category: "food", status: "active" }]);
  api.goodsOverview.mockResolvedValue({ totalKinds: 1, lowStockKinds: 0, outOfStockKinds: 0, policyCount: 0, settingCount: 0, warehouseStockTotal: 7, flaggedGoods: [], byDevice: [], byGoods: [], recentLogs: [] });
  api.platformGoodsSyncStatus.mockResolvedValue(undefined);
  api.createExpiredBatchDisposition.mockResolvedValue({ remainingQuantity: 1 });
};

beforeEach(() => {
  Object.values(api).forEach(mock => mock.mockReset().mockResolvedValue([]));
  api.users.mockResolvedValue([person]);
  api.regions.mockResolvedValue([{ id: "test-region", name: "测试地区", sortOrder: 1, status: "active" }]);
  api.goodsTaxonomy.mockResolvedValue({ revision: 0, nodes: [], goods: [], unassignedGoodsIds: [] });
  api.reservationSettings.mockResolvedValue(null);
  api.paymentDiagnostics.mockResolvedValue(undefined);
  api.systemSettings.mockImplementation(async () => settings());
  api.createUser.mockResolvedValue(person);
  api.saveSystemSettings.mockImplementation(async ({ values }) => ({
    ...settings(), settings: settings().settings.map(entry => ({ ...entry, value: values[entry.key] ?? entry.value })),
    changedKeys: Object.keys(values), runtimeAppliedKeys: Object.keys(values), restartRequiredKeys: [], updatedAt: "2026-09-22T00:01:00Z"
  }));
});

const placeholder = defineComponent({ render: () => h("p", "目标页面") });
async function start(path = "/users", role: BackofficeRole = "admin", permissions: BackofficePermission[] = [...BACKOFFICE_ROLE_DEFAULT_PERMISSIONS[role]]) {
  const pinia = createPinia();
  const session = useAdminSessionStore(pinia);
  session.setSession({ token: "test-only-token", user: { id: "test-admin", role: role === "super_admin" ? "admin" : role, backofficeRole: role, scope: "tenant", tenantId: "test", name: "测试管理员", phone: "", tags: [], permissions }, auth: { username: "test-admin", usesDefaultPassword: false, passwordUpdatedAt: "" } });
  const history = createMemoryHistory();
  const router = createRouter({ history, routes: [
    { path: "/login", component: placeholder },
    { path: "/", component: AdminLayout, children: [
      { path: "/users", component: UsersPage }, { path: "/users/:userId", component: placeholder },
      { path: "/settings", component: SystemSettingsPage }, { path: "/dashboard", component: placeholder },
      { path: "/platform", component: placeholder }, { path: "/operations", component: placeholder },
      { path: "/goods", component: GoodsOverviewPage }, { path: "/warehouse", component: WarehousePage },
      { path: "/poll-dashboard", component: DashboardPage }, { path: "/poll-device/:deviceCode", component: DeviceDetailPage },
      { path: "/poll-alerts", component: AlertsPage },
      { path: "/poll-user/:userId", component: UserDetailPage },
      { path: "/:rest(.*)*", component: placeholder }
    ] }
  ] });
  await router.push(path);
  const wrapper = mount(defineComponent({ render: () => h(RouterView) }), { attachTo: document.body, global: { plugins: [pinia, router], stubs: { AmapLocationPicker: true } } });
  await router.isReady();
  await flushPromises();
  return { wrapper, router, history, session };
}

const button = (wrapper: VueWrapper, label: string) => {
  const found = wrapper.findAll("button").find(item => item.isVisible() && item.text() === label);
  if (!found) throw new Error(`找不到可见按钮：${label}`);
  return found;
};
const field = (wrapper: VueWrapper, label: string) => {
  const found = wrapper.findAll("label").find(item => item.isVisible() && item.find(".admin-field__label").exists() && item.find(".admin-field__label").text() === label);
  if (!found) throw new Error(`找不到可见字段：${label}`);
  return found.get("input,select,textarea");
};
async function searchFor(wrapper: VueWrapper, query: string) {
  await wrapper.get('button[aria-label="搜索功能"]').trigger("click");
  await wrapper.get('input[aria-label="搜索功能名称"]').setValue(query);
}
async function dirtySettings(wrapper: VueWrapper) {
  await wrapper.get(".settings-page__field-control select").setValue("original");
}

describe("布局和路由的真实交互", () => {
  it("搜索当前页面也会收起弹窗", async () => {
    const { wrapper, router } = await start();
    await searchFor(wrapper, "人员管理");
    await wrapper.get('.console-search-results a[href="/users"]').trigger("click");
    await flushPromises();
    expect(router.currentRoute.value.path).toBe("/users");
    expect((wrapper.get(".console-search-dialog").element as HTMLDialogElement).open).toBe(false);
  });

  it("移动导航点击当前页面也会收起", async () => {
    const { wrapper } = await start();
    await wrapper.get('[aria-label="打开导航"]').trigger("click");
    await wrapper.get('.console-navigation-dialog a[href="/users"]').trigger("click");
    await flushPromises();
    expect((wrapper.get(".console-navigation-dialog").element as HTMLDialogElement).open).toBe(false);
  });

  it("搜索跳转在等待离开确认前关闭顶层弹窗，继续编辑保留输入", async () => {
    const { wrapper, router } = await start("/settings");
    await dirtySettings(wrapper);
    await searchFor(wrapper, "工作台");
    await wrapper.get('.console-search-results a[href="/dashboard"]').trigger("click");
    await flushPromises();
    expect((wrapper.get(".console-search-dialog").element as HTMLDialogElement).open).toBe(false);
    expect(button(wrapper, "继续编辑").exists()).toBe(true);
    await button(wrapper, "继续编辑").trigger("click");
    await flushPromises();
    expect(router.currentRoute.value.path).toBe("/settings");
    expect((wrapper.get(".settings-page__field-control select").element as HTMLSelectElement).value).toBe("original");
    expect(api.saveSystemSettings).not.toHaveBeenCalled();
  });

  it("确认框打开时 Ctrl+K 不会叠加搜索框", async () => {
    const { wrapper, router } = await start("/settings");
    await dirtySettings(wrapper);
    const leaving = router.push("/dashboard");
    await flushPromises();
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "k", ctrlKey: true }));
    await flushPromises();
    expect((wrapper.get(".console-search-dialog").element as HTMLDialogElement).open).toBe(false);
    await button(wrapper, "继续编辑").trigger("click");
    await leaving;
  });

  it.each([false, true])("未保存设置不阻挡退出；服务端撤销失败=%s 仍清除本机会话", async failure => {
    const { wrapper, router, session } = await start("/settings");
    if (failure) api.logout.mockRejectedValueOnce(new Error("模拟断网"));
    await dirtySettings(wrapper);
    await wrapper.get('button[aria-label="账户设置"]').trigger("click");
    await button(wrapper, "退出登录").trigger("click");
    await flushPromises();
    expect(router.currentRoute.value.path).toBe("/login");
    expect(session.isAuthenticated).toBe(false);
    expect(localStorage.getItem("vm-admin-session")).toBeNull();
    expect(api.saveSystemSettings).not.toHaveBeenCalled();
    expect(api.logout).toHaveBeenCalledTimes(1);
    if (failure) expect(window.alert).toHaveBeenCalled();
  });
});

describe("货品调拨与仓库确认", () => {
  beforeEach(prepareInventory);

  it.each([0, -1, 1.5, 6])("调拨数量 %s 不会提交请求", async quantity => {
    const { wrapper } = await start("/goods?section=transfer");
    await field(wrapper, "数量").setValue(quantity);
    await button(wrapper, "提交调拨").trigger("click");
    await flushPromises();
    expect(api.createInventoryTransfer).not.toHaveBeenCalled();
    expect(wrapper.text()).toContain("调拨数量必须是");
  });

  it("调拨确认前无写请求，取消保留数量和备注，再次确认只提交一次", async () => {
    const { wrapper } = await start("/goods?section=transfer");
    await field(wrapper, "数量").setValue(2);
    await field(wrapper, "备注").setValue("  回归调拨  ");
    await button(wrapper, "提交调拨").trigger("click");
    await flushPromises();
    expect(api.createInventoryTransfer).not.toHaveBeenCalled();
    await button(wrapper, "返回修改").trigger("click");
    await flushPromises();
    expect((field(wrapper, "数量").element as HTMLInputElement).value).toBe("2");
    await button(wrapper, "提交调拨").trigger("click");
    await flushPromises();
    await button(wrapper, "确认并立即调拨").trigger("click");
    await flushPromises();
    expect(api.createInventoryTransfer).toHaveBeenCalledExactlyOnceWith({ fromCode: "WAREHOUSE-LOCAL", toCode: "CAB-TEST", goodsId: "g1", quantity: 2, sourceBatchId: "batch-valid", note: "回归调拨" });
  });

  it.each(["enforced", "warning_only"])("按服务端保质期策略 %s 处理到期日期", async mode => {
    const stock = warehouse();
    stock.goodsExpiryMode = mode;
    stock.transferableBatches[0]!.expiresAt = "2020-01-01T00:00:00Z";
    api.warehouseInventory.mockResolvedValue(stock);
    const { wrapper } = await start("/goods?section=transfer");
    await button(wrapper, "提交调拨").trigger("click");
    await flushPromises();
    expect(wrapper.find("dialog[open]").exists()).toBe(mode === "warning_only");
    expect(api.createInventoryTransfer).not.toHaveBeenCalled();
  });

  it("过期处置需要理由，取消无副作用，失败重试复用同一幂等标识", async () => {
    const { wrapper } = await start("/warehouse?section=expiry");
    await button(wrapper, "选择处置").trigger("click");
    await button(wrapper, "核对并提交处置").trigger("click");
    expect(wrapper.text()).toContain("请填写可供后续追溯的处置理由");
    expect(api.createExpiredBatchDisposition).not.toHaveBeenCalled();
    await field(wrapper, "处置理由").setValue("模拟过期登记");
    await button(wrapper, "核对并提交处置").trigger("click");
    await flushPromises();
    await button(wrapper, "返回修改").trigger("click");
    await flushPromises();
    expect(api.createExpiredBatchDisposition).not.toHaveBeenCalled();
    api.createExpiredBatchDisposition.mockRejectedValueOnce(new Error("模拟响应丢失"));
    for (let attempt = 0; attempt < 2; attempt++) {
      await button(wrapper, "核对并提交处置").trigger("click");
      await flushPromises();
      await button(wrapper, "确认并记录处置").trigger("click");
      await flushPromises();
    }
    const calls = api.createExpiredBatchDisposition.mock.calls;
    expect(calls).toHaveLength(2);
    expect(calls[0]![0]).toBe("batch-expired");
    expect(calls[0]![1]).toMatchObject({ confirmed: true, quantity: 1, reason: "模拟过期登记" });
    expect(calls[0]![1].idempotencyKey).toBeTruthy();
    expect(calls[1]![1].idempotencyKey).toBe(calls[0]![1].idempotencyKey);
  });
});

describe("待办直接处理", () => {
  const pages = ["/poll-dashboard?section=tasks", "/poll-alerts", "/poll-device/CAB-TEST?section=manage"];
  const prepareTasks = (grade = "warning") => {
    const tasks = [{ id: "task-test", type: "inventory", grade, status: "open", title: "模拟待办", detail: "仅用于交互回归", dueAt: "2026-09-23T00:00:00Z" }];
    const bucket = () => ({ count: 0, users: [] });
    api.dashboard.mockImplementation(async () => ({ pendingTasks: [...tasks], serviceOverview: { completeUsers: bucket(), partialUsers: bucket(), unservedUsers: bucket(), totalUsers: 0 }, taskGradeSummary: { fault: 0, feedback: 0, warning: 1 }, summaryLogs: [], serviceTrend: [] }));
    api.alerts.mockImplementation(async () => [...tasks]);
    api.deviceDetail.mockImplementation(async () => ({ device: { deviceCode: "CAB-TEST", name: "测试柜机", status: "online", doors: [] }, runtime: { doorState: "closed", openedAfterLastCommand: false }, pendingTasks: [...tasks], recentEvents: [], recentLogs: [], businessDayServedUsers: [], stockChanges: [], totalStock: 0, servedUsers: 0 }));
    return tasks;
  };

  it.each(pages.flatMap(path => ["warning", "fault"].map(grade => [path, grade])))("%s 的 %s 待办单击直接提交，快速连点不重复请求", async (path, grade) => {
    const tasks = prepareTasks(grade);
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
    let finish!: () => void;
    api.resolveAlert.mockImplementation(() => new Promise<void>(resolve => { finish = resolve; }));
    const { wrapper } = await start(path);
    const action = button(wrapper, grade === "fault" ? "标记已知晓" : "手动完成");
    await Promise.all([action.trigger("click"), action.trigger("click")]);
    expect(confirm).not.toHaveBeenCalled();
    expect(api.resolveAlert).toHaveBeenCalledTimes(1);
    expect(api.resolveAlert.mock.calls[0]![0]).toBe("task-test");
    expect(button(wrapper, "处理中").attributes("disabled")).toBeDefined();
    if (grade === "fault") tasks[0]!.status = "acknowledged";
    else tasks.splice(0);
    finish();
    await flushPromises();
    expect(wrapper.text()).toContain(grade === "fault" ? "已标记为知晓" : "已完成");
    expect(wrapper.findAll("button").some(item => item.text() === "处理中")).toBe(false);
  });

  it.each(pages)("%s 处理失败显示原因并允许直接重试", async path => {
    prepareTasks();
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
    api.resolveAlert.mockRejectedValueOnce(new Error("模拟处理失败"));
    const { wrapper } = await start(path);
    await button(wrapper, "手动完成").trigger("click");
    await flushPromises();
    expect(wrapper.text()).toContain("模拟处理失败");
    expect(button(wrapper, "手动完成").attributes("disabled")).toBeUndefined();
    await button(wrapper, "手动完成").trigger("click");
    await flushPromises();
    expect(api.resolveAlert).toHaveBeenCalledTimes(2);
    expect(confirm).not.toHaveBeenCalled();
  });
});

describe("慢响应与离开页面", () => {
  it.each([["/poll-device", "deviceDetail"], ["/poll-user", "userDetail"]])("%s 切换对象后忽略旧请求的失败，当前请求仍可重试", async (path, method) => {
    let rejectOld!: (error: Error) => void;
    api[method]!.mockImplementation((id: string) => id === "first"
      ? new Promise((_, reject) => { rejectOld = reject; })
      : Promise.reject(new Error("当前对象网络故障")));
    const { wrapper, router } = await start(`${path}/first`);
    await router.push(`${path}/second`);
    await flushPromises();
    expect(wrapper.text()).toContain("当前对象网络故障");
    rejectOld(new Error("旧对象过期响应"));
    await flushPromises();
    expect(wrapper.text()).not.toContain("旧对象过期响应");
    expect(wrapper.text()).toContain("当前对象网络故障");
    expect(wrapper.findAll("button").some(item => /重新加载|重试/.test(item.text()) && item.isVisible())).toBe(true);
  });

  it("快速切换盘点柜机，迟到的旧柜机库存不能覆盖当前明细", async () => {
    prepareInventory();
    api.devices.mockResolvedValue([{ deviceCode: "CAB-A", name: "甲柜", doors: [] }, { deviceCode: "CAB-B", name: "乙柜", doors: [] }]);
    let resolveOld!: (value: unknown) => void;
    const oldRequest = new Promise(resolve => { resolveOld = resolve; });
    api.deviceDetail.mockImplementation((code: string) => code === "CAB-A" ? oldRequest : Promise.resolve({ stockChanges: [{ goodsId: "b", goodsName: "乙柜物资", currentStock: 20 }] }));
    const { wrapper } = await start("/warehouse?section=transfer");
    await field(wrapper, "盘点柜机").setValue("CAB-B");
    await flushPromises();
    expect(wrapper.get(".warehouse-stocktake-list").text()).toContain("乙柜物资");
    resolveOld({ stockChanges: [{ goodsId: "a", goodsName: "甲柜物资", currentStock: 99 }] });
    await flushPromises();
    expect(wrapper.get(".warehouse-stocktake-list").text()).toContain("乙柜物资");
    expect(wrapper.get(".warehouse-stocktake-list").text()).not.toContain("甲柜物资");
  });

  it.each([["/goods", "goods:view"], ["/warehouse", "warehouse:view"]] as const)("只读 %s 不会附带无权访问的柜机请求", async (path, permission) => {
    prepareInventory();
    const { wrapper } = await start(path, "admin", [permission]);
    expect(api.devices).not.toHaveBeenCalled();
    expect(wrapper.text()).not.toContain("加载失败");
    expect(wrapper.findAll("button").some(item => item.isVisible() && /提交调拨|上架机器/.test(item.text()))).toBe(false);
  });

  it.each([["/poll-dashboard", "dashboard"], ["/poll-device/CAB-TEST", "deviceDetail"]])("%s 加载中离开，不会在迟到响应后重新开始轮询", async (path, method) => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
    try {
      let rejectRequest!: (error: Error) => void;
      api[method]!.mockImplementation(() => new Promise((_, reject) => { rejectRequest = reject; }));
      const { wrapper } = await start(path);
      wrapper.unmount();
      rejectRequest(new Error("离开后到达的响应"));
      await flushPromises();
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.clearAllTimers();
      vi.useRealTimers();
    }
  });
});

describe("设置保存和取消", () => {
  it("连续发起两次导航共用一次离开决定，旧导航不会永久等待", async () => {
    const { wrapper, router } = await start("/settings");
    await dirtySettings(wrapper);
    const first = router.push("/dashboard");
    await flushPromises();
    const second = router.push("/users");
    await flushPromises();
    await button(wrapper, "不保存").trigger("click");
    await Promise.all([first, second]);
    expect(router.currentRoute.value.path).toBe("/users");
    expect(api.saveSystemSettings).not.toHaveBeenCalled();
  });

  it("服务商退出实例后使用新平台会话，未保存设置不能阻挡退出", async () => {
    const { wrapper, router, session } = await start("/settings", "super_admin", [...BACKOFFICE_ROLE_DEFAULT_PERMISSIONS.admin]);
    api.exitPlatformTenant.mockResolvedValue({ token: "new-platform-token", user: { ...session.user, scope: "provider", tenantId: undefined, permissions: [...BACKOFFICE_PROVIDER_PERMISSIONS] }, auth: session.auth });
    await dirtySettings(wrapper);
    await wrapper.get('button[aria-label="账户设置"]').trigger("click");
    await button(wrapper, "退出当前实例").trigger("click");
    await flushPromises();
    expect(router.currentRoute.value.path).toBe("/platform");
    expect(session.token).toBe("new-platform-token");
    expect(session.user?.scope).toBe("provider");
    expect(api.saveSystemSettings).not.toHaveBeenCalled();
  });

  it.each(["不保存", "保存并离开"])("%s 正确完成跳转", async label => {
    const { wrapper, router } = await start("/settings");
    await dirtySettings(wrapper);
    const leaving = router.push("/dashboard");
    await flushPromises();
    await button(wrapper, label).trigger("click");
    await leaving;
    expect(router.currentRoute.value.path).toBe("/dashboard");
    if (label === "不保存") expect(api.saveSystemSettings).not.toHaveBeenCalled();
    else expect(api.saveSystemSettings).toHaveBeenCalledExactlyOnceWith({ values: { [quotaKey]: "original" } });
  });

  it("保存失败留在当前页，保留草稿并允许重试", async () => {
    const { wrapper, router } = await start("/settings");
    await dirtySettings(wrapper);
    api.saveSystemSettings.mockRejectedValueOnce(new Error("模拟保存失败"));
    const leaving = router.push("/dashboard");
    await flushPromises();
    await button(wrapper, "保存并离开").trigger("click");
    await leaving;
    expect(router.currentRoute.value.path).toBe("/settings");
    expect(wrapper.text()).toContain("模拟保存失败");
    expect((wrapper.get(".settings-page__field-control select").element as HTMLSelectElement).value).toBe("original");
    await button(wrapper, "保存设置").trigger("click");
    await flushPromises();
    expect(api.saveSystemSettings).toHaveBeenCalledTimes(2);
    expect(button(wrapper, "保存设置").attributes("disabled")).toBeDefined();
  });
});

describe("人员页面分区和提交", () => {
  it("快速重复点击保存只写入一次，等待期间禁用再次提交", async () => {
    let finish!: (value: UserRecord) => void;
    api.createUser.mockImplementation(() => new Promise<UserRecord>(resolve => { finish = resolve; }));
    const { wrapper } = await start();
    await button(wrapper, "新增人员").trigger("click");
    await wrapper.get('input[placeholder="请输入姓名"]').setValue("防重复测试");
    await wrapper.get('input[placeholder="请输入手机号"]').setValue("13900004444");
    const save = button(wrapper, "保存并配置每日物资");
    await Promise.all([save.trigger("click"), save.trigger("click")]);
    expect(api.createUser).toHaveBeenCalledTimes(1);
    expect(save.attributes("disabled")).toBeDefined();
    finish(person); await flushPromises();
    expect(api.createUser).toHaveBeenCalledTimes(1);
  });

  it.each(["链接", "手机选择器"])("通过 %s 切换分区、后退和前进保留筛选与选择，并且不重复请求人员数据", async navigation => {
    const { wrapper, router } = await start("/users?section=directory&from=review");
    await wrapper.get('input[placeholder="输入姓名、手机号、标签或区域"]').setValue("流程测试");
    await wrapper.get('input[type="checkbox"][aria-label="选择人员 流程测试人员"]').setValue(true);
    if (navigation === "手机选择器") {
      await wrapper.get(".workspace-sections__mobile select").setValue("rules");
    } else {
      await wrapper.get('.workspace-sections a[href="/users?section=rules&from=review"]').trigger("click");
    }
    await flushPromises();
    expect(router.currentRoute.value.query.from).toBe("review");
    expect(wrapper.get(".workspace-toolbar").text()).toContain("已选 1 人");
    router.back(); await flushPromises();
    expect(router.currentRoute.value.query.section).toBe("directory");
    expect((wrapper.get(".workspace-sections__mobile select").element as HTMLSelectElement).value).toBe("directory");
    expect((wrapper.get('input[placeholder="输入姓名、手机号、标签或区域"]').element as HTMLInputElement).value).toBe("流程测试");
    router.forward(); await flushPromises();
    expect(router.currentRoute.value.query.section).toBe("rules");
    expect((wrapper.get(".workspace-sections__mobile select").element as HTMLSelectElement).value).toBe("rules");
    expect(api.users).toHaveBeenCalledTimes(1);
  });

  it.each(["invalid", "rules&section=registrations"])("非法分区 %s 回落人员台账", async section => {
    const { wrapper } = await start(`/users?section=${section}`);
    expect(wrapper.get('.workspace-sections [aria-current="page"]').text()).toContain("人员台账");
    expect(wrapper.get(".users-workspace .admin-table").isVisible()).toBe(true);
  });

  it("只有人员读取权限时，直达受限分区回落，搜索也不显示受限入口", async () => {
    const { wrapper } = await start("/users?section=verification", "admin", ["users:view"]);
    expect(wrapper.get('.workspace-sections [aria-current="page"]').text()).toContain("人员台账");
    expect(wrapper.findAll(".workspace-sections a").map(item => item.text())).toEqual(["人员台账1", "初始化指引"]);
    expect(wrapper.findAll(".workspace-sections__mobile option").map(item => item.attributes("value"))).toEqual(["directory", "setup"]);
    await searchFor(wrapper, "初始化");
    expect(wrapper.find('.console-search-results a[href="/users?section=setup"]').exists()).toBe(true);
    expect(api.manualVerificationCodes).not.toHaveBeenCalled();
    expect(api.policies).not.toHaveBeenCalled();
    expect(api.devices).not.toHaveBeenCalled();
  });

  it("读取接口失败明确显示错误", async () => {
    api.users.mockRejectedValueOnce(new Error("模拟网络故障"));
    const { wrapper } = await start();
    expect(wrapper.get('[role="alert"]').text()).toContain("模拟网络故障");
    expect(wrapper.text()).not.toContain("正在加载人员列表");
  });

  it("保存并配置每日物资直接进入新人员的领取规则", async () => {
    const { wrapper, router } = await start();
    await button(wrapper, "新增人员").trigger("click");
    await wrapper.get('input[placeholder="请输入姓名"]').setValue("流程新增人员");
    await wrapper.get('input[placeholder="请输入手机号"]').setValue("13900006666");
    await button(wrapper, "保存并配置每日物资").trigger("click");
    await flushPromises();
    expect(router.currentRoute.value.path).toBe("/users/test-person");
    expect(router.currentRoute.value.query.section).toBe("rules");
    expect(api.createUser).toHaveBeenCalledTimes(1);
  });

  it("人员保存失败不关闭抽屉、不丢草稿", async () => {
    api.createUser.mockRejectedValueOnce(new Error("模拟写入失败"));
    const { wrapper } = await start();
    await button(wrapper, "新增人员").trigger("click");
    await wrapper.get('input[placeholder="请输入姓名"]').setValue("失败后保留");
    await wrapper.get('input[placeholder="请输入手机号"]').setValue("13900005555");
    await button(wrapper, "保存并配置每日物资").trigger("click");
    await flushPromises();
    expect(wrapper.text()).toContain("模拟写入失败");
    expect((wrapper.get('input[placeholder="请输入姓名"]').element as HTMLInputElement).value).toBe("失败后保留");
    expect(button(wrapper, "保存并配置每日物资").attributes("disabled")).toBeUndefined();
  });
});
