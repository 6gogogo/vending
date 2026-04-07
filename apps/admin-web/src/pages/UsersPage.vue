<script setup lang="ts">
import { computed, onMounted, ref } from "vue";
import type { UserRecord } from "@vm/shared-types";

import { adminApi } from "../api/admin";

const users = ref<UserRecord[]>([]);

onMounted(async () => {
  users.value = await adminApi.users();
});

const grouped = computed(() => ({
  admins: users.value.filter((user) => user.role === "admin"),
  specials: users.value.filter((user) => user.role === "special"),
  merchants: users.value.filter((user) => user.role === "merchant")
}));
</script>

<template>
  <section class="page">
    <header>
      <span class="admin-pill">身份台账</span>
      <h1 class="admin-title">已登记用户与商户</h1>
      <p class="admin-subtitle">导入接口已经具备首版能力，这个页面优先保证信息直观可查，方便街道工作人员日常管理。</p>
    </header>

    <div class="columns">
      <article class="admin-card panel">
        <h2>管理员</h2>
        <div v-for="user in grouped.admins" :key="user.id" class="row">
          <strong>{{ user.name }}</strong>
          <span class="admin-subtitle">{{ user.phone }}</span>
        </div>
      </article>

      <article class="admin-card panel">
        <h2>特殊群体</h2>
        <div v-for="user in grouped.specials" :key="user.id" class="row">
          <div>
            <strong>{{ user.name }}</strong>
            <p class="admin-subtitle">{{ user.tags.join("、") || "暂未设置标签" }}</p>
          </div>
          <span class="admin-pill">{{ user.phone }}</span>
        </div>
      </article>

      <article class="admin-card panel">
        <h2>商户</h2>
        <div v-for="user in grouped.merchants" :key="user.id" class="row">
          <div>
            <strong>{{ user.name }}</strong>
            <p class="admin-subtitle">{{ user.merchantProfile?.defaultDeviceCodes.join(", ") }}</p>
          </div>
          <span class="admin-pill">{{ user.phone }}</span>
        </div>
      </article>
    </div>
  </section>
</template>

<style scoped>
.page {
  display: grid;
  gap: 24px;
}

.columns {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 18px;
}

.panel {
  padding: 22px;
}

.panel h2 {
  margin-top: 0;
}

.row {
  display: flex;
  justify-content: space-between;
  gap: 18px;
  padding: 16px 0;
  border-bottom: 1px solid var(--admin-line);
}

.row p {
  margin: 0.35rem 0 0;
}

@media (max-width: 1100px) {
  .columns {
    grid-template-columns: 1fr;
  }
}
</style>
