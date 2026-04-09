<script setup lang="ts">
withDefaults(
  defineProps<{
    title: string;
    value: string | number;
    hint?: string;
    actionLabel?: string;
    tone?: "neutral" | "accent" | "warning" | "success";
  }>(),
  {
    hint: "",
    actionLabel: "",
    tone: "neutral"
  }
);
</script>

<template>
  <article class="stat-tile" :class="`stat-tile--${tone}`">
    <span class="stat-tile__title">{{ title }}</span>
    <strong class="stat-tile__value">{{ value }}</strong>
    <span v-if="hint" class="stat-tile__hint">{{ hint }}</span>
    <span v-if="actionLabel" class="stat-tile__action">{{ actionLabel }}</span>
  </article>
</template>

<style scoped>
.stat-tile {
  display: grid;
  gap: 6px;
  min-height: 110px;
  padding: 12px 14px;
  border: 1px solid var(--admin-line);
  border-radius: 8px;
  background: var(--admin-panel);
}

.stat-tile__title {
  color: var(--admin-muted);
  font-size: 0.78rem;
  font-weight: 700;
  letter-spacing: 0.04em;
  text-transform: uppercase;
}

.stat-tile__value {
  font-family: var(--admin-code-font);
  font-size: 1.75rem;
  line-height: 1.1;
  color: var(--admin-text);
}

.stat-tile__hint {
  color: var(--admin-muted);
  font-size: 0.84rem;
  line-height: 1.45;
}

.stat-tile__action {
  color: var(--admin-accent-strong);
  font-size: 0.82rem;
  font-weight: 700;
}

.stat-tile--accent {
  border-color: #aebfe1;
  background: var(--admin-accent-soft);
}

.stat-tile--success {
  border-color: #b9dec6;
  background: #edf8f1;
}

.stat-tile--warning {
  border-color: #efcf8d;
  background: #fff7e8;
}
</style>
