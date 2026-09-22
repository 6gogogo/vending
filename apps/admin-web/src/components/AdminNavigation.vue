<script setup lang="ts">
import { RouterLink, useRoute } from "vue-router";
import { BookOpen, Building2, ChartNoAxesCombined, LayoutDashboard, Network, Package, PanelsTopLeft, ScrollText, Settings2, Sparkles, Store, UsersRound, Warehouse } from "@lucide/vue";
import { isAdminDestinationActive, type AdminDestination } from "../utils/admin-navigation";

defineProps<{ sections: Array<{ title: string; items: AdminDestination[] }> }>();
const emit = defineEmits<{ navigate: [] }>();
const route = useRoute();
const icons: Record<string, unknown> = { BookOpen, Building2, ChartNoAxesCombined, LayoutDashboard, Network, Package, PanelsTopLeft, ScrollText, Settings2, Sparkles, Store, UsersRound, Warehouse };
</script>

<template>
  <nav class="console-nav" aria-label="主导航">
    <div v-for="section in sections" :key="section.title" class="console-nav__group">
      <p class="console-nav__label">{{ section.title }}</p>
      <RouterLink v-for="item in section.items" :key="item.path" :to="item.path"
        @click="emit('navigate')"
        class="console-nav__link" :class="{ 'is-active': isAdminDestinationActive(route.path, item.path) }"
        :aria-current="isAdminDestinationActive(route.path, item.path) ? 'page' : undefined">
        <component :is="icons[item.icon]" :size="18" :stroke-width="1.7" aria-hidden="true" />
        <span>{{ item.label }}</span>
      </RouterLink>
    </div>
  </nav>
</template>
