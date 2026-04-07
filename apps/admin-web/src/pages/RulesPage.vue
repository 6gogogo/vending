<script setup lang="ts">
import { onMounted, reactive } from "vue";
import type { CabinetAccessRule } from "@vm/shared-types";

import { adminApi } from "../api/admin";
import { categoryLabelMap, roleLabelMap } from "../utils/labels";

const form = reactive<Record<"special" | "merchant", CabinetAccessRule | undefined>>({
  special: undefined,
  merchant: undefined
});

const load = async () => {
  const rules = await adminApi.rules();
  form.special = rules.find((rule) => rule.role === "special");
  form.merchant = rules.find((rule) => rule.role === "merchant");
};

const save = async (role: "special" | "merchant") => {
  const current = form[role];
  if (!current) {
    return;
  }

  await adminApi.updateRule(role, {
    dailyLimit: current.dailyLimit,
    categoryLimit: current.categoryLimit
  });

  await load();
};

onMounted(load);
</script>

<template>
  <section class="page">
    <header>
      <span class="admin-pill">规则层</span>
      <h1 class="admin-title">额度与领取规则配置</h1>
      <p class="admin-subtitle">规则以独立业务配置存储，后续即使更换界面，也不需要重写核心规则逻辑。</p>
    </header>

    <div class="cards">
      <article v-for="role in ['special', 'merchant']" :key="role" class="admin-card panel">
        <template v-if="form[role]">
          <h2>{{ roleLabelMap[role as 'special' | 'merchant'] }}</h2>
          <label class="field">
            <span>每日上限</span>
            <input v-model.number="form[role]!.dailyLimit" type="number" min="0" />
          </label>
          <label v-for="entry in Object.entries(form[role]!.categoryLimit)" :key="entry[0]" class="field">
            <span>{{ categoryLabelMap[entry[0] as keyof typeof categoryLabelMap] }}</span>
            <input v-model.number="form[role]!.categoryLimit[entry[0]]" type="number" min="0" />
          </label>
          <button class="admin-button" @click="save(role as 'special' | 'merchant')">保存{{ roleLabelMap[role as 'special' | 'merchant'] }}规则</button>
        </template>
      </article>
    </div>
  </section>
</template>

<style scoped>
.page,
.cards {
  display: grid;
  gap: 24px;
}

.cards {
  grid-template-columns: repeat(2, minmax(0, 1fr));
}

.panel {
  padding: 24px;
}

.field {
  display: grid;
  gap: 8px;
  margin-bottom: 16px;
}

.field input {
  min-height: 44px;
  border-radius: 14px;
  border: 1px solid var(--admin-line);
  padding: 0 14px;
  background: white;
}

@media (max-width: 900px) {
  .cards {
    grid-template-columns: 1fr;
  }
}
</style>
