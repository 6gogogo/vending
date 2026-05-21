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
  position: relative;
  display: grid;
  gap: 7px;
  min-height: 118px;
  padding: 16px;
  border: 1px solid var(--admin-line);
  border-radius: 8px;
  background: var(--admin-panel);
  overflow: hidden;
  transition: border-color 160ms ease, background-color 160ms ease, box-shadow 160ms ease;
}

.stat-tile::before {
  content: "";
  position: absolute;
  inset: 0 0 auto;
  height: 3px;
  background: var(--admin-line-strong);
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
  font-size: 1.9rem;
  line-height: 1.1;
  color: var(--admin-text);
}

.stat-tile__hint {
  color: var(--admin-muted);
  font-size: 0.84rem;
  line-height: 1.45;
}

.stat-tile__action {
  align-self: end;
  color: var(--admin-accent-strong);
  font-size: 0.82rem;
  font-weight: 700;
}

.stat-tile--accent {
  border-color: #bdd9d0;
  background: var(--admin-accent-soft);
}

.stat-tile--accent::before {
  background: var(--admin-accent);
}

.stat-tile--success {
  border-color: #c4decf;
  background: #f1f8f4;
}

.stat-tile--success::before {
  background: var(--admin-success);
}

.stat-tile--warning {
  border-color: #e8cf9e;
  background: #fff7e8;
}

.stat-tile--warning::before {
  background: var(--admin-warning);
}
</style>
