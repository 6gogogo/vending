# 结算报警 150 分钟与批次可见性核验

2026-09-24，继续使用 `codex/admin-workspace-redesign`。用户确认平台结算回报较慢，要求将报警阈值调整为 150 分钟，并确认登记到期或没有保质期的用品不会因此不可见。

## 行为

- 特殊群体柜门可信关闭 **满 150 分钟**、仍缺少领取或投放结算流水时，自动生成“结算回调超时待补记”；任务到期时间和详情文字统一使用这一阈值。
- 人工现场核对入口仍在可信关门满 10 分钟后可用；主动撤销人工补记仍重新打开核对任务。开门未关故障的 10 分钟提醒不变。
- 实机保质期策略沿用 `VM_GOODS_EXPIRY_MODE=warning_only`。登记到期日期只用于后台提醒，不隐藏库存、不阻止查询、领取或调拨。未填到期日期表示未设保质期，不判为过期；新增批次的日期输入本来就是可选项。
- 日期和批次审计继续保留；没有清空日期、迁移批次或改写生产库存。已消耗、手动处置、停用、负库存和预约占用仍遵循各自业务规则。
- 修正仓库空队列仍显示“过期批次会自动隔离”的旧提示：仅提醒模式下明确说明登记到期批次仍保留在库存和调拨列表，无保质期用品可不填日期。严格模式保留原有说明。

## 只读实机证据

15:45 HKT 核查：API/Web 服务均 active，源码 `818dfdb` 且干净。正数批次共 11 个、52 件，其中登记已到期 1 个批次/1 件，未设保质期 9 个批次/41 件；均仍存在账本中。当时没有未处理的结算超时任务，无需迁移历史任务状态。

后续复查该已到期商品当前为 `inactive`，未追溯其停用原因；日期策略不会自动启用停用商品。仓库页面只统计本地仓库，柜机中的批次不计入它的“登记到期库存”数量，不能据仓库为零推断柜机批次消失。

保质期配置来自实际进程工作目录下的 `apps/api/.env`，值为 `warning_only`；文件最后修改于 9 月 22 日 11:39 HKT，早于当前 API 的 9 月 23 日 15:44 启动。进程启动环境没有覆盖该项。注意 `/proc/<pid>/environ` 只反映启动环境，不能把其中缺项误判成没有加载应用 `.env`。

## 本地验证

- 定向回归 37 项通过，包括 149 分 59.999 秒与 150 分钟边界、重复刷新不重复建任务、10 分钟人工入口、结算互斥与回滚。
- 分别用“2000 年已到期”和“未填日期”批次验证商品查询、旧预约兼容、预结算、实际领取回调扣减、仓库展示、调拨和重载持久化；到期提醒保留，无日期不误报。网关均为隔离替身，不操作真实柜机。
- 模拟数据副本 `verify:api-data` 通过，测试数据与实机隔离。
- Node 22.22.2 / npm 10.9.7 完整执行 `check:local:full`：1019 项，1013 通过、0 失败、6 项 Windows 平台跳过；后台、API、H5、微信、支付宝和 App 构建完成。隔离 API 回归使用 `127.0.0.1` 临时端口，没有连接正式 API 或外部柜机。

本轮没有布局修改，仅修正保质期空态说明。Edge 连接最初不可用，后改用 Codex 内置浏览器完成以下验收：

- 本地 API `http://127.0.0.1:4188/api`、后台 `http://127.0.0.1:5188`，单独模拟数据目录和 `warning_only` 配置。
- 1365px 桌面与 375px 手机视口均能选择登记已到期批次；无日期用品显示“未设保质期”、数量 6，批次仍可选择。手机内容宽度与滚动宽度均为 360px（另有 15px 滚动条），没有横向溢出。
- 仅在模拟环境将已到期批次的 8 件库存调拨到模拟柜机：成功反馈、来源归零、调拨记录和原日期均正确。随后复验修正的仓库空态；没有操作实机库存或柜门。
- 正式浏览器登录后台，仓库明确显示“登记保质期仅作提醒，不限制正常调拨”和“不自动隔离或扣除这些批次”，与启动配置一致。公开登录页和本地验收均无 console error。
- 截图在 `.codex-run/callback-expiry-20260924/`，包括桌面到期批次、手机到期/无日期批次、手机空态和正式登录页。

## 修改和后续定位

| 问题 | 入口 |
| --- | --- |
| 自动结算超时报警 | `apps/api/src/modules/alerts/alerts.service.ts` 的 `SETTLEMENT_CALLBACK_ALERT_WAIT_MINUTES` / `refreshManualSettlementTasks()` |
| 10 分钟人工核对 | `apps/api/src/modules/cabinet-events/manual-settlement-recovery.service.ts` |
| 保质期模式和可用库存 | `apps/api/src/common/config/goods-expiry-policy.ts`、`common/store/in-memory-store.service.ts` |
| 查询、仓库与批次展示 | `modules/devices/devices.service.ts`、`modules/warehouses/warehouses.service.ts`、`modules/goods/goods.service.ts` |
| 回归用例 | `apps/api/test/manual-settlement-recovery.test.ts`、`goods-expiry-policy.test.ts`、`actual-pickup.test.ts` |

## 发布回执

报警调整先发布为 `591d934c5bbfae2fe13a1a751e1491f9648131e0`，Linux 1019 项全通过、0 失败/跳过，维护窗口 15:56:21–15:57:50 HKT（约 89 秒）。公网后台、登录、H5、health/readiness、未登录访问限制及入口资产通过；API/Web active、NRestarts=0。运行配置摘要一致，保质期模式保持 `warning_only`。

首轮回滚目标为 `818dfdbb71692501f7e59196578c862588467d10`，证据目录 `/home/fivegogogo/vending/release-evidence/20260924-callback-expiry-591d934/`。备份为 `2026-09-24T07-56-23-998Z-pre-release-callback-expiry-20260924`，清单 SHA256 `8c6796e5f534af87cc8a253118ead8e51c93e7ff7905e31d29ba6bdb1d12b050`；旧运行归档 SHA256 `64def0df9675262ecb81c005ac1b3a7dd9a8146cbc40799ef5a6a330b7bdba98`。

最终版本为 **`6ccb02aa20cd88e39c2cfe1ebd19b1e90e020434`**，仓库提示修正再次通过完整本地检查和实机 Linux 1019 项测试。第二轮维护窗口 16:09:42–16:11:10 HKT（约 88 秒），证据目录 `/home/fivegogogo/vending/release-evidence/20260924-expiry-copy-6ccb02a/`。

16:12–16:14 公网后台、登录、H5、health/readiness 均为 200，未登录人员接口为 403，VNC 私网入口通过。公开入口为 `/assets/index-DWrQex3D.js`；仓库资源 `/assets/WarehousePage-q0kRes8X.js` 已核实包含新提示。API/Web 均 active/running、Result=success、NRestarts=0，源码干净；源码及构建后的报警常量均为 150，配置摘要未变。

最终提示在本地浏览器已完成可视化检查；补发后正式标签页控制超时，未取得最终版本的新公网页面截图，不将资源校验写成第二次生产浏览器可视化验收。此前已在正式登录后的仓库页面核对运行策略，此轮未操作真实柜门、短信、支付或库存。

| 当前回滚备案 | 内容 |
| --- | --- |
| 回滚目标 | `591d934c5bbfae2fe13a1a751e1491f9648131e0`，仍保留 150 分钟报警 |
| 停写备份 | `2026-09-24T08-09-44-933Z-pre-release-expiry-copy-20260924` |
| 备份清单 SHA256 | `34840366d48102f5f83fb11a944b150e291cffddb2d20c9ca2cf7e7d79388b6e` |
| 旧运行归档 | `previous-runtime.tar`，586,536,960 字节 |
| 归档 SHA256 | `11ad5dd677e291400f4b49aef07828bebe89bbf40810d0f41d18d337670a5b47` |

失败时恢复源码和构建归档，不回退发布后的业务数据。两轮的备份、测试和公网检查汇总见 [机器可读回执](callback-expiry-deployment-20260924.json)。
