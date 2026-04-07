# 公益智助柜系统

本仓库是 `descriptions/` 中需求的首版实现，目标是先把公益柜的核心业务闭环跑通，再逐步替换为正式数据层和更完整的数据分析能力。

## 目录结构

- `apps/api`：NestJS 业务后端，当前使用内存种子数据，并预留 SmartVM 柜机对接入口。
- `apps/mobile`：`uni-app + Vue 3` 移动端，可继续扩展到微信小程序、支付宝小程序和 Android App。
- `apps/admin-web`：Vue 3 电脑端后台。
- `packages/shared-types`：共享领域模型、接口类型与演示种子数据。
- `packages/shared-client`：通用 HTTP 请求层与 SmartVM 签名工具。
- `sandbox`：独立的模块化测试脚本目录，用于接口联调和回调模拟。

## 快速开始

1. 在仓库根目录执行 `npm install`
2. 将 `apps/api/.env.example` 复制为 `apps/api/.env`
3. 按真实环境填写 `SMARTVM_BASE_URL`、`SMARTVM_CLIENT_ID`、`SMARTVM_KEY`
4. 启动后端：`npm run dev:api`
5. 启动后台：`npm run dev:admin`
6. 启动移动端：`npm run dev:mobile`

## 当前实现说明

- 当前后端使用内存仓储，目的是在测试后端仍在摸索时，先把业务流程、页面流和接口层稳定下来。
- 所有 SmartVM 敏感凭据都只从环境变量读取，不直接写入代码。
- 前端界面文案集中管理，后续调整设计时不会影响业务逻辑层。
- 数据分析模块已提供基础看板与扩展接口，用户画像和调度建议可以在后续阶段继续补强。
