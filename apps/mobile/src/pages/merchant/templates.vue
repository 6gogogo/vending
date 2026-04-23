<script setup lang="ts">
import { computed, reactive, ref, watch } from "vue";
import { onShow } from "@dcloudio/uni-app";

import type { GoodsCategory, GoodsCategoryRecord, MerchantGoodsTemplate } from "@vm/shared-types";

import { mobileApi } from "../../api/mobile";
import EmptyState from "../../components/ui/EmptyState.vue";
import GlassCard from "../../components/ui/GlassCard.vue";
import MobileShell from "../../layouts/MobileShell.vue";
import { categoryLabelMap } from "../../constants/labels";
import { useSessionStore } from "../../stores/session";
import { showOperationFailure, showOperationSuccess } from "../../utils/operation-feedback";

const sessionStore = useSessionStore();
const loading = ref(false);
const saving = ref(false);
const uploading = ref(false);
const editingId = ref<string>();
const templates = ref<MerchantGoodsTemplate[]>([]);
const goodsCategories = ref<GoodsCategoryRecord[]>([]);
const categories: GoodsCategory[] = ["food", "drink", "daily"];
const packageFormOptions = ["瓶装", "盒装", "袋装", "杯装", "罐装", "桶装", "份装", "散装", "其他"];

const form = reactive({
  goodsCode: "",
  goodsName: "",
  fullName: "",
  category: "food" as GoodsCategory,
  categoryName: "",
  packageForm: "盒装",
  specification: "",
  manufacturer: "",
  defaultQuantity: 6,
  defaultShelfLifeDays: 2,
  imageUrl: ""
});

const categoryOptions = computed(() =>
  goodsCategories.value.filter((item) => item.status === "active" && item.category === form.category)
);

const resetForm = () => {
  editingId.value = undefined;
  form.goodsCode = "";
  form.goodsName = "";
  form.fullName = "";
  form.category = "food";
  form.categoryName = "";
  form.packageForm = "盒装";
  form.specification = "";
  form.manufacturer = "";
  form.defaultQuantity = 6;
  form.defaultShelfLifeDays = 2;
  form.imageUrl = "";
};

const load = async () => {
  await sessionStore.bootstrap();

  if (!sessionStore.user) {
    uni.reLaunch({ url: "/pages/common/login" });
    return;
  }

  loading.value = true;
  try {
    const [templateResponse, categoryResponse] = await Promise.all([
      mobileApi.merchantTemplates(),
      mobileApi.goodsCategories()
    ]);
    templates.value = templateResponse;
    goodsCategories.value = categoryResponse;

    if (!form.categoryName) {
      form.categoryName = categoryOptions.value[0]?.name ?? "";
    }
  } catch (error) {
    showOperationFailure(error);
  } finally {
    loading.value = false;
  }
};

const edit = (template: MerchantGoodsTemplate) => {
  editingId.value = template.id;
  form.goodsCode = template.goodsCode ?? "";
  form.goodsName = template.goodsName;
  form.fullName = template.fullName ?? template.goodsName;
  form.category = template.category;
  form.categoryName = template.categoryName ?? "";
  form.packageForm = template.packageForm ?? "盒装";
  form.specification = template.specification ?? "";
  form.manufacturer = template.manufacturer ?? "";
  form.defaultQuantity = template.defaultQuantity;
  form.defaultShelfLifeDays = template.defaultShelfLifeDays;
  form.imageUrl = template.imageUrl ?? "";
};

const chooseImage = async (sourceType: Array<"album" | "camera">) => {
  if (!sessionStore.token) {
    showOperationFailure(new Error("登录状态已失效"));
    return;
  }

  uploading.value = true;
  try {
    const chooseResult = await new Promise<UniApp.ChooseImageSuccessCallbackResult>((resolve, reject) => {
      uni.chooseImage({
        count: 1,
        sizeType: ["compressed"],
        sourceType,
        success: resolve,
        fail: reject
      });
    });

    const filePath = chooseResult.tempFilePaths[0];
    if (!filePath) {
      throw new Error("未选择图片");
    }

    const uploaded = await mobileApi.uploadImage(filePath, sessionStore.token);
    form.imageUrl = uploaded.url;
    showOperationSuccess();
  } catch (error) {
    showOperationFailure(error);
  } finally {
    uploading.value = false;
  }
};

const openImagePicker = () => {
  uni.showActionSheet({
    itemList: ["拍摄", "从相册选择", "移除图片"],
    success: ({ tapIndex }) => {
      if (tapIndex === 0) {
        chooseImage(["camera"]);
        return;
      }

      if (tapIndex === 1) {
        chooseImage(["album"]);
        return;
      }

      form.imageUrl = "";
    }
  });
};

const submit = async () => {
  if (!form.goodsName.trim()) {
    showOperationFailure(new Error("请输入商品名称"));
    return;
  }

  if (form.defaultQuantity <= 0 || form.defaultShelfLifeDays <= 0) {
    showOperationFailure(new Error("默认数量和默认保质天数必须大于 0"));
    return;
  }

  saving.value = true;
  try {
    const payload = {
      goodsCode: form.goodsCode.trim() || undefined,
      goodsName: form.goodsName.trim(),
      fullName: form.fullName.trim() || form.goodsName.trim(),
      category: form.category,
      categoryName: form.categoryName || undefined,
      packageForm: form.packageForm || undefined,
      specification: form.specification || undefined,
      manufacturer: form.manufacturer || undefined,
      defaultQuantity: form.defaultQuantity,
      defaultShelfLifeDays: form.defaultShelfLifeDays,
      imageUrl: form.imageUrl || undefined
    };

    if (editingId.value) {
      await mobileApi.updateMerchantTemplate(editingId.value, payload);
    } else {
      await mobileApi.createMerchantTemplate(payload);
    }

    resetForm();
    await load();
    showOperationSuccess();
  } catch (error) {
    showOperationFailure(error);
  } finally {
    saving.value = false;
  }
};

onShow(() => {
  load();
});

watch(
  () => form.category,
  () => {
    if (!categoryOptions.value.some((item) => item.name === form.categoryName)) {
      form.categoryName = categoryOptions.value[0]?.name ?? "";
    }
  }
);
</script>

<template>
  <MobileShell eyebrow="商品属性" title="爱心商户商品属性" subtitle="请先维护常用货品信息，补货时可直接选用。">
    <GlassCard tone="accent">
      <view class="vm-stack">
        <view class="form-grid">
          <view class="vm-field">
            <text class="vm-field__label">商品编号</text>
            <input v-model="form.goodsCode" class="vm-field__input" placeholder="例如：6901234567895" />
          </view>
          <view class="vm-field">
            <text class="vm-field__label">商品全称</text>
            <input v-model="form.fullName" class="vm-field__input" placeholder="例如：鲜牛奶250ml" />
          </view>
          <view class="vm-field">
            <text class="vm-field__label">商品名称</text>
            <input v-model="form.goodsName" class="vm-field__input" placeholder="例如：牛奶" />
          </view>
          <view class="vm-field">
            <text class="vm-field__label">商品大类</text>
            <picker :range="categories" @change="form.category = categories[$event.detail.value] ?? 'food'">
              <view class="vm-field__input picker-value">
                {{ categoryLabelMap[form.category] }}
              </view>
            </picker>
          </view>
          <view class="vm-field">
            <text class="vm-field__label">分类</text>
            <picker :range="categoryOptions" range-key="name" @change="form.categoryName = categoryOptions[$event.detail.value]?.name ?? ''">
              <view class="vm-field__input picker-value">
                {{ form.categoryName || "请选择分类" }}
              </view>
            </picker>
          </view>
          <view class="vm-field">
            <text class="vm-field__label">包装形式</text>
            <picker :range="packageFormOptions" @change="form.packageForm = packageFormOptions[$event.detail.value] ?? '盒装'">
              <view class="vm-field__input picker-value">
                {{ form.packageForm }}
              </view>
            </picker>
          </view>
          <view class="vm-field">
            <text class="vm-field__label">商品规格</text>
            <input v-model="form.specification" class="vm-field__input" placeholder="例如：250ml / 2片装" />
          </view>
          <view class="vm-field">
            <text class="vm-field__label">厂家</text>
            <input v-model="form.manufacturer" class="vm-field__input" placeholder="例如：本地爱心商户" />
          </view>
          <view class="vm-field">
            <text class="vm-field__label">默认数量</text>
            <input v-model.number="form.defaultQuantity" class="vm-field__input" type="number" />
          </view>
          <view class="vm-field">
            <text class="vm-field__label">默认保质天数</text>
            <input v-model.number="form.defaultShelfLifeDays" class="vm-field__input" type="number" />
          </view>
        </view>

        <view class="vm-field">
          <text class="vm-field__label">图片（选填）</text>
          <button class="vm-button vm-button--ghost" :loading="uploading" @tap="openImagePicker">
            {{ form.imageUrl ? "更换图片" : "选择拍摄或本地图片" }}
          </button>
          <image v-if="form.imageUrl" class="template-preview" :src="form.imageUrl" mode="aspectFill" />
        </view>

        <view class="action-row">
          <button class="vm-button" :loading="saving" @tap="submit">{{ editingId ? "保存修改" : "新增商品属性" }}</button>
          <button v-if="editingId" class="vm-button vm-button--ghost" @tap="resetForm">取消编辑</button>
        </view>
      </view>
    </GlassCard>

    <GlassCard tone="quiet">
      <view class="vm-stack">
        <view class="section-heading">
          <text class="section-heading__title">已有商品属性</text>
          <text class="vm-subtitle">点击任意条目可直接带入上方表单修改。</text>
        </view>

        <view v-if="templates.length" class="template-list">
          <button v-for="item in templates" :key="item.id" class="template-item" @tap="edit(item)">
            <view class="template-item__main">
              <text class="template-item__title">{{ item.goodsName }}</text>
              <text class="template-item__meta">{{ item.fullName || item.goodsName }}</text>
              <text class="template-item__meta">
                {{ item.categoryName || categoryLabelMap[item.category] }} · {{ item.packageForm || "未填包装" }} · 默认 {{ item.defaultQuantity }} 件
              </text>
              <text class="template-item__meta">
                {{ item.specification || "未填规格" }} · {{ item.manufacturer || "未填厂家" }} · {{ item.defaultShelfLifeDays }} 天
              </text>
            </view>
            <text class="vm-status" :class="item.status === 'active' ? 'vm-status--success' : 'vm-status--muted'">
              {{ item.status === "active" ? "启用中" : "已停用" }}
            </text>
          </button>
        </view>
        <EmptyState v-else :title="loading ? '正在加载商品属性' : '还没有商品属性'" description="先新增常用商品属性，后续补货时可直接选用。" />
      </view>
    </GlassCard>
  </MobileShell>
</template>

<style scoped>
.section-heading {
  display: flex;
  flex-direction: column;
  gap: 12rpx;
}

.section-heading__title,
.template-item__title {
  font-size: 30rpx;
  font-weight: 700;
  color: var(--vm-text);
}

.template-list,
.action-row {
  display: grid;
  gap: 16rpx;
}

.form-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 16rpx;
}

.template-item {
  display: flex;
  justify-content: space-between;
  gap: 16rpx;
  padding: 22rpx 24rpx;
  border-radius: 24rpx;
  border: 1rpx solid rgba(159, 127, 94, 0.18);
  background: rgba(255, 252, 246, 0.88);
  text-align: left;
}

.template-item__main {
  display: flex;
  flex-direction: column;
  gap: 8rpx;
}

.template-item__meta {
  font-size: 22rpx;
  color: var(--vm-text-soft);
}

.picker-value {
  display: flex;
  align-items: center;
}

.template-preview {
  width: 180rpx;
  height: 180rpx;
  border-radius: 24rpx;
  border: 1rpx solid rgba(159, 127, 94, 0.18);
}
</style>
