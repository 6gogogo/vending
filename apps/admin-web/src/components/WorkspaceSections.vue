<script setup lang="ts">
import { RouterLink, useRoute } from "vue-router";

defineProps<{ active: string; items: Array<{ value: string; label: string; count?: number }> }>();
const route = useRoute();
</script>

<template>
  <nav class="workspace-sections" aria-label="页面分区">
    <RouterLink v-for="item in items" :key="item.value"
      :to="{ path: route.path, query: { ...route.query, section: item.value } }"
      class="workspace-sections__link" :class="{ 'is-active': active === item.value }"
      :aria-current="active === item.value ? 'page' : undefined">
      {{ item.label }}<span v-if="item.count !== undefined" class="workspace-sections__count">{{ item.count }}</span>
    </RouterLink>
  </nav>
</template>
