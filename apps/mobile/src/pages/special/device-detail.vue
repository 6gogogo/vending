<script setup lang="ts">
import { computed, reactive, ref } from "vue";
import { onLoad } from "@dcloudio/uni-app";

import type { GoodsCategory } from "@vm/shared-types";

import { mobileApi } from "../../api/mobile";
import EmptyState from "../../components/ui/EmptyState.vue";
import GlassCard from "../../components/ui/GlassCard.vue";
import MobileShell from "../../layouts/MobileShell.vue";
import { categoryLabelMap } from "../../constants/labels";
import { useSessionStore } from "../../stores/session";
import { getErrorMessage } from "../../utils/error-message";

const sessionStore = useSessionStore();
const loading = ref(false);
const submitting = ref(false);
const deviceCode = ref("");
const scanMode = ref(false);
const deviceName = ref("柜机详情");
const location = ref("");
const goodsList = ref<Array<{
  goodsCode: string;
  goodsId: string;
  name: string;
  price: number;
  imageUrl: string;
  category: GoodsCategory;
  stock?: number;
  expiresAt?: string;
}>>([]);
const selectedMap = reactive<Record<string, number>>({});

const selectedItems = computed(() =>
  goodsList.value
    .map((item) => ({
      goodsId: item.goodsId,
      goodsName: item.name,
      quantity: selectedMap[item.goodsId] ?? 0,
      category: item.category
    }))
    .filter((item) => item.quantity > 0)
);

const selectedSummary = computed(() =>
  selectedItems.value.map((item) => `${item.goodsName} x${item.quantity}`).join("、")
);

const load = async () => {
  await sessionStore.bootstrap();

  if (!sessionStore.user || !deviceCode.value) {
    uni.reLaunch({
      url: "/pages/common/login"
    });
    return;
  }

  loading.value = true;
  try {
    const [device, goods, quota] = await Promise.all([
      mobileApi.getDevice(deviceCode.value),
      mobileApi.queryGoods(deviceCode.value),
      mobileApi.getQuotaSummary(sessionStore.user.phone)
    ]);

    deviceName.value = device.name;
    location.value = device.location;
    goodsList.value = goods;
    sessionStore.setQuota(quota);
  } catch (error) {
    uni.showToast({
      title: getErrorMessage(error),
      icon: "none"
    });
  } finally {
    loading.value = false;
  }
};

const getRemaining = (goodsId: string) => sessionStore.quota?.remainingByGoods?.[goodsId] ?? 0;

const updateSelected = (goodsId: string, delta: number) => {
  const current = selectedMap[goodsId] ?? 0;
  const max = Math.max(0, getRemaining(goodsId));
  const next = Math.min(max, Math.max(0, current + delta));
  selectedMap[goodsId] = next;
};

const performOpen = async () => {
  if (!sessionStore.user || !selectedItems.value.length) {
    uni.showModal({
      title: "请选择商品",
      content: "正式开柜前需要先选择本次计划领取的商品。",
      showCancel: false
    });
    return;
  }

  submitting.value = true;
  try {
    const response = await mobileApi.openCabinet({
      phone: sessionStore.user.phone,
      deviceCode: deviceCode.value,
      doorNum: "1",
      category: selectedItems.value[0]?.category,
      openMode: scanMode.value ? "scan" : "manual",
      intentItems: selectedItems.value.map((item) => ({
        goodsId: item.goodsId,
        goodsName: item.goodsName,
        quantity: item.quantity,
        category: item.category
      }))
    });

    if (response.remainingQuota) {
      sessionStore.setQuota({
        ...sessionStore.quota,
        remainingToday: response.remainingQuota
      });
    }

    uni.redirectTo({
      url: `/pages/common/opening?eventId=${encodeURIComponent(response.eventId)}&deviceCode=${encodeURIComponent(response.deviceCode)}`
    });
  } catch (error) {
    uni.reLaunch({
      url: `/pages/common/result?status=danger&title=${encodeURIComponent(scanMode.value ? "扫码开柜失败" : "手动开柜失败")}&detail=${encodeURIComponent(getErrorMessage(error))}&actionText=${encodeURIComponent("重新尝试")}&backUrl=${encodeURIComponent(`/pages/special/device-detail?deviceCode=${deviceCode.value}${scanMode.value ? "&scan=1" : ""}`)}`
    });
  } finally {
    submitting.value = false;
  }
};

const submit = () => {
  if (!selectedItems.value.length) {
    uni.showModal({
      title: "请选择商品",
      content: "正式开柜前需要先选择本次计划领取的商品。",
      showCancel: false
    });
    return;
  }

  uni.showModal({
    title: scanMode.value ? "确认扫码开柜" : "确认手动开柜",
    content: scanMode.value
      ? `即将按扫码流程开柜，已选择：${selectedSummary.value}。柜门关闭后会按平台实际识别结果结算。`
      : `请确认你已经在柜机旁，并准备好立即取货和及时关门。已选择：${selectedSummary.value}。`,
    confirmText: scanMode.value ? "确认开柜" : "继续开柜",
    success: ({ confirm }) => {
      if (confirm) {
        void performOpen();
      }
    }
  });
};

const goFeedback = () => {
  uni.navigateTo({
    url: `/pages/common/feedback?deviceCode=${deviceCode.value}`
  });
};

onLoad((query) => {
  deviceCode.value = typeof query.deviceCode === "string" ? query.deviceCode : "";
  scanMode.value = query.scan === "1";
  load();
});
</script>

<template>
  <MobileShell eyebrow="柜机详情" :title="deviceName" :subtitle="location || '请先确认柜机位置和货品信息'">
    <GlassCard tone="accent">
      <view class="vm-stack">
        <view class="section-heading">
          <text class="section-heading__title">意向货品</text>
          <text class="vm-subtitle">{{ scanMode ? "当前来自扫码开门，可直接申请开柜；如果需要，也可以继续选择意向货品作为参考。" : "先选择意向领取货品，系统会按你的当前权限和实际结算结果处理。" }}</text>
        </view>

        <view v-if="scanMode" class="scan-mode-banner">
          <text class="scan-mode-banner__title">已识别柜机编号 {{ deviceCode }}</text>
          <text class="scan-mode-banner__body">扫码流程会跳过柜机选择，但仍需先选择本次计划领取的商品，最终以平台识别到的商品种类和数量为准。</text>
        </view>

        <view v-if="goodsList.length" class="goods-list">
          <view v-for="goods in goodsList" :key="goods.goodsId" class="goods-item">
            <view class="goods-item__main">
              <text class="goods-item__name">{{ goods.name }}</text>
              <text class="goods-item__meta">
                {{ categoryLabelMap[goods.category] }} · 现有 {{ goods.stock ?? 0 }} 件 · 可领 {{ getRemaining(goods.goodsId) }} 件
              </text>
              <text v-if="goods.expiresAt" class="goods-item__hint">
                批次到期 {{ goods.expiresAt.slice(5, 16).replace("T", " ") }}
              </text>
            </view>
            <view class="stepper">
              <button class="stepper__button" @tap="updateSelected(goods.goodsId, -1)">-</button>
              <text class="stepper__value">{{ selectedMap[goods.goodsId] ?? 0 }}</text>
              <button class="stepper__button" @tap="updateSelected(goods.goodsId, 1)">+</button>
            </view>
          </view>
        </view>
        <EmptyState
          v-else
          :title="loading ? '正在加载货品信息' : '当前暂无可选货品'"
          :description="loading ? '请稍候，系统正在同步柜机商品列表。' : '请联系工作人员确认柜机库存。'"
        />

        <view class="action-stack">
          <button class="vm-button" :loading="submitting" @tap="submit">
            {{ scanMode ? "确认货品并扫码开柜" : "确认货品并手动开柜" }}
          </button>
          <button class="vm-button vm-button--ghost" @tap="goFeedback">反馈问题</button>
        </view>
      </view>
    </GlassCard>
  </MobileShell>
</template>

<style scoped>
.section-heading,
.goods-item__main {
  display: flex;
  flex-direction: column;
  gap: 10rpx;
}

.section-heading__title,
.goods-item__name {
  font-size: 30rpx;
  font-weight: 700;
  color: var(--vm-text);
}

.goods-list {
  display: grid;
  gap: 16rpx;
}

.goods-item {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 18rpx;
  padding: 22rpx 24rpx;
  border-radius: 24rpx;
  background: rgba(255, 255, 255, 0.6);
  border: 1rpx solid rgba(159, 127, 94, 0.12);
}

.goods-item__meta,
.goods-item__hint {
  font-size: 22rpx;
  color: var(--vm-text-soft);
}

.stepper {
  display: flex;
  align-items: center;
  gap: 16rpx;
}

.stepper__button {
  width: 72rpx;
  min-height: 72rpx;
  border-radius: 18rpx;
  border: 1rpx solid rgba(159, 127, 94, 0.2);
  background: rgba(255, 252, 246, 0.92);
  font-size: 34rpx;
}

.stepper__value {
  min-width: 40rpx;
  text-align: center;
  font-size: 30rpx;
  font-weight: 700;
}

.action-stack {
  display: grid;
  gap: 16rpx;
}

.scan-mode-banner {
  display: grid;
  gap: 8rpx;
  padding: 20rpx 22rpx;
  border-radius: 20rpx;
  background: rgba(255, 250, 240, 0.85);
  border: 1rpx solid rgba(159, 127, 94, 0.18);
}

.scan-mode-banner__title {
  font-size: 26rpx;
  font-weight: 700;
  color: var(--vm-text);
}

.scan-mode-banner__body {
  font-size: 22rpx;
  color: var(--vm-text-soft);
}
</style>
