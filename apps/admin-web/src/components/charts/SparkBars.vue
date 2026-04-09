<script setup lang="ts">
import { computed } from "vue";

const props = defineProps<{
  points: Array<{
    label: string;
    pickups: number;
    donations: number;
  }>;
}>();

const maxValue = computed(() =>
  Math.max(
    ...props.points.map((point) => Math.max(point.pickups, point.donations)),
    1
  )
);
</script>

<template>
  <div class="chart">
    <div v-for="point in points" :key="point.label" class="chart__column">
      <div class="chart__lane">
        <span class="chart__bar chart__bar--pickup" :style="{ height: `${(point.pickups / maxValue) * 100}%` }" />
        <span class="chart__bar chart__bar--donation" :style="{ height: `${(point.donations / maxValue) * 100}%` }" />
      </div>
      <div class="chart__legend">
        <span class="chart__label">{{ point.label }}</span>
        <span class="chart__value">领 {{ point.pickups }} / 投 {{ point.donations }}</span>
      </div>
    </div>
  </div>
</template>

<style scoped>
.chart {
  display: grid;
  grid-template-columns: repeat(7, minmax(0, 1fr));
  gap: 12px;
  min-height: 260px;
}

.chart__column {
  display: grid;
  grid-template-rows: minmax(0, 1fr) auto;
  gap: 12px;
}

.chart__lane {
  display: grid;
  grid-template-columns: repeat(2, minmax(14px, 1fr));
  align-items: end;
  gap: 6px;
  padding: 16px 12px 14px;
  border-radius: 22px;
  background: rgba(255, 255, 255, 0.52);
  border: 1px solid rgba(127, 96, 61, 0.1);
}

.chart__bar {
  display: block;
  width: 100%;
  min-height: 10px;
  border-radius: 999px 999px 8px 8px;
}

.chart__bar--pickup {
  background: linear-gradient(180deg, #22b17b, #16895c);
}

.chart__bar--donation {
  background: linear-gradient(180deg, #f4b34c, #df8d17);
}

.chart__legend {
  display: flex;
  flex-direction: column;
  gap: 4px;
  text-align: center;
}

.chart__label {
  font-size: 0.84rem;
  font-weight: 700;
}

.chart__value {
  font-size: 0.78rem;
  color: var(--admin-muted);
}

@media (max-width: 860px) {
  .chart {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }
}
</style>
