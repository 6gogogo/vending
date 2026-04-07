<script setup lang="ts">
import { ref } from "vue";
import { onShow } from "@dcloudio/uni-app";
import type { InventoryMovement } from "@vm/shared-types";

import { mobileApi } from "../../api/mobile";
import GlassCard from "../../components/ui/GlassCard.vue";
import MobileShell from "../../layouts/MobileShell.vue";
import { useSessionStore } from "../../stores/session";
import { getErrorMessage } from "../../utils/error-message";

const sessionStore = useSessionStore();
const records = ref<InventoryMovement[]>([]);

const load = async () => {
  if (!sessionStore.user) {
    return;
  }

  try {
    records.value = await mobileApi.listRecords(sessionStore.user.id, sessionStore.user.role);
  } catch (error) {
    uni.showToast({
      title: getErrorMessage(error),
      icon: "none"
    });
  }
};

onShow(load);
</script>

<template>
  <MobileShell eyebrow="领取记录" title="历史领取记录" subtitle="这里展示当前账号的历史领取明细。">
    <GlassCard>
      <view class="vm-stack">
        <view v-for="record in records" :key="record.id" class="row">
          <view>
            <text>{{ record.goodsName }}</text>
            <view style="height: 6rpx;" />
            <text class="vm-subtitle">{{ record.happenedAt.slice(0, 16).replace('T', ' ') }}</text>
          </view>
          <text class="vm-pill">{{ record.quantity }}</text>
        </view>
      </view>
    </GlassCard>
  </MobileShell>
</template>

<style scoped>
.row {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 18rpx 0;
  border-bottom: 1rpx solid var(--vm-line);
}
</style>
