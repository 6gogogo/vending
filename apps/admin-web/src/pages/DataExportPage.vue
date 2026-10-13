<script setup lang="ts">
import PickupReportExport from "../components/PickupReportExport.vue";
import { useAdminSessionStore } from "../stores/session";

const session = useAdminSessionStore();
</script>

<template>
  <PickupReportExport v-if="session.can('operation-logs:export')" />
  <section v-else class="admin-page__section" role="status">
    <h3 class="admin-page__section-title">暂无导出权限</h3>
    <p class="admin-copy">请联系实例管理员开通导出权限后再试。</p>
  </section>
</template>
