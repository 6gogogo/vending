# shared 与工具链说明

## `packages/shared-types`

这个包放的是共享类型。

作用：

- 后端和前端都用同一套字段定义
- 避免前后端字段名不一致

## `packages/shared-client`

这个包放的是共享请求工具和 SmartVM 签名逻辑。

作用：

- 封装通用 HTTP 请求
- 集中处理 SmartVM 的签名算法

## 根目录脚本

常用脚本如下：

- `npm run dev:api`
- `npm run dev:api:once`
- `npm run dev:admin`
- `npm run dev:mobile`
- `npm run dev:mobile:weixin`
- `npm run build:mobile:weixin`
- `npm run sandbox:sign`
- `npm run sandbox:goods`
- `npm run sandbox:door`
- `npm run sandbox:door-status`
- `npm run sandbox:settlement`

## `typecheck` 和 `build`

- `npm run typecheck`
  只检查 TypeScript 类型是否正确

- `npm run build`
  真正构建后端、后台和移动端

如果你改了结构、接口或页面，建议先跑：

1. `npm run typecheck`
2. `npm run build`
