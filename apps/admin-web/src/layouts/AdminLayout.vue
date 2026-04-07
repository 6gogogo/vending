<template>
  <div class="admin-shell layout">
    <aside class="admin-card layout__nav">
      <div>
        <span class="admin-pill">电脑后台</span>
        <h1 class="layout__brand">公益智助柜</h1>
        <p class="admin-subtitle">在一个桌面视图里查看角色数据、领取规则、柜机状态和过期预警。</p>
      </div>

      <nav class="layout__links">
        <RouterLink to="/dashboard" class="layout__link" active-class="layout__link--active">总览</RouterLink>
        <RouterLink to="/operations" class="layout__link" active-class="layout__link--active">柜机监控</RouterLink>
        <RouterLink to="/users" class="layout__link" active-class="layout__link--active">用户管理</RouterLink>
        <RouterLink to="/rules" class="layout__link" active-class="layout__link--active">规则配置</RouterLink>
        <RouterLink to="/alerts" class="layout__link" active-class="layout__link--active">预警处理</RouterLink>
      </nav>
    </aside>

    <main class="layout__main">
      <RouterView />
    </main>
  </div>
</template>

<style scoped>
.layout {
  display: grid;
  grid-template-columns: 320px 1fr;
  gap: 24px;
}

.layout__nav {
  display: flex;
  flex-direction: column;
  justify-content: space-between;
  min-height: calc(100vh - 48px);
  padding: 28px;
}

.layout__brand {
  margin: 1rem 0 0.75rem;
  font-size: 2.7rem;
  line-height: 0.95;
}

.layout__links {
  display: grid;
  gap: 0.7rem;
}

.layout__link {
  padding: 0.95rem 1rem;
  border-radius: 18px;
  color: var(--admin-muted);
  text-decoration: none;
  transition: 180ms ease;
}

.layout__link:hover,
.layout__link--active {
  background: rgba(13, 148, 136, 0.12);
  color: var(--admin-accent-strong);
}

.layout__main {
  min-width: 0;
}

@media (max-width: 960px) {
  .layout {
    grid-template-columns: 1fr;
  }

  .layout__nav {
    min-height: auto;
  }
}
</style>
