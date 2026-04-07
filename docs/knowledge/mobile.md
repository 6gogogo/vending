# mobile 知识点与目录说明

`mobile` 不是原生 Android 工程，而是 `uni-app` 项目。你可以把它理解成“一套 Vue 风格代码，编译成 H5、微信小程序、支付宝小程序和 App”。

## 目录结构

- `apps/mobile/index.html`
  作用：H5 入口文件。

- `apps/mobile/src/main.ts`
  作用：启动移动端应用。

- `apps/mobile/src/App.vue`
  作用：最外层应用组件。

- `apps/mobile/src/pages.json`
  作用：uni-app 页面注册表，类似“小程序页面配置”。

- `apps/mobile/src/pages`
  作用：页面目录。

- `apps/mobile/src/layouts`
  作用：公共页面壳子。

- `apps/mobile/src/components`
  作用：通用 UI 组件。

- `apps/mobile/src/composables`
  作用：可复用业务逻辑，比如登录流、开柜流。

- `apps/mobile/src/api`
  作用：移动端请求后端的统一入口。

- `apps/mobile/src/stores`
  作用：当前登录信息、额度等状态存储。

- `apps/mobile/src/constants`
  作用：文案、标签映射等静态数据。

## 你需要掌握的知识点

### 1. uni-app 和普通 Vue 的关系

它们写法很像，但不是完全一样。

你现在主要会遇到：

- 页面需要在 `pages.json` 注册
- 用 `uni.navigateTo`、`uni.reLaunch` 跳转
- 有些标签是 `view`、`text`、`button`

### 2. 运行方式

- `npm run dev:mobile`：H5 网页预览
- `npm run dev:mobile:weixin`：微信小程序开发模式
- `npm run build:mobile:weixin`：构建微信小程序产物

### 3. 组合式函数 `composables`

这里是你最值得学习的部分。

例如：

- `useAuthFlow.ts`
- `useCabinetFlow.ts`

可以把它们理解为：

- 不是页面
- 也不是纯工具函数
- 而是“可复用的业务流程”

### 4. 状态管理

`stores/session.ts` 保存：

- 当前 token
- 当前用户
- 当前额度信息

### 5. 页面和逻辑分离

当前项目故意这样拆：

- 页面 `.vue` 负责展示
- `composables` 负责业务流程
- `api` 负责接口调用

这就是你之前要求的“逻辑和 UI 分开”。

## 建议你先看的文件顺序

1. `apps/mobile/src/pages.json`
2. `apps/mobile/src/main.ts`
3. `apps/mobile/src/pages/common/login.vue`
4. `apps/mobile/src/composables/useAuthFlow.ts`
5. `apps/mobile/src/pages/special/home.vue`
6. `apps/mobile/src/composables/useCabinetFlow.ts`
