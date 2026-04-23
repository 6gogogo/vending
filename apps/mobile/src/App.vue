<script setup lang="ts">
import { onLaunch } from "@dcloudio/uni-app";

import { useSessionStore } from "./stores/session";
import { useUiPreferencesStore } from "./stores/ui-preferences";

import "./styles/theme.css";

const sessionStore = useSessionStore();
const uiPreferencesStore = useUiPreferencesStore();

onLaunch(() => {
  uiPreferencesStore.hydrate();
  sessionStore.bootstrap();
});
</script>

<template>
  <slot />
</template>
