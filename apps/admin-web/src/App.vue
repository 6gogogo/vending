<script setup lang="ts">
import { computed, onMounted, ref } from "vue";

import { adminCopy } from "./constants/copy";
import { loadPublicRuntimeConfig } from "./utils/public-config";

const runtimeDataPlane = ref<"simulation" | "live" | "unknown">("unknown");

const runtimeBadgeLabel = computed(() => {
  if (runtimeDataPlane.value === "simulation") {
    return adminCopy.runtime.simulationBadge;
  }

  return runtimeDataPlane.value === "unknown" ? adminCopy.runtime.unknownBadge : "";
});

onMounted(async () => {
  try {
    const config = await loadPublicRuntimeConfig();
    runtimeDataPlane.value =
      config.runtimeDataPlane === "simulation" || config.runtimeDataPlane === "live"
        ? config.runtimeDataPlane
        : "unknown";
  } catch {
    runtimeDataPlane.value = "unknown";
  }
});
</script>

<template>
  <div
    v-if="runtimeBadgeLabel"
    class="runtime-instance-badge"
    role="status"
    aria-live="polite"
    aria-atomic="true"
  >
    {{ runtimeBadgeLabel }}
  </div>
  <router-view />
</template>

<style scoped>
.runtime-instance-badge {
  position: fixed;
  z-index: 1000;
  top: 12px;
  right: 12px;
  max-width: calc(100vw - 24px);
  padding: 7px 12px;
  border: 1px solid rgba(146, 64, 14, 0.36);
  border-radius: 999px;
  color: #78350f;
  background: rgba(255, 247, 237, 0.96);
  box-shadow: 0 6px 18px rgba(120, 53, 15, 0.14);
  font-size: 13px;
  font-weight: 700;
  line-height: 1.2;
  pointer-events: none;
}

@media (max-width: 640px) {
  .runtime-instance-badge {
    top: 8px;
    right: 8px;
    max-width: calc(100vw - 16px);
    padding: 6px 10px;
    font-size: 12px;
  }
}
</style>
