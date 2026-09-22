# 工作区修改与扩展索引

先按问题找入口，再读对应模块；业务语言和边界以 [CONTEXT.md](CONTEXT.md) 与 [ADR](docs/adr/) 为准。

## 当前后台评审工作区

- 分支：`codex/admin-workspace-redesign`，后续后台修改继续在此分支进行。
- [预览启动、工作树位置与截图](docs/design/admin-redesign/README.md)：`http://127.0.0.1:5188/`，演示账号 `admin / admin`。
- [交互与流程回归记录](docs/design/admin-redesign/REGRESSION.md)：修复项、测试范围、复验截图与验证边界。
- [手机布局验收](docs/design/admin-redesign/MOBILE.md)：窄屏问题、手机适配规则、桌面回归与截图。
- [发布准备与交接](docs/design/admin-redesign/RELEASE_READINESS.md)：候选版本、完整检查、线上只读预检、发布顺序和回退条件；当前等待上线指令。
- `.codex-run/` 是不提交的本地演练数据和日志；依赖目录及构建输出不作为源代码维护。

## 按问题定位

| 要修改或排查什么 | 优先入口 | 接着看什么 |
| --- | --- | --- |
| 布局、搜索、账户弹窗、手机导航 | [AdminLayout.vue](apps/admin-web/src/layouts/AdminLayout.vue) | [AdminNavigation.vue](apps/admin-web/src/components/AdminNavigation.vue)、[workspace.css](apps/admin-web/src/styles/workspace.css) |
| 手机布局、表格卡片、固定保存栏 | [mobile.css](apps/admin-web/src/styles/mobile.css) | 800px 及以下启用；页面标记字段和操作，复用原数据与处理函数 |
| 菜单、功能搜索、分区及显示权限 | [admin-navigation.ts](apps/admin-web/src/utils/admin-navigation.ts) | [WorkspaceSections.vue](apps/admin-web/src/components/WorkspaceSections.vue)、[use-workspace-section.ts](apps/admin-web/src/utils/use-workspace-section.ts) |
| URL、详情跳转、路由权限 | [router/index.ts](apps/admin-web/src/router/index.ts) | [session.ts](apps/admin-web/src/stores/session.ts)，默认落点也在此定义 |
| 页面调用接口、权限预检 | [api/admin.ts](apps/admin-web/src/api/admin.ts) | [api/client.ts](apps/admin-web/src/api/client.ts)、[HTTP 请求层](packages/shared-client/src/http.ts) |
| 登录、令牌、实例范围与授权 | [auth.service.ts](apps/api/src/modules/auth/auth.service.ts) | [role.guard.ts](apps/api/src/common/guards/role.guard.ts)、ADR-0003/0004 |
| 后端模块装配和启动 | [app.module.ts](apps/api/src/app.module.ts) | [main.ts](apps/api/src/main.ts) |
| 领域类型、请求字段、权限名称 | [shared-types/index.ts](packages/shared-types/src/index.ts) | 同步核对前端 API 包装和后端控制器 |
| 库存、持久化、一致性约束 | [in-memory-store.service.ts](apps/api/src/common/store/in-memory-store.service.ts) | [persistence.ts](apps/api/src/common/store/persistence.ts)、[ADR-0002](docs/adr/0002-centralize-inventory-batch-changes.md) |
| 慢请求、旧响应覆盖、轮询未停止 | [latest-request.ts](apps/admin-web/src/utils/latest-request.ts) | [use-page-polling.ts](apps/admin-web/src/utils/use-page-polling.ts)、[流程测试](apps/admin-web/src/tests/workspace-flows.test.ts) |
| 移动端、共享包、联调工具 | [移动端说明](docs/knowledge/mobile.md)、[共享包说明](docs/knowledge/shared-and-tooling.md) | `apps/mobile/`、`packages/`、`sandbox/` |
| 运行、发布和公网验收 | [运行与测试说明](docs/运行与测试说明.md) | [发布与公网部署验证流程](docs/发布与公网部署验证流程.md) |

## 后台业务页面对应表

前端页面均在 `apps/admin-web/src/pages/`；后端模块在 `apps/api/src/modules/`。模块中 `*.controller.ts` 定义接口，`*.service.ts` 承接业务。

| 业务 / URL | 页面 | 后端模块 |
| --- | --- | --- |
| 工作台 `/dashboard` | [DashboardPage.vue](apps/admin-web/src/pages/DashboardPage.vue) | `analytics`、`alerts` |
| 人员 `/users`、`/users/:userId` | [UsersPage.vue](apps/admin-web/src/pages/UsersPage.vue)、[UserDetailPage.vue](apps/admin-web/src/pages/UserDetailPage.vue) | `users`、`registration-applications`、`special-access-policies`、`regions`、`auth` |
| 柜机 `/operations`、`/operations/:deviceCode` | [OperationsPage.vue](apps/admin-web/src/pages/OperationsPage.vue)、[DeviceWorkspacePage.vue](apps/admin-web/src/pages/DeviceWorkspacePage.vue) | `devices`、`cabinet-events`；管理员与分配柜机详情按角色分开 |
| 货品 `/goods`、`/goods/:goodsId` | [GoodsOverviewPage.vue](apps/admin-web/src/pages/GoodsOverviewPage.vue)、[GoodsDetailPage.vue](apps/admin-web/src/pages/GoodsDetailPage.vue) | `goods`、`warehouses` |
| 仓库 `/warehouse` | [WarehousePage.vue](apps/admin-web/src/pages/WarehousePage.vue) | `warehouses` |
| 分类 `/goods-taxonomy` | [GoodsTaxonomyPage.vue](apps/admin-web/src/pages/GoodsTaxonomyPage.vue) | `goods/goods-taxonomy.*` |
| 日志 `/logs`、`/logs/:logId` | [LogsPage.vue](apps/admin-web/src/pages/LogsPage.vue)、[LogDetailPage.vue](apps/admin-web/src/pages/LogDetailPage.vue) | `operation-logs` |
| 数据 `/data-monitor`、AI `/ai` | [DataMonitorPage.vue](apps/admin-web/src/pages/DataMonitorPage.vue)、[AiWorkspacePage.vue](apps/admin-web/src/pages/AiWorkspacePage.vue) | `analytics`、`ai-insights` |
| 设置 `/settings` | [SystemSettingsPage.vue](apps/admin-web/src/pages/SystemSettingsPage.vue) | `system-settings` |
| 服务商 `/platform`、商户 `/merchant` | [PlatformOverviewPage.vue](apps/admin-web/src/pages/PlatformOverviewPage.vue)、[MerchantBackofficePage.vue](apps/admin-web/src/pages/MerchantBackofficePage.vue) | `platform`、`merchant-goods-templates` |
| 手册 `/manual` | [RoleGuidePage.vue](apps/admin-web/src/pages/RoleGuidePage.vue) | [角色手册筛选](apps/admin-web/src/utils/role-manual.ts) |

## 扩展时的固定顺序

1. **新页面**：加路由及角色/权限要求，再加 `adminDestinations`。需要成为登录默认入口时才改 `session.ts`。后端独立校验会话和实例，隐藏菜单不能替代授权。
2. **新分区**：工作台、人员、货品、仓库在 `admin-navigation.ts` 定义分区；页面用 `getAdminWorkspaceSections()` 补实时角标，搜索同步更新。详情页按对象能力定义分区。用 `useWorkspaceSection()` 处理无效 URL；有操作意图的跳转需写 `query.section`，例如保存人员后直达 `rules`。
3. **新请求**：核对 `api/admin.ts` 的权限预检，避免无权调用的辅助请求拖垮 `Promise.all`。对象切换使用 `createLatestRequestGuard()`，卸载时失效；轮询用 `usePagePolling()`，上次完成后再计时。失败要有可见提示及恢复入口。
4. **新写操作**：处理等待、防重复、取消和失败重试；库存、结算继续走已有服务端流程。同页分区用 `v-show` 保留草稿，跨人员/柜机时清空旧明细。导航浮层先关闭，再让未保存确认接管。
5. **手机适配**：后台专用规则集中在 `mobile.css`，不要直接改领取端 `apps/mobile`。常规列表可加 `admin-table--mobile-cards`，每个数据格补 `data-label`，标题、通栏内容和操作分别用 `mobile-card__title`、`mobile-card__wide`、`mobile-card__actions`。不复制请求和事件处理；复杂对照表仍单独检查滚动与入口可达性。至少复验 320/375/430px、短屏弹窗和桌面断点。
6. **新测试**：纯规则放 `src/utils/*.test.ts`，组件与路由交互放 `src/tests/*.test.ts`，只替换 API 边界；服务端规则放 `apps/api/test/`，使用已有隔离运行器。

人员和柜机详情仍是较大的业务页面，后续可沿现有分区逐步拆组件。导航、分区、轮询和响应有效性判断已经有独立入口，新增功能应复用这些入口。

## 常用检查

在当前工作树根目录运行：

```powershell
node scripts/preview-admin-redesign.mjs
npm run typecheck --workspace @vm/admin-web
npm test --workspace @vm/admin-web
npm run build --workspace @vm/admin-web
npm run smoke:frontend-safety
npm test --workspace @vm/api
```

后台 `npm test` 同时运行纯规则和组件流程测试；只定位交互问题可运行 `npm run test:flows --workspace @vm/admin-web`。完整项目检查见根 `package.json` 的 `check:local`。公网发布另按项目发布流程验收。
