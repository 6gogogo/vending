<script setup lang="ts">
import { computed, reactive, ref } from "vue";
import { onLoad } from "@dcloudio/uni-app";

import type { GoodsCategory } from "@vm/shared-types";

import { mobileApi } from "../../api/mobile";
import EmptyState from "../../components/ui/EmptyState.vue";
import GlassCard from "../../components/ui/GlassCard.vue";
import ServiceMetric from "../../components/ui/ServiceMetric.vue";
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

const selectedTotal = computed(() =>
  selectedItems.value.reduce((total, item) => total + item.quantity, 0)
);

const availableGoodsCount = computed(() =>
  goodsList.value.filter((item) => (item.stock ?? 0) > 0).length
);

const openGuideText = computed(() =>
  scanMode.value
    ? "当前通过扫码识别柜机，确认货品后可直接发起开柜，最终结算会以平台识别结果为准。"
    : "建议站在柜机旁再操作，先选好计划领取的货品，取货后及时关门。"
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
          <text class="section-heading__title">本次领取计划</text>
          <text class="vm-subtitle">请先选择本次要领取的货品，再确认开柜。</text>
        </view>

        <view class="overview-grid">
          <ServiceMetric label="已选种类" :value="selectedItems.length" hint="已加入本次计划的货品种类" tone="accent" />
          <ServiceMetric label="已选件数" :value="selectedTotal" hint="会按你的实时资格限制上限" />
          <ServiceMetric label="可选货品" :value="availableGoodsCount" hint="当前柜机仍有库存的货品种类" />
        </view>

        <view class="selection-banner">
          <text class="selection-banner__label">{{ scanMode ? "扫码模式" : "手动模式" }}</text>
          <text class="selection-banner__value">{{ selectedSummary || "暂未选择货品" }}</text>
          <text class="selection-banner__hint">{{ openGuideText }}</text>
          <text class="selection-banner__hint">正式结算仍以柜门关闭后的平台识别结果为准。</text>
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
          <button class="vm-button vm-button--ghost" @tap="goFeedback">反馈这台柜机的问题</button>
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

.goods-item__meta,
.goods-item__hint,
.selection-banner__hint {
  font-size: 22rpx;
  color: var(--vm-text-soft);
  line-height: 1.6;
}

.overview-grid,
.goods-list,
.action-stack {
  display: grid;
  gap: 16rpx;
}

.selection-banner,
.goods-item {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 18rpx;
  padding: 22rpx 24rpx;
  border-radius: 24rpx;
  background: rgba(255, 255, 255, 0.62);
  border: 1rpx solid var(--vm-line);
}

.selection-banner {
  display: grid;
}

.selection-banner__label {
  font-size: 22rpx;
  color: var(--vm-accent-strong);
}

.selection-banner__value {
  font-size: 28rpx;
  color: var(--vm-text);
  font-weight: 700;
  line-height: 1.5;
}

.stepper {
  display: flex;
  align-items: center;
  gap: 16rpx;
}

.stepper__button {
  width: 76rpx;
  min-height: 76rpx;
  border-radius: 22rpx;
  border: 1rpx solid var(--vm-line-strong);
  background: rgba(255, 255, 252, 0.92);
  font-size: 34rpx;
  color: var(--vm-text);
}

.stepper__value {
  min-width: 48rpx;
  text-align: center;
  font-size: 30rpx;
  font-weight: 700;
}
</style>
