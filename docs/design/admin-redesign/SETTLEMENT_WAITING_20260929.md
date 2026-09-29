# 结算提醒等待时长（2026-09-29）

## 展示口径

后台工作台待办、重点待办和提醒详情直接显示“已等待结算 X 小时 X 分钟”，下一行显示超过 150 分钟提醒阈值的时长。详情保留可信关门时间与本次查询时间，统一为北京时间。

从匹配原事件、原柜机的可信 CLOSED 回调接收时间起算，按服务端当前时间取整到分钟，不使用浏览器时钟、开门时间或任务创建时间。超过一天仍累计小时数。已有提醒无需重建即可展示；已完成提醒不继续显示等待。缺失、无效或未来的关门时间不猜测时长。

工作台和提醒页面每 15 秒轮询，隐藏页面时暂停；已打开的详情随响应同步。字段仅装饰响应，不因时长增长写入账本，不修改报警阈值、结算、库存或支付流程。手机待办使用现有卡片样式，让时长和处理入口无需横向滚动即可查看。

## 修改入口

- `packages/shared-types/src/index.ts`：`AlertTask.settlementWaiting` 可选展示字段。
- `apps/api/src/modules/alerts/alerts.service.ts`：`withSettlementWaiting` 在列表响应时按可信关门时间计算，原报警及去重逻辑保持原样。
- `apps/admin-web/src/components/SettlementWaiting.vue`：时长文案、起算与更新时间。
- `DashboardPage.vue` / `AlertsPage.vue`：列表、摘要、详情及轮询同步。
- `apps/api/test/manual-settlement-recovery.test.ts`：150 分钟边界、跨日增长、不持久化展示字段、关门记录缺失/异常、已完成任务。
- `apps/admin-web/src/tests/workspace-flows.test.ts`：两个页面的轮询及打开详情更新，并保留待办单击、防重复请求回归。

## 验收环境

本地 API `http://127.0.0.1:4188/api`、后台 `http://127.0.0.1:5188`，独立 simulation 数据；未调用真实开门、支付、短信或模拟生产回调。桌面、390px 和 320px 手机宽度实看列表与详情，处理入口可达。截图与完整日志位于未提交的 `.codex-run/settlement-wait-*`。

本地 `verify:api-data`、Node 22.22.2 / npm 10.9.7 的 `check:local:full` 全部通过：TAP 976 项（通过 970，Windows 平台跳过 6），前端交互 49 项通过，总计 1,025 项。手机卡片调整后单独复跑后台类型检查、全部后台测试和构建通过。

发布结果在通过服务器构建、公网接口和页面验证后补记。
