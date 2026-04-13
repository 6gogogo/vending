# 沙箱测试脚本

`sandbox` 目录与主应用故意分离，目的是把接口试验、签名校验和回调模拟单独放置，避免调试代码混入正式业务目录。

## 环境变量

- `sandbox` 会先读取 `apps/api/.env*`，再读取 `sandbox/.env*`。如果你已经在后端统一配置了第三方密钥，短信脚本可以直接复用，不需要再填第二份。
- 可复制 `sandbox/.env.example` 为你自己的本地环境文件，再按需手工导入。
- `SMARTVM_BASE_URL`
- `SMARTVM_CLIENT_ID`
- `SMARTVM_KEY`
- `SMARTVM_DEVICE_CODE`
- `SMARTVM_DOOR_NUM`
- `LOCAL_API_BASE_URL`
- `TEST_PLATFORM_ACCOUNT`
- `TEST_PLATFORM_PASSWORD`
- `ALIYUN_SMS_ACCESS_KEY_ID`
- `ALIYUN_SMS_ACCESS_KEY_SECRET`
- `ALIYUN_SMS_REGION_ID`
- `ALIYUN_SMS_ENDPOINT`

## 常用命令

- `npm run sandbox:device -- CAB-1001`
- `npm run sandbox:sign`
- `npm run sandbox:goods -- CAB-1001`
- `npm run sandbox:door`
- `npm run sandbox:payment-success`
- `npm run sandbox:refund`
- `npm run sandbox:settlement`
- `npm run sandbox:sms:send -- 13800138000`
- `npm run sandbox:sms:verify -- 13800138000 123456`

## 说明

- 所有测试载荷都使用纯 JSON 文件，方便复制和扩展。
- 签名规则与 `descriptions/1.1apis.md` 保持一致。
- 回调模拟脚本默认请求本地业务后端。
- `device` 用于查本地业务后端里的柜机详情，适合你已知柜机编号时直接核对库存、门信息和状态。
- `goods`、`door`、`payment-success`、`refund` 默认请求 `SMARTVM_BASE_URL`，适合直接对接测试平台。
- `sms:send` 和 `sms:verify` 通过阿里云短信验证码服务做真实发送与校验，目前只放在 `sandbox` 中单独测试，还没有接入正式登录/注册流程。
- 阿里云短信验证码脚本走的是官方 SDK 提供的手机验证码接口，因此至少要提供 `ALIYUN_SMS_ACCESS_KEY_ID` 和 `ALIYUN_SMS_ACCESS_KEY_SECRET`。
- 如果你已经把阿里云短信密钥写进 `apps/api/.env`，这里不需要再重复配置。
- `goods` 现在支持直接传柜机编号，例如 `npm run sandbox:goods -- CAB-1001`；如果是双门柜，还可以再补一个门号，例如 `npm run sandbox:goods -- CAB-1001 1`。
- 如果你已经把真实柜机编号写进 `SMARTVM_DEVICE_CODE`，那么 `npm run sandbox:device` 和 `npm run sandbox:goods` 可以直接运行，不用每次再手敲编号。
- 如果只是想验证柜机接口，不建议让小程序直接请求测试平台；优先通过本地后端或 `sandbox` 脚本中转，避免把签名凭据暴露到前端。
- `sandbox/.env.example` 现在会被脚本自动读取，所以 `npm run sandbox:sign` 不再要求你先手工设置环境变量。
- `sandbox/.env.example` 里已经内置测试账号密码，以及一组演示用的 `SMARTVM_CLIENT_ID/KEY`。
- 演示签名参数只用于让本地签名脚本开箱可跑，真正请求测试平台时仍要替换成真实 `clientId/key`。
