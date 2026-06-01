# 专项压测与体验审计报告（2026-06-02）

## 范围

本轮在本地最新代码上继续压测后台、后端 API、小程序用户端和商家端。测试不重置本地数据，使用 `专项`、`SPEC-`、`specialty-goods-` 前缀创建隔离测试数据。

## 测试矩阵

| 专项 | 覆盖内容 | 结果 |
| --- | --- | --- |
| 账号与注册审核 | 验证码、公开注册、禁止公开管理员申请、待审/驳回/通过、空姓名、未配置区域 | 通过 |
| 权限层层下发 | 服务商、管理员、商家、普通用户；管理员不能发放自身没有的权限；管理员不能获得全局工作台权限 | 通过 |
| 区域与基础配置 | 区域名称、经纬度、预约开关、保留时间、超时阈值 | 通过 |
| 货品与分类 | 空分类、空编号、空名称、负价格、重复编号、上下架基础链路 | 通过 |
| 库存与批次 | 补货批次、批次去除超量、调拨、盘点导出、负实盘数 | 通过 |
| 领取策略与额度 | 全局规则非负、策略时间、策略物资、批量下发、个人策略不存在货品 | 通过 |
| 用户预约与开柜 | 预约数量、别人取消预约、替其他手机号开柜、预结算额度内 | 通过 |
| 商家补货 | 常用商品模板、模板归属、补货日期、补货追踪隔离 | 通过 |
| 异常反馈与数据查看 | 反馈绑定本人、后台处理、核心数据页、日志导出权限 | 通过 |
| 后台 UI 首屏与长页面 | 15 个后台页面、14 个移动端页面截图；后台长页面量化 | 通过，仍有详情型页面较长 |

## 首轮发现的问题

专项脚本第一轮共 63 项，46 通过、17 失败。失败集中在：

- 注册资料允许空姓名。
- 货品分类允许空名称。
- 货品允许空编号、空名称、负价格。
- 低库存阈值允许负数。
- 全局领取规则允许负数。
- 领取策略允许无效时间和空物资。
- 批次去除超量会被静默截断。
- 盘点允许负实盘数。
- 商家常用商品允许默认数量/保质期为 0。
- 商家 B 可修改商家 A 创建的常用商品模板。
- 后台日志页一次展开全部日志，页面高度曾达到 56.85 屏。
- 人员管理和货物总览页被大列表撑长，分别达到 12.71 屏和 11.38 屏。

## 已修复内容

- 后端注册资料增加姓名非空校验。
- 货品分类、货品主数据增加空值和负价格校验。
- 低库存阈值、领取规则、领取策略、盘点实盘数增加边界校验。
- 批次去除超出剩余库存时直接拒绝，不再静默截断。
- 商家常用商品模板增加默认数量、保质期校验。
- 商家模板按归属隔离：商家只能修改/使用自己的模板或系统目录模板。
- 商家模板列表对商家只返回本人和系统可用模板。
- 后台日志页首屏只展示最近 12 条，并提示筛选/导出查看完整数据。
- 后台人员页和货物页大列表改为内部滚动区域，避免页面被数据量撑到十几屏。

## 验证结果

| 命令 | 结果 |
| --- | --- |
| `node docs/test-artifacts/e2e-2026-06-01/full-flow-e2e.cjs` | 45/45 通过 |
| `node docs/test-artifacts/business-flow-audit-2026-06-02/business-edge-e2e.cjs` | 31/31 通过 |
| `node docs/test-artifacts/specialty-audit-2026-06-02/specialty-e2e.cjs` | 63/63 通过 |
| `npm run smoke:inventory --workspace @vm/api` | 通过 |
| `npm run typecheck --workspaces --if-present` | 通过 |
| `npm run build --workspaces --if-present` | 通过 |
| `npm run build:mobile:weixin` | 通过 |

## 后台页面高度量化

| 页面 | 当前屏数 | 截图 |
| --- | ---: | --- |
| 全局工作台 | 1.15 | `screens/15-admin-platform.png` |
| 运营主控台 | 5.13 | `screens/16-admin-dashboard.png` |
| 人员管理 | 3.02 | `screens/17-admin-users.png` |
| 人员详情 | 5.34 | `screens/18-admin-user-detail.png` |
| 货物总览 | 3.94 | `screens/19-admin-goods.png` |
| 货物详情 | 2.72 | `screens/20-admin-goods-detail.png` |
| 仓库盘点 | 2.31 | `screens/21-admin-warehouse.png` |
| 柜机监控 | 2.48 | `screens/22-admin-operations.png` |
| 柜机详情 | 3.55 | `screens/23-admin-device-detail.png` |
| 数据监控 | 2.10 | `screens/24-admin-data-monitor.png` |
| AI 工作台 | 1.86 | `screens/25-admin-ai.png` |
| 系统设置 | 1.84 | `screens/26-admin-settings.png` |
| 操作日志 | 2.38 | `screens/27-admin-logs.png` |
| 日志详情 | 1.56 | `screens/28-admin-log-detail.png` |
| 商家后台 | 1.15 | `screens/29-admin-merchant.png` |

## 仍需产品确认

- 运营主控台、人员详情、柜机详情属于多区块工作台，当前首屏可读但整页仍较长；如果要继续压到 2 屏以内，需要拆成标签页或子路由。
- 当前本地仍使用内存仓储和本地 JSON 持久化，生产上线前仍需按既定发布流程在公网服务器拉取、构建、运行并验证。
- 本轮没有连接真实 SmartVM、真实短信和真实支付回调，只验证了本地模拟和签名拦截链路。

## 截图目录

- `docs/test-artifacts/specialty-audit-2026-06-02/screens/manifest.json`
- `docs/test-artifacts/specialty-audit-2026-06-02/screens/01-mobile-login.png` 到 `14-mobile-merchant-settings.png`
- `docs/test-artifacts/specialty-audit-2026-06-02/screens/15-admin-platform.png` 到 `29-admin-merchant.png`
