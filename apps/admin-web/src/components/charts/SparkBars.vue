<script setup lang="ts">
defineProps<{
  points: Array<{
    label: string;
    pickups: number;
    donations: number;
  }>;
}>();

const maxValue = (points: Array<{ pickups: number; donations: number }>) =>
  Math.max(...points.map((point) => Math.max(point.pickups, point.donations)), 1);
</script>

<template>
  <div class="chart">
    <div v-for="point in points" :key="point.label" class="chart__column">
      <div class="chart__bars">
        <span class="chart__bar chart__bar--pickup" :style="{ height: `${(point.pickups / maxValue(points)) * 100}%` }" />
        <span class="chart__bar chart__bar--donation" :style="{ height: `${(point.donations / maxValue(points)) * 100}%` }" />
      </div>
      <span class="chart__label">{{ point.label }}</span>
    </div>
  </div>
</template>

<style scoped>
.chart {
  display: grid;
  grid-template-columns: repeat(7, minmax(0, 1fr));
  gap: 0.9rem;
  min-height: 220px;
}

.chart__column {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 0.75rem;
}

.chart__bars {
  flex: 1;
  display: grid;
  grid-template-columns: repeat(2, 18px);
  align-items: end;
  gap: 0.35rem;
  width: 100%;
}

.chart__bar {
  display: block;
  width: 100%;
  border-radius: 999px 999px 6px 6px;
  min-height: 10px;
}

.chart__bar--pickup {
  background: linear-gradient(180deg, #0d9488, #2dd4bf);
}

.chart__bar--donation {
  background: linear-gradient(180deg, #f59e0b, #fb923c);
}

.chart__label {
  color: var(--admin-muted);
  font-size: 0.82rem;
}
</style>
