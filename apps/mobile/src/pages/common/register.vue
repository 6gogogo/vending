<script setup lang="ts">
import { onLoad } from "@dcloudio/uni-app";

onLoad((query) => {
  const phone = typeof query.phone === "string" ? query.phone : "";
  const suffix = phone ? `?phone=${encodeURIComponent(phone)}` : "";
  uni.redirectTo({ url: `/pages/common/app-login${suffix}` });
});
</script>

<template><view class="entry-blank" /></template>

<style scoped>
.entry-blank { min-height: 100vh; background: #fffaf3; }
</style>
