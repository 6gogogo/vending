# 结算报警 150 分钟与批次可见性核验

2026-09-24，继续使用 `codex/admin-workspace-redesign`。用户确认平台结算回报较慢，要求将报警阈值调整为 150 分钟，并确认登记到期或没有保质期的用品不会因此不可见。

## 行为

- 特殊群体柜门可信关闭 **满 150 分钟**、仍缺少领取或投放结算流水时，自动生成“结算回调超时待补记”；任务到期时间和详情文字统一使用这一阈值。
- 人工现场核对入口仍在可信关门满 10 分钟后可用；主动撤销人工补记仍重新打开核对任务。开门未关故障的 10 分钟提醒不变。
- 实机保质期策略沿用 `VM_GOODS_EXPIRY_MODE=warning_only`。登记到期日期只用于后台提醒，不隐藏库存、不阻止查询、领取或调拨。未填到期日期表示未设保质期，不判为过期；新增批次的日期输入本来就是可选项。
- 日期和批次审计继续保留；没有清空日期、迁移批次或改写生产库存。已消耗、手动处置、停用、负库存和预约占用仍遵循各自业务规则。

## 只读实机证据

15:45 HKT 核查：API/Web 服务均 active，源码 `818dfdb` 且干净。正数批次共 11 个、52 件，其中登记已到期 1 个批次/1 件，未设保质期 9 个批次/41 件；均仍存在账本中。当时没有未处理的结算超时任务，无需迁移历史任务状态。

保质期配置来自实际进程工作目录下的 `apps/api/.env`，值为 `warning_only`；文件最后修改于 9 月 22 日 11:39 HKT，早于当前 API 的 9 月 23 日 15:44 启动。进程启动环境没有覆盖该项。注意 `/proc/<pid>/environ` 只反映启动环境，不能把其中缺项误判成没有加载应用 `.env`。

## 本地验证

- 定向回归 37 项通过，包括 149 分 59.999 秒与 150 分钟边界、重复刷新不重复建任务、10 分钟人工入口、结算互斥与回滚。
- 分别用“2000 年已到期”和“未填日期”批次验证商品查询、旧预约兼容、预结算、实际领取回调扣减、仓库展示、调拨和重载持久化；到期提醒保留，无日期不误报。网关均为隔离替身，不操作真实柜机。
- 模拟数据副本 `verify:api-data` 通过，测试数据与实机隔离。
- Node 22.22.2 / npm 10.9.7 完整执行 `check:local:full`：1019 项，1013 通过、0 失败、6 项 Windows 平台跳过；后台、API、H5、微信、支付宝和 App 构建完成。隔离 API 回归使用 `127.0.0.1` 临时端口，没有连接正式 API 或外部柜机。

本轮没有前端布局修改。浏览器工具在连接时返回 `nodeRepl.fetch request failed`，不能将此前的可视化验收当成本轮已完成；此前桌面及手机界面验收见 [手机布局验收](MOBILE.md) 和 [待办交互验收](TODO_CALLBACK_20260923.md)。

## 修改和后续定位

| 问题 | 入口 |
| --- | --- |
| 自动结算超时报警 | `apps/api/src/modules/alerts/alerts.service.ts` 的 `SETTLEMENT_CALLBACK_ALERT_WAIT_MINUTES` / `refreshManualSettlementTasks()` |
| 10 分钟人工核对 | `apps/api/src/modules/cabinet-events/manual-settlement-recovery.service.ts` |
| 保质期模式和可用库存 | `apps/api/src/common/config/goods-expiry-policy.ts`、`common/store/in-memory-store.service.ts` |
| 查询、仓库与批次展示 | `modules/devices/devices.service.ts`、`modules/warehouses/warehouses.service.ts`、`modules/goods/goods.service.ts` |
| 回归用例 | `apps/api/test/manual-settlement-recovery.test.ts`、`goods-expiry-policy.test.ts`、`actual-pickup.test.ts` |

## 发布回执

待本地完整检查通过后，按停写备份、Git 拉取、正式构建、启动和公网复验的现有流程发布；回滚目标为 `818dfdbb71692501f7e59196578c862588467d10`。失败时恢复源码和构建归档，不回退发布后的业务数据。
