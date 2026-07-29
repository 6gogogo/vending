<script setup lang="ts">
import { computed } from "vue";

import AssignedDeviceDetailPage from "./AssignedDeviceDetailPage.vue";
import DeviceDetailPage from "./DeviceDetailPage.vue";
import { useAdminSessionStore } from "../stores/session";

const sessionStore = useAdminSessionStore();
const usesAssignedDeviceWorkspace = computed(() =>
  sessionStore.user?.backofficeRole === "merchant" ||
  sessionStore.user?.backofficeRole === "restocker"
);
</script>

<template>
  <AssignedDeviceDetailPage v-if="usesAssignedDeviceWorkspace" />
  <DeviceDetailPage v-else />
</template>
