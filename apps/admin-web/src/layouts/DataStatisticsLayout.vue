<script setup lang="ts">
import { RouterLink, RouterView, useRoute } from "vue-router";

const route = useRoute();
const modules = [
  { path: "/data-monitor", label: "每日运营" },
  { path: "/data-monitor/service-visits", label: "服务人次" },
  { path: "/data-monitor/export", label: "数据导出" }
];
</script>

<template>
  <section>
    <nav class="admin-tabs statistics-modules" aria-label="数据分析子模块">
      <RouterLink
        v-for="module in modules"
        :key="module.path"
        :to="module.path"
        class="admin-tab"
        :class="{ 'admin-tab--active': route.path === module.path }"
        :aria-current="route.path === module.path ? 'page' : undefined"
      >
        {{ module.label }}
      </RouterLink>
    </nav>
    <RouterView />
  </section>
</template>

<style scoped>
.statistics-modules {
  display: flex;
  gap: 6px;
  width: fit-content;
  max-width: 100%;
  padding: 5px;
  border: 1px solid #dce6df;
  background: #f0f5f1;
  border-radius: 12px;
  margin-bottom: 24px;
  overflow-y: hidden;
}

.statistics-modules a {
  padding: 10px 22px;
  border-radius: 8px;
  font-size: 14px;
  font-weight: 600;
  white-space: nowrap;
  color: #63736d;
  text-decoration: none;
}
.statistics-modules .admin-tab--active {
  color: #216e56;
  background: white;
  box-shadow: 0 1px 4px #233a3014;
}
.statistics-modules a:focus-visible { outline: 2px solid #216e56; outline-offset: 2px; }

@media (max-width: 480px) {
  .statistics-modules { width: 100%; }
  .statistics-modules a { flex: 1; padding: 10px 8px; text-align: center; }
}
</style>
