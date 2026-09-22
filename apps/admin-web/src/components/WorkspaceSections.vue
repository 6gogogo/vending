<script setup lang="ts">
import { RouterLink, useRoute, useRouter } from "vue-router";

defineProps<{ active: string; items: Array<{ value: string; label: string; count?: number }> }>();
const route = useRoute();
const router = useRouter();
const selectSection = (event: Event) => {
  const section = (event.target as HTMLSelectElement).value;
  void router.push({ path: route.path, query: { ...route.query, section } });
};
</script>

<template>
  <nav class="workspace-sections" aria-label="页面分区">
    <label class="workspace-sections__mobile">
      <span>当前分区</span>
      <select class="admin-select" :value="active" @change="selectSection">
        <option v-for="item in items" :key="item.value" :value="item.value">
          {{ item.label }}{{ item.count === undefined ? '' : `（${item.count}）` }}
        </option>
      </select>
    </label>
    <RouterLink v-for="item in items" :key="item.value"
      :to="{ path: route.path, query: { ...route.query, section: item.value } }"
      class="workspace-sections__link" :class="{ 'is-active': active === item.value }"
      :aria-current="active === item.value ? 'page' : undefined">
      {{ item.label }}<span v-if="item.count !== undefined" class="workspace-sections__count">{{ item.count }}</span>
    </RouterLink>
  </nav>
</template>
