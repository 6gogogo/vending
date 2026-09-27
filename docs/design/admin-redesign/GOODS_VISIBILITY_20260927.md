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
