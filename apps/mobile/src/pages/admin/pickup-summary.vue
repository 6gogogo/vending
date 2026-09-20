<script setup lang="ts">
import { ref } from "vue";
import { onHide, onShow, onUnload } from "@dcloudio/uni-app";
import type { DailyPickupSummary } from "@vm/shared-types";
import { mobileApi } from "../../api/mobile";
import GlassCard from "../../components/ui/GlassCard.vue";
import MobileShell from "../../layouts/MobileShell.vue";
import { useSessionStore } from "../../stores/session";
import { getErrorMessage } from "../../utils/error-message";
import { formatBeijingDateTime } from "../../utils/datetime";

const session = useSessionStore();
const summary = ref<DailyPickupSummary>();
const selectedDate = ref<string>();
const loading = ref(false);
const error = ref("");
let timer: ReturnType<typeof setInterval> | undefined;
let requestVersion = 0;

const load = async () => {
  const version = ++requestVersion;
  loading.value = true;
  error.value = "";
  try {
    const result = await mobileApi.dailyPickupSummary(selectedDate.value);
    if (version === requestVersion) summary.value = result;
  } catch (cause) {
    if (version === requestVersion) error.value = getErrorMessage(cause);
  } finally {
    if (version === requestVersion) loading.value = false;
  }
};
const selectDate = (event: { detail: { value: string } }) => {
  selectedDate.value = event.detail.value;
  summary.value = undefined;
  void load();
};
const showToday = () => {
  selectedDate.value = undefined;
  summary.value = undefined;
  void load();
};
const stopRefresh = () => {
  if (timer) clearInterval(timer);
  timer = undefined;
  requestVersion += 1;
  loading.value = false;
};
onShow(async () => {
  await session.bootstrap();
  if (session.user?.role !== "admin") { uni.reLaunch({ url: "/pages/common/login" }); return; }
  stopRefresh();
  void load();
  timer = setInterval(() => { if (!loading.value) void load(); }, 15_000);
});
onHide(stopRefresh);
onUnload(stopRefresh);
</script>

<template>
  <MobileShell eyebrow="物资统计" title="每日领取汇总" subtitle="只汇总实际领取的商品与件数，不展示领取人。">
    <GlassCard tone="accent">
      <view class="summary-stack">
        <view class="summary-actions">
          <picker mode="date" :value="selectedDate || summary?.businessDateKey" @change="selectDate">
            <view class="vm-button vm-button--ghost">{{ selectedDate || summary?.businessDateKey || "选择日期" }} ▾</view>
          </picker>
          <button class="vm-button vm-button--ghost" @tap="showToday">今天</button>
          <button class="vm-button vm-button--primary" :disabled="loading" @tap="load">刷新</button>
        </view>
        <text v-if="error" class="summary-error" role="alert">读取失败：{{ error }}。请刷新重试。</text>
        <text v-else-if="loading && !summary" class="vm-subtitle">正在读取领取记录…</text>
        <template v-if="summary">
          <text class="summary-total">{{ summary.totalQuantity }} 件 · {{ summary.goodsKinds }} 种商品</text>
          <text class="vm-subtitle">业务日从每日 {{ String(summary.businessDayStartHour).padStart(2, '0') }}:00 起算；退回物资扣回原领取日，不计补货和调拨。每 15 秒刷新。</text>
          <view v-for="item in summary.items" :key="item.goodsId" class="summary-row">
            <text class="summary-name">{{ item.goodsName }}</text>
            <text class="summary-quantity">{{ item.quantity }} 件</text>
          </view>
          <text v-if="!summary.items.length" class="vm-subtitle">该业务日暂无实际领取记录。</text>
          <text class="vm-subtitle">更新于 {{ formatBeijingDateTime(summary.generatedAt) }}</text>
        </template>
      </view>
    </GlassCard>
  </MobileShell>
</template>

<style scoped>
.summary-stack { display: flex; flex-direction: column; gap: 24rpx; }
.summary-actions { display: flex; align-items: center; gap: 16rpx; flex-wrap: wrap; }
.summary-actions .vm-button { min-height: 72rpx; padding: 12rpx 20rpx; margin: 0; font-size: 26rpx; }
.summary-total { font-size: 42rpx; font-weight: 800; color: var(--vm-text); }
.summary-row { display: flex; justify-content: space-between; align-items: center; gap: 24rpx; padding: 24rpx 0; border-bottom: 1rpx solid var(--vm-border); }
.summary-name { font-size: 30rpx; flex: 1; overflow-wrap: anywhere; }
.summary-quantity { flex-shrink: 0; font-size: 30rpx; font-weight: 700; color: var(--vm-accent-strong); }
.summary-error { color: var(--vm-danger); line-height: 1.6; }
</style>
