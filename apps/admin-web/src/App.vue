<script setup lang="ts">
import { computed, onMounted, provide, ref } from "vue";

import { adminCopy } from "./constants/copy";
import { loadPublicRuntimeConfig } from "./utils/public-config";
import {
  runtimeDataPlaneInjectionKey,
  runtimeStatusLabelInjectionKey,
  type RuntimeDataPlane
} from "./utils/runtime-data-plane";

const runtimeDataPlane = ref<RuntimeDataPlane>("unknown");
const runtimeStatusLabel = computed(() => {
  if (runtimeDataPlane.value === "simulation") {
    return adminCopy.runtime.simulationBadge;
  }

  return runtimeDataPlane.value === "unknown" ? adminCopy.runtime.statusPendingBadge : "";
});

provide(runtimeDataPlaneInjectionKey, runtimeDataPlane);
provide(runtimeStatusLabelInjectionKey, runtimeStatusLabel);

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
  <span
    v-if="runtimeStatusLabel"
    class="runtime-status-announcement"
    role="status"
    aria-live="polite"
    aria-atomic="true"
  >
    {{ runtimeStatusLabel }}
  </span>
  <router-view />
</template>

<style scoped>
.runtime-status-announcement {
  position: absolute;
  width: 1px;
  height: 1px;
  padding: 0;
  margin: -1px;
  overflow: hidden;
  clip: rect(0, 0, 0, 0);
  white-space: nowrap;
  border: 0;
}
</style>
