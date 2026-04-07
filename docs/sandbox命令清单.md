# Sandbox 命令清单

`sandbox` 目录里的脚本是为了单独调试接口，不让这些调试逻辑混进正式业务代码。

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
node sandbox/scripts/payment-success.mjs sandbox/fixtures/payment-success.sample.json
```

作用：

- 请求 SmartVM 的“付款成功异步通知”接口
- 用于补测结算成功后第三方支付回写链路

目标地址：

- `SMARTVM_BASE_URL + /api/pay/container/paymentSuccess`

依赖环境变量：

- `SMARTVM_BASE_URL`
- `SMARTVM_CLIENT_ID`
- `SMARTVM_KEY`

补充说明：

- 如果你还没有真实的 SmartVM 签名参数，这个命令不会继续请求测试平台

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

---

### 8. 模拟结算回调到本地后端

命令：

```bash
npm run sandbox:settlement
```

实际执行内容：

```bash
node sandbox/scripts/simulate-settlement.mjs sandbox/fixtures/settlement.sample.json
```

作用：

- 把示例“结算商品推送”数据发给本地业务后端
- 测试订单落库、库存变化、额度更新和预警逻辑

目标地址：

- `LOCAL_API_BASE_URL + /cabinet-events/callbacks/settlement`

依赖环境变量：

- `LOCAL_API_BASE_URL`

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
