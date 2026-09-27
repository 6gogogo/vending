# 普通用户隐藏停用及缺货商品

2026-09-27，沿用 `codex/admin-workspace-redesign`。

## 行为与修改入口

- 普通用户（`special`）的柜机列表、详情和商品查询统一只返回未停用且可领取库存大于零的商品。零库存、负库存及仅平台报告有货而本地没有库存的商品均隐藏。
- 管理员仍可查看停用、零库存、负库存及其批次台账；重新启用或补货后，普通用户刷新即可恢复展示。
- 实机 `warning_only` 保质期策略不变：登记到期或不填写日期，不会使仍有库存且启用的商品消失。
- 修改入口：`apps/api/src/modules/devices/devices.service.ts` 的 `decorateDevice`、`getGoods`。过滤在目录状态、别名与本地库存合并完成后执行，平台数据不能覆盖本地启停或库存规则。
- 回归入口：`apps/api/test/device-goods-query.test.ts`、`expired-inventory-availability.test.ts`；日期和实际领取另见 `goods-expiry-policy.test.ts`、`actual-pickup.test.ts`。

## 本地验收

- 隔离模拟 API：`http://127.0.0.1:4188/api`；后台：`http://127.0.0.1:5188`；H5：`http://127.0.0.1:5189`，`VITE_API_BASE_URL` 指向该回环 API。
- 用模拟普通用户、管理员分别登录，对列表、详情、商品查询进行 6 次 HTTP 断言：普通用户仅返回三明治；管理员同时保留停用牛奶和零库存方便面。
- 390×844 浏览器可视化验收：停用及缺货卡片均消失，有货卡片和底部开门按钮正常，无内容遮挡。管理员货品详情仍显示停用牛奶及账面库存。
- Node 22.22.2 / npm 10.9.7 的 `check:local:full` 通过：共 1022 项测试，1016 通过、6 项 Windows 平台跳过，0 失败；类型检查、库存与防御性冒烟、前端安全检查以及所有端构建通过。模拟数据 `verify:api-data` 通过；定向测试 22 项通过。
- 仅本地模拟账号登录，没有开真实柜门、发送真实短信、发起扣款或改写实机库存。本次为服务端过滤，现有小程序刷新数据即可生效，无需重新发布小程序。

本地可视化截图与 HTTP 断言位于 `.codex-run/available-goods-mobile.png`、`.codex-run/available-goods-http-qa.json`；此目录不提交。

## 发布与回滚回执

- 正式版本：`eaacc187c55cbea78e6f30b9d6aaf39a84b72cbb`，服务器通过 Git 快进拉取，工作树干净；仅隐藏停用的中间提交没有单独上线。
- 停写维护窗口：14:38:16–14:39:48 HKT。Linux 1022 项测试全部通过、0 失败/跳过，服务端及公网构建完成。
- 公网 `/`、`/login`、`/mobile/`、`/api/health`、`/api/health/production-readiness` 均为 200；未登录 `/api/users` 为 403；VNC 到 Spark 私网健康端点为 200。API/Web 均 active/running，NRestarts=0。
- 运行配置摘要未变，保质期模式继续为 `warning_only`。本轮仅完成本地已登录角色页面的可视化验收；未冒用现场用户会话做生产登录，不将公网健康检查表述为微信实机领取验收。
- 回滚目标：`6ccb02aa20cd88e39c2cfe1ebd19b1e90e020434`。已验证停写备份 `2026-09-27T06-38-18-980Z-pre-release-available-goods-20260927`，清单 SHA256：`101dd04dd95cb700ab7c0eaff379a14429a8a6a99710ea2f35efa1913629e204`。
- 旧依赖与构建归档 `previous-runtime.tar`，SHA256：`54fe6dc9f9b73a5b73801f1162d27d75e9694efd44ff21e5aaaf8e9cc5557134`。自动回滚恢复程序和构建，不回退业务数据；本次未触发回滚。
- 服务器证据：`/home/fivegogogo/vending/release-evidence/20260927-available-goods-eaacc18/`，逐条命令退出码、备份与公网检查见[机器可读回执](goods-visibility-deployment-20260927.json)。
