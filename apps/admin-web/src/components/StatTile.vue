<script setup lang="ts">
import { computed } from "vue";

const props = withDefaults(
  defineProps<{
    title: string;
    value: string | number;
    hint?: string;
    actionLabel?: string;
    tone?: "neutral" | "accent" | "warning" | "success";
    sparkline?: number[];
    sparklineLabel?: string;
  }>(),
  {
    hint: "",
    actionLabel: "",
    tone: "neutral",
    sparkline: () => [],
    sparklineLabel: ""
  }
);

const sparklinePoints = computed(() => {
  const values = props.sparkline.filter((value) => Number.isFinite(value));

  if (values.length < 2) {
    return "";
  }

  const width = 92;
  const height = 36;
  const padding = 4;
  const min = Math.min(...values);
  const max = Math.max(...values);
  const sameValue = min === max;
  const plotWidth = width - padding * 2;
  const plotHeight = height - padding * 2;

  return values
    .map((value, index) => {
      const x = padding + (index / (values.length - 1)) * plotWidth;
      const y = sameValue
        ? height / 2
        : padding + plotHeight - ((value - min) / (max - min)) * plotHeight;

      return `${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(" ");
});

const hasSparkline = computed(() => Boolean(sparklinePoints.value));
</script>

<template>
  <article class="stat-tile" :class="`stat-tile--${tone}`">
    <div class="stat-tile__head">
      <span class="stat-tile__icon" aria-hidden="true"></span>
      <span class="stat-tile__title">{{ title }}</span>
    </div>
    <div class="stat-tile__body">
      <div>
        <strong class="stat-tile__value">{{ value }}</strong>
        <span v-if="hint" class="stat-tile__hint">{{ hint }}</span>
      </div>
      <svg
        v-if="hasSparkline"
        class="stat-tile__spark"
        viewBox="0 0 92 36"
        role="img"
        :aria-label="sparklineLabel || `${title}近 7 日趋势`"
      >
        <polyline :points="sparklinePoints" />
      </svg>
    </div>
    <span v-if="actionLabel" class="stat-tile__action">{{ actionLabel }}</span>
  </article>
</template>

<style scoped>
.stat-tile {
  position: relative;
  display: grid;
  gap: 9px;
  min-height: 112px;
  padding: 14px;
  border: 1px solid var(--admin-line);
  border-radius: 8px;
  background: var(--admin-panel);
  overflow: hidden;
  transition: border-color 160ms ease, background-color 160ms ease, box-shadow 160ms ease;
}

.stat-tile::before {
  display: none;
}

.stat-tile__head,
.stat-tile__body {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 12px;
}

.stat-tile__icon {
  width: 24px;
  height: 24px;
  flex: 0 0 24px;
  border: 1px solid rgba(8, 91, 76, 0.22);
  border-radius: 50%;
  background:
    radial-gradient(circle at 50% 50%, var(--admin-accent) 0 3px, transparent 4px),
    var(--admin-accent-soft);
}

.stat-tile__title {
  color: var(--admin-muted);
  font-size: 0.82rem;
  font-weight: 800;
  letter-spacing: 0;
}

.stat-tile__value {
  font-family: var(--admin-code-font);
  font-size: 1.78rem;
  line-height: 1.1;
  color: var(--admin-text);
  font-variant-numeric: tabular-nums;
}

.stat-tile__hint {
  display: block;
  margin-top: 5px;
  color: var(--admin-muted);
  font-size: 0.78rem;
  line-height: 1.45;
}

.stat-tile__spark {
  width: 78px;
  height: 34px;
  flex: 0 0 78px;
  align-self: end;
  color: var(--admin-accent);
}

.stat-tile__spark path,
.stat-tile__spark polyline {
  fill: none;
  stroke: currentColor;
  stroke-linecap: round;
  stroke-linejoin: round;
  stroke-width: 3;
}

.stat-tile__action {
  align-self: end;
  color: var(--admin-accent-strong);
  font-size: 0.82rem;
  font-weight: 700;
}

.stat-tile--accent {
  border-color: #bdd9d0;
  background: linear-gradient(180deg, #ffffff 0%, #f2faf8 100%);
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
  background: linear-gradient(180deg, #ffffff 0%, #fff9ed 100%);
}

.stat-tile--warning .stat-tile__icon {
  border-color: rgba(245, 166, 35, 0.34);
  background:
    radial-gradient(circle at 50% 50%, var(--admin-warning) 0 3px, transparent 4px),
    #fff7e8;
}

.stat-tile--warning .stat-tile__spark {
  color: var(--admin-warning);
}
</style>
