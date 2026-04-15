# Sandbox 命令清单

`sandbox` 目录里的脚本是为了单独调试接口，不让这些调试逻辑混进正式业务代码。

这些脚本现在会先读取 `apps/api/.env*`，再读取 `sandbox/.env*`。如果你已经把第三方地址和密钥统一写在 `apps/api/.env`，`sandbox` 可以直接复用，不需要再填第二份。

## 根目录可直接执行的命令

### 1. 查询本地柜机详情

命令：

```bash
npm run sandbox:device -- CAB-1001
```

实际执行内容：

```bash
node sandbox/scripts/query-device-info.mjs CAB-1001
```

作用：

- 按柜机编号查询本地业务后端里的柜机详情
- 适合你已经知道 `deviceCode`，想先看本地模拟库存、门信息和状态

目标地址：

- `LOCAL_API_BASE_URL + /devices/:deviceCode`

依赖环境变量：

- `LOCAL_API_BASE_URL`

补充说明：

- 如果你不传编号，脚本会回退到 `sandbox/fixtures/goods-query.sample.json` 里的示例编号
- 如果你已经把真实柜机编号写进 `SMARTVM_DEVICE_CODE`，脚本会优先使用这个值
- 这个命令不依赖 SmartVM 的签名参数，但要求本地后端已经启动

---

### 1.1 查询最近开柜事件

命令：

```bash
npm run sandbox:events
```

查看某一条订单：

```bash
npm run sandbox:events -- 订单号
```

作用：

- 直接查询当前后端里的开柜事件
- 会返回 `orderNo / eventId / deviceCode / phone / status`
- 适合先确认“退款”“付款成功通知”这些脚本到底该拿哪一个订单号

目标地址：

- `LOCAL_API_BASE_URL + /cabinet-events`

补充说明：

- 这个命令不需要管理员登录
- 如果你把 `LOCAL_API_BASE_URL` 改成云端后端地址，它就会直接查云端后端事件

---

### 2. 生成签名

命令：

```bash
npm run sandbox:sign
```

实际执行内容：

```bash
node sandbox/scripts/generate-signature.mjs sandbox/fixtures/open-door.sample.json
```

作用：

- 读取开门示例载荷
- 自动补上 `clientId`、`nonceStr`、`sign`
- 输出完整签名结果

依赖环境变量：

- `SMARTVM_CLIENT_ID`
- `SMARTVM_KEY`

补充说明：

- 现在脚本会自动读取 `sandbox/.env.example`
- 即使你没有手工设置环境变量，`npm run sandbox:sign` 也能直接运行
- 如果生成结果里的 `clientId` 是 `sandbox-demo-client`，说明当前使用的是演示签名参数，只适合本地查看签名格式

---

### 3. 查询柜机商品

命令：

```bash
npm run sandbox:goods -- CAB-1001
```

实际执行内容：

```bash
node sandbox/scripts/query-goods.mjs CAB-1001
```

作用：

- 请求 SmartVM 的“获取设备商品列表”接口
- 用于检查设备编码、门号和签名是否正确

目标地址：

- `SMARTVM_BASE_URL + /api/pay/container/getCabinetGoodsInfo`

依赖环境变量：

- `SMARTVM_BASE_URL`
- `SMARTVM_CLIENT_ID`
- `SMARTVM_KEY`

补充说明：

- 如果当前还是 `sandbox/.env.example` 里的演示 `clientId/key`，脚本会直接报明确提示并停止
- 测试平台登录账号密码与这里的 `clientId/key` 不是同一组信息，不能互相替代
- 双门柜可以继续追加门号，例如：`npm run sandbox:goods -- CAB-1001 1`
- 如果你已经把真实柜机编号写进 `SMARTVM_DEVICE_CODE`，那么 `npm run sandbox:goods` 也能直接跑
- 如果你不传参数，脚本会回退到 `sandbox/fixtures/goods-query.sample.json`

---

### 4. 调试开门接口

命令：

```bash
npm run sandbox:door
```

实际执行内容：

```bash
node sandbox/scripts/open-door.mjs sandbox/fixtures/open-door.sample.json
```

作用：

- 请求 SmartVM 的开门接口
- 用于确认 `userId`、`eventId`、`deviceCode`、`phone` 等字段组合是否可用

目标地址：

- `SMARTVM_BASE_URL + /api/pay/container/opendoor`

依赖环境变量：

- `SMARTVM_BASE_URL`
- `SMARTVM_CLIENT_ID`
- `SMARTVM_KEY`

补充说明：

- 与 `sandbox:goods` 一样，请求测试平台前必须把演示签名参数替换成真实 `clientId/key`

---

### 5. 模拟门状态回调到本地后端

命令：

```bash
npm run sandbox:door-status
```

实际执行内容：

```bash
node sandbox/scripts/simulate-door-status.mjs sandbox/fixtures/door-status.sample.json
```

作用：

- 把示例“门状态推送”数据发给本地业务后端
- 用来测试本地回调处理是否正常

目标地址：

- `LOCAL_API_BASE_URL + /cabinet-events/callbacks/door-status`

依赖环境变量：

- `LOCAL_API_BASE_URL`

---

### 6. 通知付款成功到测试平台

命令：

```bash
npm run sandbox:payment-success
```

实际执行内容：

```bash
node sandbox/scripts/payment-success.mjs
```

作用：

- 请求 SmartVM 的“付款成功异步通知”接口
- 用于补测结算成功后第三方支付回写链路

目标地址：

- 优先使用结算/补扣回调里返回的 `notifyUrl / noticeUrl`
- 如果示例文件里没有这两个字段，才回退到 `SMARTVM_BASE_URL + /api/pay/container/paymentSuccess`

依赖环境变量：

- `SMARTVM_BASE_URL`
- `SMARTVM_CLIENT_ID`
- `SMARTVM_KEY`

补充说明：

- 如果你还没有真实的 SmartVM 签名参数，这个命令不会继续请求测试平台
- 不传参数时，默认读取 `sandbox/fixtures/payment-success.sample.json`
- 如果你要用真实结算回调里的 `notifyUrl / noticeUrl`，请显式传入文件：

```bash
npm run sandbox:payment-success -- sandbox/fixtures/payment-success-from-settlement.sample.json
```

也可以直接使用当前测试柜机 `91120149` 的付款成功样例：

```bash
npm run sandbox:payment-success -- sandbox/fixtures/payment-success-91120149.sample.json
```
- 当前输出会严格按赛方文档“付款成功异步通知”的方式展示：
  - `requestUrl`
  - `requestBody`
  - `responseStatus`
  - `responseBody`

补充命令：

```bash
npm run sandbox:payment-success:api -- 订单号 交易号 金额
```

也可以直接把平台返回的结算 / 待支付订单信息保存成一个 JSON 文件后传入：

```bash
npm run sandbox:payment-success:api -- 路径\\to\\settlement.json 交易号 金额
```

仓库里已提供一个示例文件：

```bash
npm run sandbox:payment-success:api -- sandbox/fixtures/payment-success-from-settlement.sample.json sandbox-txn-001 500
```

作用：

- 不是直连平台，而是先把付款成功通知发给本地后端
- 再由本地后端转发到 SmartVM 平台
- 用于核对“PC 后端 / 正式业务后端”这条转发链是否正常
- 如果第一参数是 JSON 文件路径，脚本会直接从文件里读取 `orderNo / eventId / deviceCode / amount`
- 如果能拿到管理员 token，输出里还会追加平台侧“付款成功异步通知”的原始请求/响应

补充说明：

- 如果不传订单号，脚本会默认取本地后端最新的一条开柜事件
- `transactionId` 和 `amount` 也支持手工传入，便于和平台实际补扣单对齐
- 如果第一参数是文件路径，第二参数仍然是 `transactionId`，第三参数可选覆盖金额
- 这个命令调用的是 `/api/cabinet-events/callbacks/payment-success`
- 输出分两层：
  - `localApi`：本地后端入口
  - `platformApi`：后端实际转发到平台的请求/返回，字段风格对齐赛方文档
- 如果 PC 后台还提示 `Cannot POST /api/cabinet-events/payment-success`，说明你云端后端还没更新到当前代码；当前源码里管理员入口和回调入口都已经存在

---

### 7. 调试退款接口

命令：

```bash
npm run sandbox:refund
```

实际执行内容：

```bash
node sandbox/scripts/refund.mjs sandbox/fixtures/refund.sample.json
```

作用：

- 请求 SmartVM 的退款接口
- 用于确认退款单号、交易号和设备编码组合是否符合接口要求

目标地址：

- `SMARTVM_BASE_URL + /api/pay/container/refund`

依赖环境变量：

- `SMARTVM_BASE_URL`
- `SMARTVM_CLIENT_ID`
- `SMARTVM_KEY`

补充说明：

- 退款接口同样依赖真实 `clientId/key`
- `sandbox/.env.example` 里的默认值只用于本地演示签名格式

补充命令：

```bash
npm run sandbox:refund:api -- 订单号 交易号 退款单号 金额
```

作用：

- 先以管理员身份调用本地后端的退款接口
- 再由本地后端调用平台退款接口
- 用于核对“后台点击退款”这一条真实链路

依赖环境变量：

- `LOCAL_API_BASE_URL`
- `SANDBOX_ADMIN_TOKEN`

可选替代：

- `SANDBOX_ADMIN_PHONE`
- `SANDBOX_ADMIN_CODE`

补充说明：

- 如果没提供 `SANDBOX_ADMIN_TOKEN`，脚本会尝试用 `SANDBOX_ADMIN_PHONE / SANDBOX_ADMIN_CODE` 自动登录本地后端后台
- 如果当前云端后端已经启用真实短信验证码，默认的 `SANDBOX_ADMIN_CODE=123456` 会失效；这时应直接提供 `SANDBOX_ADMIN_TOKEN`
- 如果不传订单号，脚本会默认取本地后端最新的一条开柜事件

---

### 7.1 探测开门参数组合

命令：

```bash
npm run sandbox:door:probe -- 91120149 13800000002 00000001
```

作用：

- 用同一组 `deviceCode / phone / userId` 批量测试不同 `payStyle`
- 同时覆盖“传 `doorNum=1`”和“不传 `doorNum`”
- 适合快速判断是签名、支付方式，还是平台业务配置问题

依赖环境变量：

- `SMARTVM_BASE_URL`
- `SMARTVM_CLIENT_ID`
- `SMARTVM_KEY`

可选环境变量：

- `SMARTVM_EXTRA_PAY_STYLES`

补充说明：

- 默认除了 `2 / 3 / 7`，还会把 `SMARTVM_EXTRA_PAY_STYLES` 里的自定义支付方式名一起测
- 多个自定义支付方式可用英文逗号分隔，例如 `SMARTVM_EXTRA_PAY_STYLES=duan3,duan4`

---

### 8. 模拟结算回调到本地后端

命令：

```bash
npm run sandbox:settlement
```

实际执行内容：

```bash
node sandbox/scripts/simulate-settlement.mjs
```

作用：

- 把示例“结算商品推送”数据发给本地业务后端
- 测试订单落库、库存变化、额度更新和预警逻辑

目标地址：

- `LOCAL_API_BASE_URL + /cabinet-events/callbacks/settlement`

依赖环境变量：

- `LOCAL_API_BASE_URL`

补充说明：

- 不传参数时，默认读取 `sandbox/fixtures/settlement.sample.json`
- 如果你要用平台实际回调参数，请显式传入你自己的 JSON 文件

例如当前测试柜机 `91120149` 的结算样例：

```bash
npm run sandbox:settlement -- sandbox/fixtures/settlement-91120149.sample.json
```

---

### 9. 创建或覆盖一个模拟柜机

命令：

```bash
npm run sandbox:mock-device
```

实际执行内容：

```bash
node sandbox/scripts/upsert-mock-device.mjs sandbox/fixtures/mock-device.sample.json
```

作用：

- 把示例模拟柜机写入本地后端内存仓储
- 适合你快速准备一个“有 N 个商品库存”的测试柜机

目标地址：

- `LOCAL_API_BASE_URL + /devices/mock/upsert`

依赖环境变量：

- `LOCAL_API_BASE_URL`

---

### 10. 自动补齐最新一条开柜事件的门状态和结算

命令：

```bash
npm run sandbox:latest-event
```

实际执行内容：

```bash
node sandbox/scripts/simulate-latest-event.mjs
```

作用：

- 读取本地后端里最新一条开柜事件
- 自动发送 `door-status`
- 自动发送 `settlement`
- 适合“先在小程序点击开柜，再用一条命令补齐柜机回调”的联调方式

目标地址：

- `LOCAL_API_BASE_URL + /cabinet-events`
- `LOCAL_API_BASE_URL + /devices/:deviceCode`
- `LOCAL_API_BASE_URL + /cabinet-events/callbacks/door-status`
- `LOCAL_API_BASE_URL + /cabinet-events/callbacks/settlement`

可选环境变量：

- `LOCAL_API_BASE_URL`
- `SIM_GOODS_ID`
- `SIM_QUANTITY`

---

### 11. 发送短信验证码

命令：

```bash
npm run sandbox:sms:send -- 13800138000
```

实际执行内容：

```bash
node sandbox/scripts/send-sms-code.mjs 13800138000
```

作用：

- 通过阿里云短信验证码服务向指定手机号发送真实验证码
- 适合先在 `sandbox` 单独验证短信能力，再决定是否接入正式登录/注册流程

依赖环境变量：

- `ALIYUN_SMS_ACCESS_KEY_ID`
- `ALIYUN_SMS_ACCESS_KEY_SECRET`
- `ALIYUN_SMS_REGION_ID`
- `ALIYUN_SMS_ENDPOINT`

补充说明：

- 当前脚本调用的是阿里云官方 SDK 提供的手机验证码接口，不需要你再手动拼接短信模板参数
- 如果没有配置阿里云密钥，脚本会直接报明确提示，不会继续请求外部服务
- 当前脚本只放在 `sandbox`，还没有接进正式业务后端

---

### 12. 校验短信验证码

命令：

```bash
npm run sandbox:sms:verify -- 13800138000 123456
```

实际执行内容：

```bash
node sandbox/scripts/verify-sms-code.mjs 13800138000 123456
```

作用：

- 通过阿里云短信验证码服务校验手机号和验证码是否匹配
- 适合验证真实短信验证码闭环是否可用

依赖环境变量：

- `ALIYUN_SMS_ACCESS_KEY_ID`
- `ALIYUN_SMS_ACCESS_KEY_SECRET`
- `ALIYUN_SMS_REGION_ID`
- `ALIYUN_SMS_ENDPOINT`

补充说明：

- 如果验证码不正确，命令会输出结果并以非 0 退出码结束
- 目前脚本只验证中国大陆手机号格式，即 11 位手机号

## 对应脚本文件

- `sandbox/scripts/generate-signature.mjs`
- `sandbox/scripts/query-device-info.mjs`
- `sandbox/scripts/query-goods.mjs`
- `sandbox/scripts/open-door.mjs`
- `sandbox/scripts/payment-success.mjs`
- `sandbox/scripts/refund.mjs`
- `sandbox/scripts/simulate-door-status.mjs`
- `sandbox/scripts/simulate-latest-event.mjs`
- `sandbox/scripts/simulate-settlement.mjs`
- `sandbox/scripts/upsert-mock-device.mjs`
- `sandbox/scripts/helpers.mjs`
- `sandbox/scripts/aliyun-phone-code.mjs`
- `sandbox/scripts/send-sms-code.mjs`
- `sandbox/scripts/verify-sms-code.mjs`

## 对应示例载荷

- `sandbox/fixtures/open-door.sample.json`
- `sandbox/fixtures/goods-query.sample.json`
- `sandbox/fixtures/door-status.sample.json`
- `sandbox/fixtures/payment-success.sample.json`
- `sandbox/fixtures/refund.sample.json`
- `sandbox/fixtures/settlement.sample.json`
- `sandbox/fixtures/mock-device.sample.json`

## 推荐调试顺序

1. 如果你已知柜机编号，先跑 `npm run sandbox:device -- 柜机编号`
2. 如果你在测本地业务闭环，再跑 `npm run sandbox:mock-device`
3. 再跑 `npm run sandbox:sign`
4. 如果你在测测试平台柜机接口，继续跑 `npm run sandbox:goods -- 柜机编号` 和 `npm run sandbox:door`
5. 如果你在测本地闭环，用小程序或接口触发一次开柜
6. 然后跑 `npm run sandbox:latest-event`
7. 需要补测回写链路时，再跑 `npm run sandbox:payment-success` 或 `npm run sandbox:refund`
