<script setup lang="ts">
import { guestCopy as copy } from "../constants/guest-copy";
import MobileShell from "../layouts/MobileShell.vue";
import GlassCard from "./ui/GlassCard.vue";

const props = defineProps<{ mode: "records" | "settings" }>();
const login = () => uni.navigateTo({ url: `/pages/common/app-login?returnTab=${props.mode}` });
const browse = () => uni.switchTab({ url: "/pages/tabs/nearby" });
const help = () => uni.navigateTo({ url: "/pages/common/help-center" });
</script>

<template>
  <MobileShell mode="care" eyebrow="用户服务"
    :title="mode === 'records' ? copy.recordsTitle : copy.accountTitle"
    :subtitle="mode === 'records' ? copy.recordsBody : copy.accountBody">
    <GlassCard tone="quiet">
      <view class="vm-stack">
        <button class="vm-button" @tap="login">{{ copy.login }}</button>
        <button class="vm-button vm-button--soft" @tap="browse">{{ copy.browse }}</button>
        <button class="vm-button vm-button--ghost" @tap="help">{{ copy.help }}</button>
      </view>
    </GlassCard>
  </MobileShell>
</template>
