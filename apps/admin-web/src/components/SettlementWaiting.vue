<script setup lang="ts">
import type { AlertTask } from "@vm/shared-types";
import { formatDateTime } from "../utils/datetime";

defineProps<{ waiting?: AlertTask["settlementWaiting"]; detail?: boolean }>();
const duration = (minutes: number) => {
  const hours = Math.floor(minutes / 60);
  return hours ? `${hours} 小时 ${minutes % 60} 分钟` : `${minutes} 分钟`;
};
</script>

<template>
  <span v-if="waiting" class="settlement-waiting">
    <strong>已等待结算 {{ duration(waiting.elapsedMinutes) }}</strong>
    <span class="settlement-waiting__meta">超过提醒阈值 {{ duration(waiting.overdueMinutes) }}</span>
    <span v-if="detail" class="settlement-waiting__meta">从可信关门 {{ formatDateTime(waiting.closedAt) }} 起算<br>更新于 {{ formatDateTime(waiting.checkedAt) }}</span>
  </span>
</template>

<style scoped>
.settlement-waiting { display: block; margin-top: 6px; line-height: 1.6; white-space: normal; }
.settlement-waiting > strong { color: #9a4b0a; font-size: 14px; }
.settlement-waiting__meta { display: block; color: var(--admin-text-muted, #64748b); font-size: 12px; font-weight: 400; }
</style>
