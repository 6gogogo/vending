import { createSSRApp } from "vue";
import { createPinia } from "pinia";

import App from "./App.vue";

export function createApp() {
  const app = createSSRApp(App);
  const pinia = createPinia();

  // uni-app 的 createSSRApp 类型定义比标准 Vue 偏窄，这里显式兼容 Pinia 插件类型。
  app.use(pinia as never);
  return {
    app
  };
}
