<script setup lang="ts">
defineProps<{
  title: string;
  value: string | number;
  hint: string;
}>();
</script>

<template>
  <article class="admin-card stat-tile">
    <p class="stat-tile__title">{{ title }}</p>
    <p class="stat-tile__value">{{ value }}</p>
    <p class="stat-tile__hint">{{ hint }}</p>
  </article>
</template>

<style scoped>
.stat-tile {
  padding: 1.4rem;
}

.stat-tile__title,
.stat-tile__hint {
  margin: 0;
  color: var(--admin-muted);
}

.stat-tile__value {
  margin: 0.55rem 0 0.4rem;
  font-size: 2.35rem;
  font-weight: 700;
}
</style>
