# api 知识点与目录说明

`api` 是 NestJS 后端。你可以先把它理解成“比 Express 更结构化的 Node.js 后端框架”。

## 目录结构

- `apps/api/src/main.ts`
  作用：后端启动入口。

- `apps/api/src/app.module.ts`
  作用：总模块，负责把各个业务模块组装起来。

- `apps/api/src/common`
  作用：公共能力。

- `apps/api/src/modules`
  作用：具体业务模块。

## common 里有什么

- `dto`
  作用：统一返回结构。

- `guards`
  作用：接口访问控制，例如按角色限制接口。

- `store`
  作用：当前首版的内存数据存储。

## modules 里有什么

- `auth`
  登录、验证码、会话

- `users`
  用户与商户导入、查询

- `access-rules`
  每日次数和品类额度规则

- `devices`
  柜机与商品信息

- `cabinet-events`
  开门、门状态回调、结算回调

- `inventory-orders`
  领取、投放、退款、补扣记录

- `alerts`
  过期预警与异常预警

- `analytics`
  基础统计与扩展接口

## 你需要掌握的知识点

### 1. Module

NestJS 用模块组织代码。

你可以理解成：

- 一个模块 = 一组相关功能

### 2. Controller

控制器负责接 HTTP 请求。

例如：

- `GET /api/devices`
- `POST /api/cabinet-events/open`

### 3. Service

服务负责写业务逻辑。

例如：

- 校验手机号
- 判断额度是否够
- 创建开柜事件

### 4. DTO / 返回结构

当前项目用了统一包裹格式：

```json
{
  "code": 200,
  "message": "成功",
  "data": {}
}
```

### 5. Guard

Guard 用于控制谁可以访问某个接口。

这里主要用了角色控制：

- 管理员
- 商户
- 特殊群体

### 6. 当前为什么是内存仓储

因为首版重点是把流程跑通。

所以现在数据存在内存里，优点是：

- 改动快
- 调试快
- 不会被数据库设计拖住进度

后面再替换成 PostgreSQL / Redis。

## 建议你先看的文件顺序

1. `apps/api/src/main.ts`
2. `apps/api/src/app.module.ts`
3. `apps/api/src/modules/auth`
4. `apps/api/src/modules/cabinet-events`
5. `apps/api/src/modules/devices`
6. `apps/api/src/common/store/in-memory-store.service.ts`
