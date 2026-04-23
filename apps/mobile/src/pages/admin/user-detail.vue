<script setup lang="ts">
import { computed, ref } from "vue";
import { onLoad } from "@dcloudio/uni-app";

import type { DeviceRecord, RegionRecord, UserManagementDetail } from "@vm/shared-types";

import { mobileApi } from "../../api/mobile";
import EmptyState from "../../components/ui/EmptyState.vue";
import GlassCard from "../../components/ui/GlassCard.vue";
import MobileShell from "../../layouts/MobileShell.vue";
import { roleLabelMap } from "../../constants/labels";
import { useSessionStore } from "../../stores/session";
import { showOperationFailure, showOperationSuccess } from "../../utils/operation-feedback";

const sessionStore = useSessionStore();
const loading = ref(false);
const saving = ref(false);
const adjusting = ref(false);
const userId = ref("");
const detail = ref<UserManagementDetail>();
const devices = ref<DeviceRecord[]>([]);
const regions = ref<RegionRecord[]>([]);
const deviceCode = ref("");
const goodsId = ref("");
const quantity = ref(1);
const direction = ref<"restock" | "deduct">("deduct");
const note = ref("");
const selectedRegionId = ref("");
const customRegionName = ref("");
const editForm = ref({
  name: "",
  phone: "",
  neighborhood: "",
  regionId: "",
  regionName: "",
  status: "active" as "active" | "inactive",
  tags: ""
});

const selectedGoodsOptions = computed(() => {
  const device = devices.value.find((item) => item.deviceCode === deviceCode.value);
  return device?.doors[0]?.goods ?? [];
});

const regionOptions = computed(() => [
  ...regions.value.map((item) => ({
    value: item.id,
    label: item.name
  })),
  {
    value: "other",
    label: "其他"
  }
]);

const selectedRegionLabel = computed(
  () => regionOptions.value.find((item) => item.value === selectedRegionId.value)?.label ?? "请选择区域"
);

const syncRegionFields = () => {
  if (selectedRegionId.value === "other") {
    const regionName = customRegionName.value.trim();
    editForm.value.regionId = "";
    editForm.value.regionName = regionName;
    editForm.value.neighborhood = regionName;
    return;
  }

  const matched = regions.value.find((item) => item.id === selectedRegionId.value);
  editForm.value.regionId = matched?.id ?? "";
  editForm.value.regionName = matched?.name ?? "";
  editForm.value.neighborhood = matched?.name ?? "";
};

const load = async () => {
  await sessionStore.bootstrap();

  if (!sessionStore.user || sessionStore.user.role !== "admin" || !userId.value) {
    uni.reLaunch({ url: "/pages/common/login" });
    return;
  }

  loading.value = true;
  try {
    const [detailResponse, deviceResponse, regionResponse] = await Promise.all([
      mobileApi.userDetail(userId.value),
      mobileApi.listDevices(),
      mobileApi.regions()
    ]);
    detail.value = detailResponse;
    devices.value = deviceResponse;
    regions.value = regionResponse;
    deviceCode.value = deviceResponse[0]?.deviceCode ?? "";
    goodsId.value = deviceResponse[0]?.doors[0]?.goods[0]?.goodsId ?? "";
    const regionId = detailResponse.user.regionId ?? "";
    const regionName = detailResponse.user.regionName ?? detailResponse.user.neighborhood ?? "";
    const matchedRegion = regionId
      ? regionResponse.find((item) => item.id === regionId)
      : regionResponse.find((item) => item.name === regionName);
    editForm.value = {
      name: detailResponse.user.name,
      phone: detailResponse.user.phone,
      neighborhood: regionName,
      regionId,
      regionName,
      status: detailResponse.user.status,
      tags: detailResponse.user.tags.join("、")
    };
    selectedRegionId.value = matchedRegion?.id ?? (regionName ? "other" : "");
    customRegionName.value = matchedRegion ? "" : regionName;
  } catch (error) {
    showOperationFailure(error);
  } finally {
    loading.value = false;
  }
};

const save = async () => {
  if (!detail.value) {
    return;
  }

  saving.value = true;
  try {
    syncRegionFields();
    await mobileApi.updateUser(detail.value.user.id, {
      name: editForm.value.name,
      phone: editForm.value.phone,
      neighborhood: editForm.value.neighborhood || undefined,
      regionId: editForm.value.regionId || undefined,
      regionName: editForm.value.regionName || undefined,
      status: editForm.value.status,
      tags: editForm.value.tags ? editForm.value.tags.split("、").filter(Boolean) : []
    });
    await load();
    showOperationSuccess();
  } catch (error) {
    showOperationFailure(error);
  } finally {
    saving.value = false;
  }
};

const submitAdjustment = async () => {
  if (!detail.value || detail.value.user.role !== "special") {
    return;
  }

  const goods = selectedGoodsOptions.value.find((item) => item.goodsId === goodsId.value);

  if (!goods) {
    showOperationFailure(new Error("请先选择货品"));
    return;
  }

  adjusting.value = true;
  try {
    await mobileApi.manualAdjustUser(detail.value.user.id, {
      deviceCode: deviceCode.value,
      goodsId: goods.goodsId,
      goodsName: goods.name,
      category: goods.category,
      quantity: quantity.value,
      direction: direction.value,
      note: note.value || undefined
    });
    await load();
    note.value = "";
    showOperationSuccess();
  } catch (error) {
    showOperationFailure(error);
  } finally {
    adjusting.value = false;
  }
};

onLoad((query) => {
  userId.value = typeof query.userId === "string" ? query.userId : "";
  load();
});
</script>

<template>
  <MobileShell eyebrow="人员详情" :title="detail?.user.name ?? '人员详情'" :subtitle="detail ? `${roleLabelMap[detail.user.role]} · ${detail.user.phone}` : '正在加载人员信息'">
    <GlassCard tone="accent">
      <view class="vm-stack">
        <text class="section-title">基础信息</text>
        <view class="vm-field">
          <text class="vm-field__label">姓名</text>
          <input v-model="editForm.name" class="vm-field__input" />
        </view>
        <view class="vm-field">
          <text class="vm-field__label">手机号</text>
          <input v-model="editForm.phone" class="vm-field__input" />
        </view>
        <view class="vm-field">
          <text class="vm-field__label">区域</text>
          <picker :range="regionOptions" range-key="label" :value="Math.max(0, regionOptions.findIndex((item) => item.value === selectedRegionId))" @change="selectedRegionId = regionOptions[$event.detail.value]?.value ?? ''">
            <view class="vm-field__input picker-value">
              {{ selectedRegionLabel }}
            </view>
          </picker>
        </view>
        <view v-if="selectedRegionId === 'other'" class="vm-field">
          <text class="vm-field__label">自定义区域</text>
          <input v-model="customRegionName" class="vm-field__input" placeholder="请输入区域名称" />
        </view>
        <view class="vm-field">
          <text class="vm-field__label">标签</text>
          <input v-model="editForm.tags" class="vm-field__input" placeholder="多个标签请用顿号分隔" />
        </view>
        <view class="vm-field">
          <text class="vm-field__label">状态</text>
          <view class="type-row">
            <button class="filter-chip" :class="{ 'filter-chip--active': editForm.status === 'active' }" @tap="editForm.status = 'active'">启用</button>
            <button class="filter-chip" :class="{ 'filter-chip--active': editForm.status === 'inactive' }" @tap="editForm.status = 'inactive'">停用</button>
          </view>
        </view>
        <button class="vm-button" :loading="saving" @tap="save">保存信息</button>
      </view>
    </GlassCard>

    <GlassCard v-if="detail?.user.role === 'special'" tone="quiet">
      <view class="vm-stack">
        <text class="section-title">时段领取情况</text>
        <view v-if="detail?.businessDaySummary?.windows?.length" class="list-block">
          <view v-for="window in detail.businessDaySummary.windows" :key="window.policyId + window.startHour" class="list-item">
            <text class="list-item__title">{{ String(window.startHour).padStart(2, '0') }}:00-{{ String(window.endHour).padStart(2, '0') }}:00</text>
            <text class="list-item__meta">
              {{
                window.goodsUsage.map((item) => `${item.goodsName} ${item.usedQuantity}/${item.quantityLimit}`).join("，")
              }}
            </text>
          </view>
        </view>
        <EmptyState v-else title="当前暂无时段策略" description="请先在后台为该普通用户绑定领取策略模板。" />
      </view>
    </GlassCard>

    <GlassCard v-if="detail?.user.role === 'special'" tone="warning">
      <view class="vm-stack">
        <text class="section-title">手工补扣</text>
        <picker :range="devices" range-key="name" @change="deviceCode = devices[$event.detail.value]?.deviceCode ?? ''">
          <view class="vm-field__input picker-value">
            {{ devices.find((item) => item.deviceCode === deviceCode)?.name ?? "选择柜机" }}
          </view>
        </picker>
        <picker :range="selectedGoodsOptions" range-key="name" @change="goodsId = selectedGoodsOptions[$event.detail.value]?.goodsId ?? ''">
          <view class="vm-field__input picker-value">
            {{ selectedGoodsOptions.find((item) => item.goodsId === goodsId)?.name ?? "选择货品" }}
          </view>
        </picker>
        <view class="type-row">
          <button class="filter-chip" :class="{ 'filter-chip--active': direction === 'deduct' }" @tap="direction = 'deduct'">补扣</button>
          <button class="filter-chip" :class="{ 'filter-chip--active': direction === 'restock' }" @tap="direction = 'restock'">补货</button>
        </view>
        <input v-model.number="quantity" class="vm-field__input" type="number" placeholder="数量" />
        <input v-model="note" class="vm-field__input" placeholder="备注（选填）" />
        <button class="vm-button" :loading="adjusting" @tap="submitAdjustment">提交调整</button>
      </view>
    </GlassCard>

    <GlassCard tone="quiet">
      <view class="vm-stack">
        <text class="section-title">最近记录</text>
        <view v-if="detail?.recentRecords?.length" class="list-block">
          <view v-for="record in detail.recentRecords.slice(0, 6)" :key="record.id" class="list-item">
            <text class="list-item__title">{{ record.goodsName }}</text>
            <text class="list-item__meta">{{ record.deviceCode }} · {{ record.happenedAt.slice(0, 16).replace('T', ' ') }} · {{ record.quantity }} 件</text>
          </view>
        </view>
        <EmptyState v-else :title="loading ? '正在加载记录' : '暂无记录'" description="当前人员还没有相关库存或领取记录。" />
      </view>
    </GlassCard>
  </MobileShell>
</template>

<style scoped>
.section-title,
.list-item__title {
  font-size: 30rpx;
  font-weight: 700;
  color: var(--vm-text);
}

.type-row,
.list-block {
  display: grid;
  gap: 16rpx;
}

.picker-value {
  display: flex;
  align-items: center;
}

.filter-chip {
  min-height: 80rpx;
  border-radius: 22rpx;
  border: 1rpx solid var(--vm-line-strong);
  background: var(--vm-surface-soft);
  font-size: 26rpx;
}

.filter-chip--active {
  border-color: var(--vm-info-line);
  background: var(--vm-info-bg);
  color: var(--vm-info);
}

.picker-value {
  display: flex;
  align-items: center;
}

.list-item {
  display: grid;
  gap: 10rpx;
  padding: 22rpx 24rpx;
  border-radius: 24rpx;
  background: var(--vm-surface-soft);
  border: 1rpx solid var(--vm-line);
}

.list-item__meta {
  font-size: 22rpx;
  color: var(--vm-text-soft);
}
</style>

