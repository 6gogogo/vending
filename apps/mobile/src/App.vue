<script setup lang="ts">
import { onLaunch } from "@dcloudio/uni-app";

import { useSessionStore } from "./stores/session";

import "./styles/theme.css";

const sessionStore = useSessionStore();

onLaunch(() => {
  sessionStore.bootstrap();
});
</script>

<template>
  <slot />
</template>
