# 已结算订单自动关闭超时提醒

## 问题与修复

9 月 29 日三笔订单已结算且平台回写成功，历史“结算回调超时待补记”仍为待处理。原自动恢复只处理平台回写失败提醒，遗漏了正常迟到结算对应的超时提醒。

现在仅在事件状态为 `settled`、原订单平台回写为 `success`，且不存在人工补记冲突或撤销时自动关闭。正在等待、回写待处理或失败仍保留。关闭记录留在历史和操作日志中，不删除订单，不重复扣减库存或发起扣款。

正常平台回写成功后立即检查对应提醒；列表和柜机详情刷新也会修复旧提醒。自动关闭幂等，已完成提醒不再展示持续等待时长。

## 修改入口与验证

- `apps/api/src/modules/alerts/alerts.service.ts`：恢复判定、历史提醒修复和关闭审计。
- `apps/api/src/modules/cabinet-events/cabinet-events.service.ts`：成功回写后的即时恢复。
- `apps/api/test/manual-settlement-recovery.test.ts`：关门但未结算、回写未完成、已知晓提醒、历史修复、重复调用和迟到零元回调。
- `apps/api/test/payment-integrity.test.ts`：支付完整性测试替身补齐提醒恢复接口。

隔离本地模拟 API `http://127.0.0.1:4188/api`、后台 `http://127.0.0.1:5188`、H5 `http://127.0.0.1:5189`；H5 API 指向上述回环地址。模拟两笔已完成、一笔待结算，浏览器确认待办仅保留后一笔，时长和操作可见。截图 `.codex-run/settlement-resolved-preview.png`；无真实外呼或真实柜机操作。

定向测试 24 项通过。Node 22.22.2 / npm 10.9.7 下 `check:local:full` 通过：1021 项通过、6 项 Windows 平台跳过，包含各端构建；隔离模拟数据和线上只读副本的 `verify:api-data` 均通过。线上副本包含 148 个事件、73 条提醒、396 条回调和 59333 条审计日志，未修改源数据。发布回执见下方。

## 公网发布与回滚

- 发布提交 `a76d11961415e288f3eab6cb76326cdaf906eec3`，继续使用 `codex/admin-workspace-redesign`；发布分支 `codex/UI`。服务器通过 `git pull --ff-only origin codex/UI` 更新，未直接编辑生产源码。
- 旧版本 `a02ea5b438d4bcdc08ceede1e16304b6d61db960` 的依赖和构建已打包，运行数据停写备份并校验；备份为 `2026-09-30T01-56-35-394Z-pre-release-settlement-resolved-20260930`，清单 SHA256 `8b9a337a58533388a740259d0199d3fe8a1185121dc0a1e9ffaef2660f8197ab`。
- 自动失败回滚仅恢复旧代码、依赖和构建，不回退业务账本；未触发回滚。过期批次策略保持 `warning_only`，部署配置摘要未改变。
- Linux 端回归 1027 项全部通过，无跳过；重新安装和各端构建完成。API、Web 均 active，NRestarts 均为 0。
- 公网首页、登录、H5、health、production-readiness 均 HTTP 200；匿名 users 接口 403。使用正常后台登录查询提醒，三条目标提醒均为 resolved，不再返回等待时长、不在 open 列表；每条关闭日志为 1 条。订单的昨晚回写时间保持不变，未再次结算或扣款；验证会话已退出。
- 本地浏览器已做截图验收。公网浏览器工具连续超时，未宣称本轮公网视觉验收通过；公网 HTTP、鉴权和业务响应已实测通过。

完整回执：[服务器发布](SETTLEMENT_RESOLVED_20260930_RELEASE.json)、[公网业务验收](SETTLEMENT_RESOLVED_20260930_PUBLIC.json)。服务器回滚材料目录 `/home/fivegogogo/vending/release-evidence/20260930-settlement-resolved-a76d119/`。

