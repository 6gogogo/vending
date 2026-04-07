# admin-web 知识点与目录说明

如果你只学过 HTML 和 CSS，可以把 `admin-web` 理解为“在 HTML/CSS 基础上，加了 Vue 组件、路由和接口请求”。

## 目录结构

- `apps/admin-web/index.html`
  作用：网页入口壳子，相当于传统 HTML 页面的最外层。

- `apps/admin-web/src/main.ts`
  作用：启动 Vue 应用、挂载路由、挂载状态管理。

- `apps/admin-web/src/App.vue`
  作用：最外层 Vue 组件，目前主要负责渲染路由页面。

- `apps/admin-web/src/router`
  作用：页面路由，相当于“访问哪个路径显示哪个页面”。

- `apps/admin-web/src/layouts`
  作用：公共布局，例如左侧导航 + 右侧内容区。

- `apps/admin-web/src/pages`
  作用：真正的页面文件。

- `apps/admin-web/src/components`
  作用：可复用组件，比如统计卡片、图表。

- `apps/admin-web/src/api`
  作用：调用后端接口，不把 `fetch` 分散写在页面里。

- `apps/admin-web/src/styles`
  作用：全局样式。

- `apps/admin-web/src/utils`
  作用：标签映射、格式化等小工具。

## 你需要掌握的知识点

### 1. HTML 基础在这里怎么对应

- 传统 HTML 标签：`div`、`p`、`button`
- 在 Vue 里仍然能用，只是写在 `.vue` 文件里

### 2. CSS 基础在这里怎么对应

- 你学过的选择器、盒模型、弹性布局依然完全可用
- `scoped` 样式表示这个样式只作用于当前组件

### 3. Vue 单文件组件

一个 `.vue` 文件通常分三块：

- `<script setup>`：写逻辑
- `<template>`：写结构
- `<style>`：写样式

### 4. 路由

这里用的是 `vue-router`。

你可以理解成：

- `/dashboard` 显示总览页
- `/operations` 显示柜机监控页
- `/users` 显示用户页
- `/rules` 显示规则页
- `/alerts` 显示预警页

### 5. 组件复用

例如：

- `StatTile.vue` 不是一个完整页面
- 它只是一个“统计卡片模板”
- 页面可以重复使用很多次

### 6. 接口调用

`src/api/admin.ts` 负责统一请求后端。

这样做的好处：

- 页面代码更干净
- 后面改接口地址时集中修改
- 更容易排查问题

### 7. 状态管理

这里用了 `pinia`，但目前后台用得不重。

你可以先把它理解为“全局变量升级版”，用于在多个页面之间共享状态。

## 建议你先看的文件顺序

1. `apps/admin-web/index.html`
2. `apps/admin-web/src/main.ts`
3. `apps/admin-web/src/App.vue`
4. `apps/admin-web/src/router/index.ts`
5. `apps/admin-web/src/layouts/AdminLayout.vue`
6. `apps/admin-web/src/pages/DashboardPage.vue`
