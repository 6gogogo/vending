<script setup lang="ts">
import { computed, onMounted, reactive, ref, watch } from "vue";
import { RouterLink } from "vue-router";
import type {
  DeviceRecord,
  GoodsAlertPolicy,
  GoodsCategory,
  GoodsCategoryRecord,
  GoodsOverviewItem,
  GoodsOverviewSnapshot,
  WarehouseInventorySnapshot
} from "@vm/shared-types";

import { adminApi } from "../api/admin";
import StatTile from "../components/StatTile.vue";
import { useAdminSessionStore } from "../stores/session";

const sessionStore = useAdminSessionStore();

const categoryLabelMap: Record<GoodsCategory, string> = {
  food: "食品",
  drink: "饮品",
  daily: "日用品"
};

const packageFormOptions = ["瓶装", "盒装", "袋装", "杯装", "罐装", "桶装", "份装", "散装", "其他"];

const overview = ref<GoodsOverviewSnapshot>();
const warehouseSnapshot = ref<WarehouseInventorySnapshot>();
const catalog = ref<Awaited<ReturnType<typeof adminApi.goodsCatalog>>>([]);
const categories = ref<GoodsCategoryRecord[]>([]);
const policies = ref<GoodsAlertPolicy[]>([]);
const devices = ref<DeviceRecord[]>([]);
const loading = ref(false);
const saving = ref(false);
const uploadingImage = ref(false);
const message = ref<{ type: "success" | "error"; text: string }>();
const editingCategoryId = ref("");
const editingPolicyId = ref("");
const selectedGoodsStatusId = ref("");
const editorMode = ref<"" | "goods" | "goods-delete" | "category" | "policy">("");
const expandedAlertBucket = ref<"" | "low" | "empty">("");

const goodsForm = reactive({
  goodsCode: "",
  name: "",
  fullName: "",
  category: "food" as GoodsCategory,
  categoryName: "",
  price: 0,
  packageForm: "盒装",
  specification: "",
  manufacturer: "",
  imageUrl: ""
});

const categoryForm = reactive({
  name: "",
  category: "food" as GoodsCategory,
  sortOrder: 0
});

const policyForm = reactive<{
  name: string;
  status: "active" | "inactive";
  applicableDeviceCodes: string[];
  thresholds: Array<{
    goodsId: string;
    lowStockThreshold: number;
  }>;
}>({
  name: "",
  status: "active",
  applicableDeviceCodes: [],
  thresholds: [{ goodsId: "", lowStockThreshold: 1 }]
});

const assignForm = reactive<{
  mode: "bind" | "unbind" | "replace";
  deviceCodes: string[];
  policyIds: string[];
}>({
  mode: "replace",
  deviceCodes: [],
  policyIds: []
});

const transferForm = reactive({
  fromCode: "WAREHOUSE-LOCAL",
  toCode: "",
  goodsId: "",
  quantity: 1,
  note: ""
});

const activeCategories = computed(() =>
  categories.value
    .filter((item) => item.status === "active")
    .sort((left, right) => {
      if (left.sortOrder !== right.sortOrder) {
        return left.sortOrder - right.sortOrder;
      }

      return left.name.localeCompare(right.name);
    })
);

const filteredGoodsCategories = computed(() =>
  activeCategories.value.filter((item) => item.category === goodsForm.category)
);

const sortedCatalog = computed(() =>
  [...catalog.value].sort((left, right) => (right.createdAt ?? "").localeCompare(left.createdAt ?? ""))
);

const selectedGoodsForStatus = computed(() =>
  catalog.value.find((item) => item.goodsId === selectedGoodsStatusId.value)
);

const goodsRows = computed(() =>
  overview.value?.byGoods.map((item) => ({
    ...item,
    meta: catalog.value.find((entry) => entry.goodsId === item.goodsId)
  })) ?? []
);

const lowStockGoods = computed(() => goodsRows.value.filter((item) => item.lowStockDevices > 0));
const outOfStockGoods = computed(() => goodsRows.value.filter((item) => item.outOfStockDevices > 0));

const activePolicies = computed(() =>
  policies.value.filter((item) => item.status === "active")
);

const locationOptions = computed(() => [
  ...(warehouseSnapshot.value?.warehouse
    ? [
        {
          code: warehouseSnapshot.value.warehouse.code,
          name: warehouseSnapshot.value.warehouse.name
        }
      ]
    : []),
  ...devices.value.map((item) => ({
    code: item.deviceCode,
    name: item.name
  }))
]);

const sourceGoodsOptions = computed(() => {
  if (!transferForm.fromCode) {
    return [];
  }

  if (transferForm.fromCode === warehouseSnapshot.value?.warehouse.code) {
    return (warehouseSnapshot.value?.items ?? []).map((item) => ({
      goodsId: item.goodsId,
      goodsName: item.goodsName,
      currentStock: item.totalStock
    }));
  }

  const device = devices.value.find((item) => item.deviceCode === transferForm.fromCode);
  return (
    device?.doors.flatMap((door) =>
      door.goods.map((goods) => ({
        goodsId: goods.goodsId,
        goodsName: goods.name,
        currentStock: goods.stock
      }))
    ) ?? []
  );
});

const formatDateTime = (value?: string) =>
  value ? value.slice(0, 16).replace("T", " ") : "-";

const formatDate = (value?: string) => (value ? value.slice(0, 10) : "-");

const formatStockHint = (
  item: Pick<GoodsOverviewItem, "stock" | "thresholdEnabled" | "lowStockThreshold" | "nearestExpiryAt" | "status">
) => {
  const base =
    item.thresholdEnabled && item.lowStockThreshold !== undefined
      ? `${item.stock}/${item.lowStockThreshold}`
      : `${item.stock}`;
  const tags: string[] = [];

  if (item.status === "empty" || item.status === "low") {
    tags.push("缺货");
  }

  if (item.nearestExpiryAt) {
    const expiresAt = new Date(item.nearestExpiryAt).getTime();
    const now = Date.now();
    if (expiresAt > now && expiresAt - now <= 24 * 60 * 60 * 1000) {
      tags.push("临期");
    }
  }

  return tags.length ? `${base}（${tags.join("，")}）` : base;
};

const toggleSelection = (list: string[], value: string) => {
  const index = list.indexOf(value);

  if (index >= 0) {
    list.splice(index, 1);
    return;
  }

  list.push(value);
};

const resetGoodsForm = () => {
  goodsForm.goodsCode = "";
  goodsForm.name = "";
  goodsForm.fullName = "";
  goodsForm.category = "food";
  goodsForm.categoryName = "";
  goodsForm.price = 0;
  goodsForm.packageForm = "盒装";
  goodsForm.specification = "";
  goodsForm.manufacturer = "";
  goodsForm.imageUrl = "";
};

const resetCategoryForm = () => {
  editingCategoryId.value = "";
  categoryForm.name = "";
  categoryForm.category = "food";
  categoryForm.sortOrder =
    Math.max(0, ...categories.value.map((item) => item.sortOrder), 0) + 1;
};

const resetPolicyForm = () => {
  editingPolicyId.value = "";
  policyForm.name = "";
  policyForm.status = "active";
  policyForm.applicableDeviceCodes = [];
  policyForm.thresholds = [{ goodsId: "", lowStockThreshold: 1 }];
};

const openEditor = (mode: "goods" | "goods-delete" | "category" | "policy") => {
  if (mode === "goods") {
    resetGoodsForm();
  }
  if (mode === "goods-delete") {
    selectedGoodsStatusId.value =
      catalog.value.find((item) => item.status !== "inactive")?.goodsId ?? catalog.value[0]?.goodsId ?? "";
  }
  if (mode === "category" && !editingCategoryId.value) {
    resetCategoryForm();
  }
  if (mode === "policy" && !editingPolicyId.value) {
    resetPolicyForm();
  }
  editorMode.value = mode;
};

const closeEditor = () => {
  editorMode.value = "";
  editingPolicyId.value = "";
  editingCategoryId.value = "";
  selectedGoodsStatusId.value = "";
};

const showMessage = (type: "success" | "error", text: string) => {
  message.value = { type, text };
};

const load = async () => {
  loading.value = true;
  try {
    const [overviewResponse, warehouseResponse, catalogResponse, categoryResponse, policyResponse, deviceResponse] =
      await Promise.all([
        adminApi.goodsOverview(),
        adminApi.warehouseInventory(),
        adminApi.goodsCatalog(),
        adminApi.goodsCategories(),
        adminApi.goodsAlertPolicies(),
        adminApi.devices()
      ]);

    overview.value = overviewResponse;
    warehouseSnapshot.value = warehouseResponse;
    catalog.value = catalogResponse;
    categories.value = categoryResponse;
    policies.value = policyResponse;
    devices.value = deviceResponse;

    if (!editingCategoryId.value) {
      resetCategoryForm();
    }
    transferForm.toCode = transferForm.toCode || deviceResponse[0]?.deviceCode || "";
    transferForm.goodsId = transferForm.goodsId || sourceGoodsOptions.value[0]?.goodsId || "";
  } catch (error) {
    showMessage("error", error instanceof Error ? `操作失败：${error.message}` : "操作失败");
  } finally {
    loading.value = false;
  }
};

const uploadGoodsImage = async (event: Event) => {
  const target = event.target as HTMLInputElement | null;
  const file = target?.files?.[0];

  if (!file) {
    return;
  }

  uploadingImage.value = true;
  try {
    const uploaded = await adminApi.uploadImage(file);
    goodsForm.imageUrl = uploaded.url;
    showMessage("success", "操作成功");
  } catch (error) {
    showMessage("error", error instanceof Error ? `操作失败：${error.message}` : "操作失败");
  } finally {
    uploadingImage.value = false;
    if (target) {
      target.value = "";
    }
  }
};

const saveGoods = async () => {
  if (!goodsForm.goodsCode.trim() || !goodsForm.name.trim()) {
    showMessage("error", "操作失败：请先填写商品编号和商品名称");
    return;
  }

  saving.value = true;
  try {
    await adminApi.createGoods({
      goodsCode: goodsForm.goodsCode.trim(),
      name: goodsForm.name.trim(),
      fullName: goodsForm.fullName.trim() || goodsForm.name.trim(),
      category: goodsForm.category,
      categoryName: goodsForm.categoryName || undefined,
      price: Number(goodsForm.price) || 0,
      imageUrl: goodsForm.imageUrl,
      packageForm: goodsForm.packageForm || undefined,
      specification: goodsForm.specification || undefined,
      manufacturer: goodsForm.manufacturer || undefined
    });
    resetGoodsForm();
    closeEditor();
    showMessage("success", "操作成功");
    await load();
  } catch (error) {
    showMessage("error", error instanceof Error ? `操作失败：${error.message}` : "操作失败");
  } finally {
    saving.value = false;
  }
};

const toggleGoodsStatus = async (goods = selectedGoodsForStatus.value) => {
  if (!goods) {
    showMessage("error", "操作失败：请先选择货物");
    return;
  }

  const nextStatus = goods.status === "inactive" ? "active" : "inactive";
  const actionLabel = nextStatus === "inactive" ? "删除货物" : "重新启用货物";

  if (!window.confirm(`确认${actionLabel}“${goods.name}”吗？`)) {
    return;
  }

  saving.value = true;
  try {
    await adminApi.updateGoods(goods.goodsId, {
      status: nextStatus
    });
    showMessage("success", "操作成功");
    if (editorMode.value === "goods-delete") {
      closeEditor();
    }
    await load();
  } catch (error) {
    showMessage("error", error instanceof Error ? `操作失败：${error.message}` : "操作失败");
  } finally {
    saving.value = false;
  }
};

const editCategory = (item: GoodsCategoryRecord) => {
  editingCategoryId.value = item.id;
  categoryForm.name = item.name;
  categoryForm.category = item.category;
  categoryForm.sortOrder = item.sortOrder;
  editorMode.value = "category";
};

const saveCategory = async () => {
  if (!categoryForm.name.trim()) {
    showMessage("error", "操作失败：请先填写分类名称");
    return;
  }

  saving.value = true;
  try {
    if (editingCategoryId.value) {
      await adminApi.updateGoodsCategory(editingCategoryId.value, {
        name: categoryForm.name.trim(),
        category: categoryForm.category,
        sortOrder: categoryForm.sortOrder
      });
    } else {
      await adminApi.createGoodsCategory({
        name: categoryForm.name.trim(),
        category: categoryForm.category,
        sortOrder: categoryForm.sortOrder
      });
    }
    resetCategoryForm();
    closeEditor();
    showMessage("success", "操作成功");
    await load();
  } catch (error) {
    showMessage("error", error instanceof Error ? `操作失败：${error.message}` : "操作失败");
  } finally {
    saving.value = false;
  }
};

const toggleCategoryStatus = async (item: GoodsCategoryRecord) => {
  const nextStatus = item.status === "active" ? "inactive" : "active";
  const actionLabel = nextStatus === "inactive" ? "删除分类" : "重新启用分类";

  if (!window.confirm(`确认${actionLabel}？`)) {
    return;
  }

  saving.value = true;
  try {
    await adminApi.updateGoodsCategory(item.id, {
      status: nextStatus
    });
    showMessage("success", "操作成功");
    await load();
  } catch (error) {
    showMessage("error", error instanceof Error ? `操作失败：${error.message}` : "操作失败");
  } finally {
    saving.value = false;
  }
};

const addThresholdRow = () => {
  policyForm.thresholds.push({
    goodsId: catalog.value[0]?.goodsId ?? "",
    lowStockThreshold: 1
  });
};

const removeThresholdRow = (index: number) => {
  if (policyForm.thresholds.length === 1) {
    policyForm.thresholds[0] = { goodsId: "", lowStockThreshold: 1 };
    return;
  }

  policyForm.thresholds.splice(index, 1);
};

const editPolicy = (policy: GoodsAlertPolicy) => {
  editingPolicyId.value = policy.id;
  policyForm.name = policy.name;
  policyForm.status = policy.status;
  policyForm.applicableDeviceCodes = [...policy.applicableDeviceCodes];
  policyForm.thresholds = policy.thresholds.map((item) => ({
    goodsId: item.goodsId,
    lowStockThreshold: item.lowStockThreshold
  }));
  editorMode.value = "policy";
};

const savePolicy = async () => {
  const thresholds = policyForm.thresholds
    .filter((item) => item.goodsId && item.lowStockThreshold > 0)
    .map((item) => {
      const goods = catalog.value.find((entry) => entry.goodsId === item.goodsId);

      if (!goods) {
        throw new Error("存在无效的货品阈值配置");
      }

      return {
        goodsId: goods.goodsId,
        goodsName: goods.name,
        category: goods.category,
        lowStockThreshold: item.lowStockThreshold
      };
    });

  if (!policyForm.name.trim() || !thresholds.length) {
    showMessage("error", "操作失败：请先填写模板名称并至少配置一个货品阈值");
    return;
  }

  saving.value = true;
  try {
    if (editingPolicyId.value) {
      await adminApi.updateGoodsAlertPolicy(editingPolicyId.value, {
        name: policyForm.name.trim(),
        status: policyForm.status,
        applicableDeviceCodes: [...policyForm.applicableDeviceCodes],
        thresholds
      });
    } else {
      await adminApi.createGoodsAlertPolicy({
        name: policyForm.name.trim(),
        status: policyForm.status,
        applicableDeviceCodes: [...policyForm.applicableDeviceCodes],
        thresholds
      });
    }
    resetPolicyForm();
    closeEditor();
    showMessage("success", "操作成功");
    await load();
  } catch (error) {
    showMessage("error", error instanceof Error ? `操作失败：${error.message}` : "操作失败");
  } finally {
    saving.value = false;
  }
};

const applyPolicies = async () => {
  if (!assignForm.deviceCodes.length || !assignForm.policyIds.length) {
    showMessage("error", "操作失败：请先选择柜机和模板");
    return;
  }

  if (
    assignForm.mode === "replace" &&
    !window.confirm("替换会覆盖选中柜机现有的阈值设置，确认继续吗？")
  ) {
    return;
  }

  saving.value = true;
  try {
    await adminApi.batchAssignGoodsAlertPolicies({
      deviceCodes: [...assignForm.deviceCodes],
      policyIds: [...assignForm.policyIds],
      mode: assignForm.mode
    });
    showMessage("success", "操作成功");
    await load();
  } catch (error) {
    showMessage("error", error instanceof Error ? `操作失败：${error.message}` : "操作失败");
  } finally {
    saving.value = false;
  }
};

const submitTransfer = async () => {
  if (!transferForm.fromCode || !transferForm.toCode || !transferForm.goodsId) {
    showMessage("error", "操作失败：请先选择完整的调拨信息");
    return;
  }

  saving.value = true;
  try {
    await adminApi.createInventoryTransfer({
      fromCode: transferForm.fromCode,
      toCode: transferForm.toCode,
      goodsId: transferForm.goodsId,
      quantity: transferForm.quantity,
      note: transferForm.note || undefined
    });
    transferForm.note = "";
    showMessage("success", "操作成功");
    await load();
  } catch (error) {
    showMessage("error", error instanceof Error ? `操作失败：${error.message}` : "操作失败");
  } finally {
    saving.value = false;
  }
};

const toggleAlertBucket = (bucket: "low" | "empty") => {
  expandedAlertBucket.value = expandedAlertBucket.value === bucket ? "" : bucket;
};

const exportOverview = async () => {
  if (!sessionStore.token) {
    showMessage("error", "操作失败：登录状态已失效");
    return;
  }

  try {
    const file = await adminApi.exportGoodsOverview(sessionStore.token);
    const url = window.URL.createObjectURL(file.blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = file.filename;
    anchor.click();
    window.URL.revokeObjectURL(url);
    showMessage("success", "操作成功");
  } catch (error) {
    showMessage("error", error instanceof Error ? `操作失败：${error.message}` : "操作失败");
  }
};

watch(
  () => goodsForm.category,
  () => {
    if (!filteredGoodsCategories.value.some((item) => item.name === goodsForm.categoryName)) {
      goodsForm.categoryName = filteredGoodsCategories.value[0]?.name ?? "";
    }
  }
);

watch(
  activeCategories,
  () => {
    if (!goodsForm.categoryName) {
      goodsForm.categoryName = filteredGoodsCategories.value[0]?.name ?? "";
    }
  },
  { immediate: true }
);

watch(
  () => transferForm.fromCode,
  () => {
    transferForm.goodsId = sourceGoodsOptions.value[0]?.goodsId || "";
  }
);

onMounted(load);
</script>

<template>
  <section class="admin-page">
    <section class="admin-page__section">
      <div class="admin-page__section-head">
        <div>
          <p class="admin-kicker">货物总览</p>
          <h3 class="admin-page__section-title">维护货品主数据、分类、阈值模板、库存分布与调拨</h3>
        </div>
        <div class="admin-toolbar">
          <span class="admin-copy">货品主数据、分类、阈值模板和本地仓库调拨统一在此维护</span>
          <button class="admin-button admin-button--ghost" :disabled="loading" @click="load">
            {{ loading ? "刷新中" : "刷新数据" }}
          </button>
          <button class="admin-button admin-button--ghost" @click="exportOverview">导出 Excel</button>
        </div>
      </div>

      <div v-if="message" class="admin-note" :class="{ 'goods-message--error': message.type === 'error' }">
        {{ message.text }}
      </div>

      <div class="admin-grid admin-grid--stats-4">
        <StatTile title="货品种类" :value="overview?.totalKinds ?? 0" hint="当前启用中的货品主数据" tone="accent" />
        <button class="goods-stat-button" @click="toggleAlertBucket('low')">
          <StatTile title="低库存种类" :value="overview?.lowStockKinds ?? 0" hint="已启用阈值且达到提醒线" action-label="展开详情" tone="warning" />
        </button>
        <button class="goods-stat-button" @click="toggleAlertBucket('empty')">
          <StatTile title="缺货种类" :value="overview?.outOfStockKinds ?? 0" hint="库存归零或已低于阈值" action-label="展开详情" tone="warning" />
        </button>
        <StatTile title="仓库在库量" :value="overview?.warehouseStockTotal ?? 0" hint="本地仓库当前总库存" tone="success" />
      </div>
      <div v-if="expandedAlertBucket" class="admin-panel admin-panel-block goods-expand-panel">
        <div class="admin-panel__head">
          <div>
            <span class="admin-kicker">{{ expandedAlertBucket === "low" ? "低库存明细" : "缺货明细" }}</span>
            <h3 class="admin-panel__title">{{ expandedAlertBucket === "low" ? "查看低库存货品及其分布" : "查看缺货货品及其分布" }}</h3>
          </div>
          <button class="admin-button admin-button--ghost" @click="expandedAlertBucket = ''">收起</button>
        </div>

        <table class="admin-table">
          <thead>
            <tr>
              <th>货品</th>
              <th>总库存</th>
              <th>异常柜机</th>
              <th>最短保质期</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="item in expandedAlertBucket === 'low' ? lowStockGoods : outOfStockGoods" :key="`${expandedAlertBucket}-${item.goodsId}`">
              <td>
                <RouterLink class="admin-link admin-table__strong" :to="`/goods/${item.goodsId}`">{{ item.goodsName }}</RouterLink>
                <span class="admin-table__subtext">{{ item.meta?.categoryName || categoryLabelMap[item.category] }}</span>
              </td>
              <td class="admin-code">{{ item.totalStock }}</td>
              <td>
                <div class="goods-distribution-list">
                  <div v-for="distribution in item.deviceDistribution.filter((entry) => expandedAlertBucket === 'empty' ? entry.status === 'empty' : entry.status !== 'ok')" :key="`${item.goodsId}-${distribution.deviceCode}`" class="goods-distribution-item">
                    <RouterLink class="admin-link" :to="`/operations/${distribution.deviceCode}`">{{ distribution.deviceName }}</RouterLink>
                    <span class="admin-table__subtext">{{ formatStockHint(distribution) }}</span>
                  </div>
                </div>
              </td>
              <td class="admin-code">{{ formatDate(item.nearestExpiryAt) }}</td>
            </tr>
          </tbody>
        </table>
      </div>
    </section>

    <section class="admin-page__section">
      <div class="admin-page__section-head">
        <div>
          <p class="admin-kicker">货品主数据台账</p>
          <h3 class="admin-page__section-title">按商品台账方式展示编号、全称、分类、包装和状态</h3>
        </div>
        <div class="admin-toolbar">
          <button class="admin-button" @click="openEditor('goods')">新增货物</button>
          <button class="admin-button admin-button--ghost" @click="openEditor('goods-delete')">删除货物</button>
          <button class="admin-button admin-button--ghost" @click="openEditor('category')">编辑分类</button>
        </div>
      </div>

      <article class="admin-panel admin-panel-block">
        <table v-if="sortedCatalog.length" class="admin-table">
          <thead>
            <tr>
              <th>商品名称</th>
              <th>商品全称</th>
              <th>商品编号</th>
              <th>零售价</th>
              <th>分类</th>
              <th>加入时间</th>
              <th>包装形式</th>
              <th>商品规格</th>
              <th>厂家</th>
              <th>状态</th>
              <th>操作</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="item in sortedCatalog" :key="item.goodsId">
              <td>
                <RouterLink class="admin-link admin-table__strong" :to="`/goods/${item.goodsId}`">
                  {{ item.name }}
                </RouterLink>
                <span class="admin-table__subtext">{{ item.goodsId }}</span>
              </td>
              <td>{{ item.fullName || item.name }}</td>
              <td class="admin-code">{{ item.goodsCode }}</td>
              <td class="admin-code">{{ item.price }}</td>
              <td>{{ item.categoryName || categoryLabelMap[item.category] }}</td>
              <td class="admin-code">{{ formatDateTime(item.createdAt) }}</td>
              <td>{{ item.packageForm || "-" }}</td>
              <td>{{ item.specification || "-" }}</td>
              <td>{{ item.manufacturer || "-" }}</td>
              <td>
                <span class="admin-pill" :class="item.status === 'inactive' ? 'admin-pill--neutral' : 'admin-pill--success'">
                  {{ item.status === "inactive" ? "停用" : "正常" }}
                </span>
              </td>
              <td>
                <div class="admin-inline-links goods-table-actions">
                  <RouterLink class="admin-link" :to="`/goods/${item.goodsId}`">详情</RouterLink>
                  <RouterLink class="admin-link" :to="`/goods/${item.goodsId}?action=inbound`">手动进货</RouterLink>
                  <RouterLink class="admin-link" :to="`/goods/${item.goodsId}?action=outbound`">手动退货</RouterLink>
                  <button class="admin-text-button" @click="toggleGoodsStatus(item)">
                    {{ item.status === "inactive" ? "重新启用" : "删除货物" }}
                  </button>
                </div>
              </td>
            </tr>
          </tbody>
        </table>
        <div v-else class="admin-empty">
          <div class="admin-empty__title">{{ loading ? "正在加载货品台账" : "当前没有货品主数据" }}</div>
          <div class="admin-empty__body">先新增货品或通过商户商品属性补货自动生成主数据。</div>
        </div>
      </article>
    </section>

    <section class="admin-grid admin-grid--main-aside">
      <article class="admin-panel admin-panel-block">
        <div class="admin-panel__head">
          <div>
            <span class="admin-kicker">异常与库存分布</span>
            <h3 class="admin-panel__title">缺货、低库存、模板下发与库存分布统一在这里处理</h3>
          </div>
        </div>

        <table v-if="goodsRows.length" class="admin-table">
          <thead>
            <tr>
              <th>货品</th>
              <th>总库存</th>
              <th>仓库在库</th>
              <th>缺货柜机</th>
              <th>低库存柜机</th>
              <th>最短保质期</th>
              <th>分布</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="item in goodsRows" :key="item.goodsId">
              <td>
                <RouterLink class="admin-link admin-table__strong" :to="`/goods/${item.goodsId}`">
                  {{ item.goodsName }}
                </RouterLink>
                <span class="admin-table__subtext">
                  {{ item.meta?.categoryName || categoryLabelMap[item.category] }}
                </span>
              </td>
              <td class="admin-code">{{ item.totalStock }}</td>
              <td class="admin-code">{{ item.warehouseStock }}</td>
              <td class="admin-code">{{ item.outOfStockDevices }}</td>
              <td class="admin-code">{{ item.lowStockDevices }}</td>
              <td class="admin-code">{{ formatDate(item.nearestExpiryAt) }}</td>
              <td>
                <div class="goods-distribution-list">
                  <div
                    v-for="distribution in item.deviceDistribution.slice(0, 4)"
                    :key="`${item.goodsId}-${distribution.deviceCode}`"
                    class="goods-distribution-item"
                  >
                    <RouterLink class="admin-link" :to="`/operations/${distribution.deviceCode}`">
                      {{ distribution.deviceName }}
                    </RouterLink>
                    <span class="admin-table__subtext">{{ formatStockHint(distribution) }}</span>
                  </div>
                  <span v-if="item.deviceDistribution.length > 4" class="admin-table__subtext">
                    其余 {{ item.deviceDistribution.length - 4 }} 台柜机请进详情查看
                  </span>
                </div>
              </td>
            </tr>
          </tbody>
        </table>
      </article>

      <aside class="admin-grid">
        <article class="admin-panel admin-panel-block">
          <div class="admin-panel__head">
            <div>
              <span class="admin-kicker">异常清单</span>
              <h3 class="admin-panel__title">缺货和低库存优先处理</h3>
            </div>
          </div>

          <div v-if="overview?.flaggedGoods.length" class="admin-list">
            <div v-for="item in overview.flaggedGoods.slice(0, 10)" :key="`${item.goodsId}-${item.deviceCode}`" class="admin-list__row">
              <div class="admin-list__main">
                <span class="admin-list__title">{{ item.goodsName }} / {{ item.deviceName }}</span>
                <span class="admin-list__meta">{{ formatStockHint(item) }}</span>
              </div>
              <RouterLink class="admin-link" :to="`/operations/${item.deviceCode}`">查看柜机</RouterLink>
            </div>
          </div>
          <div v-else class="admin-empty">
            <div class="admin-empty__title">{{ loading ? "正在加载异常清单" : "当前没有异常货品" }}</div>
            <div class="admin-empty__body">说明已启用阈值的货品当前都高于缺货线。</div>
          </div>
        </article>

        <article class="admin-panel admin-panel-block">
          <div class="admin-panel__head">
            <div>
              <span class="admin-kicker">批量下发与阈值模板</span>
              <h3 class="admin-panel__title">在异常与库存分布旁直接维护模板并批量下发</h3>
            </div>
            <button class="admin-button" @click="openEditor('policy')">{{ editingPolicyId ? "继续编辑模板" : "新增模板" }}</button>
          </div>

          <label class="admin-field">
            <span class="admin-field__label">下发模式</span>
            <select v-model="assignForm.mode" class="admin-select">
              <option value="replace">替换</option>
              <option value="bind">追加</option>
              <option value="unbind">解绑</option>
            </select>
          </label>

          <div class="goods-checklist">
            <span class="admin-field__label">选择柜机</span>
            <label v-for="device in devices" :key="`assign-inline-${device.deviceCode}`" class="goods-checklist__item">
              <input :checked="assignForm.deviceCodes.includes(device.deviceCode)" type="checkbox" @change="toggleSelection(assignForm.deviceCodes, device.deviceCode)" />
              <span>{{ device.name }} / {{ device.deviceCode }}</span>
            </label>
          </div>

          <table v-if="policies.length" class="admin-table">
            <thead>
              <tr>
                <th>选择</th>
                <th>模板</th>
                <th>货品阈值</th>
                <th>柜机数</th>
                <th>状态</th>
                <th>操作</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="item in policies" :key="`inline-${item.id}`">
                <td><input :checked="assignForm.policyIds.includes(item.id)" type="checkbox" @change="toggleSelection(assignForm.policyIds, item.id)" /></td>
                <td><span class="admin-table__strong">{{ item.name }}</span><span class="admin-table__subtext">{{ item.id }}</span></td>
                <td><div class="goods-distribution-list"><span v-for="threshold in item.thresholds" :key="`${item.id}-${threshold.goodsId}`" class="admin-table__subtext">{{ threshold.goodsName }} ≤ {{ threshold.lowStockThreshold }}</span></div></td>
                <td class="admin-code">{{ item.applicableDeviceCodes.length }}</td>
                <td><span class="admin-pill" :class="item.status === 'active' ? 'admin-pill--success' : 'admin-pill--neutral'">{{ item.status === "active" ? "启用" : "停用" }}</span></td>
                <td><button class="admin-button admin-button--ghost" @click="editPolicy(item)">编辑</button></td>
              </tr>
            </tbody>
          </table>
          <div v-else class="admin-empty">
            <div class="admin-empty__title">当前还没有阈值模板</div>
            <div class="admin-empty__body">可直接在这里新增模板，再批量下发到选中的柜机。</div>
          </div>

          <div class="admin-toolbar">
            <button class="admin-button" :disabled="saving || !assignForm.deviceCodes.length || !assignForm.policyIds.length" @click="applyPolicies">{{ saving ? "处理中" : "执行批量下发" }}</button>
            <span class="admin-copy">模板管理已经集成到异常与库存分布区域。</span>
          </div>
        </article>

        <article class="admin-panel admin-panel-block">
          <div class="admin-panel__head">
            <div>
              <span class="admin-kicker">最近日志</span>
              <h3 class="admin-panel__title">货品调拨、批次和模板动作</h3>
            </div>
          </div>

          <div v-if="overview?.recentLogs.length" class="admin-list">
            <div v-for="log in overview.recentLogs.slice(0, 8)" :key="log.id" class="admin-list__row">
              <div class="admin-list__main">
                <span class="admin-list__title">{{ log.description }}</span>
                <span class="admin-list__meta">{{ formatDateTime(log.occurredAt) }}</span>
              </div>
              <RouterLink class="admin-link" :to="`/logs/${log.id}`">详情</RouterLink>
            </div>
          </div>
          <div v-else class="admin-empty">
            <div class="admin-empty__title">当前没有相关日志</div>
            <div class="admin-empty__body">新增货品、分类、模板和库存流动都会记录在这里。</div>
          </div>
        </article>
      </aside>
    </section>

    <section class="admin-grid admin-grid--main-aside">
      <article class="admin-panel admin-panel-block">
        <div class="admin-panel__head">
          <div>
            <span class="admin-kicker">货物调拨</span>
            <h3 class="admin-panel__title">在柜机与本地仓库之间快速调拨物资</h3>
          </div>
        </div>

        <div class="goods-overview-form goods-overview-form--single">
          <label class="admin-field">
            <span class="admin-field__label">来源</span>
            <select v-model="transferForm.fromCode" class="admin-select">
              <option v-for="item in locationOptions" :key="item.code" :value="item.code">{{ item.name }} / {{ item.code }}</option>
            </select>
          </label>
          <label class="admin-field">
            <span class="admin-field__label">去向</span>
            <select v-model="transferForm.toCode" class="admin-select">
              <option v-for="item in locationOptions" :key="item.code" :value="item.code">{{ item.name }} / {{ item.code }}</option>
            </select>
          </label>
          <label class="admin-field">
            <span class="admin-field__label">货品</span>
            <select v-model="transferForm.goodsId" class="admin-select">
              <option v-for="item in sourceGoodsOptions" :key="item.goodsId" :value="item.goodsId">{{ item.goodsName }} / 当前 {{ item.currentStock }}</option>
            </select>
          </label>
          <label class="admin-field">
            <span class="admin-field__label">数量</span>
            <input v-model.number="transferForm.quantity" class="admin-input" type="number" min="1" />
          </label>
          <label class="admin-field">
            <span class="admin-field__label">备注</span>
            <input v-model="transferForm.note" class="admin-input" placeholder="例如 上午调拨" />
          </label>
          <div class="admin-note">货物调拨和仓库流转只维护本地库存台账，不会在平台创建调拨、补货或退货订单。</div>
          <button class="admin-button" :disabled="saving" @click="submitTransfer">{{ saving ? "处理中" : "提交调拨" }}</button>
        </div>
      </article>

      <aside class="admin-grid">
        <article class="admin-panel admin-panel-block">
          <div class="admin-panel__head">
            <div>
              <span class="admin-kicker">最近调拨</span>
              <h3 class="admin-panel__title">恢复货物调拨栏，并同步显示最近流向</h3>
            </div>
          </div>
          <table v-if="warehouseSnapshot?.transfers.length" class="admin-table">
            <thead>
              <tr>
                <th>时间</th>
                <th>货品</th>
                <th>来源</th>
                <th>去向</th>
                <th>数量</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="item in warehouseSnapshot.transfers.slice(0, 8)" :key="item.id">
                <td class="admin-code">{{ formatDateTime(item.happenedAt) }}</td>
                <td>{{ item.goodsName }}</td>
                <td>{{ item.fromName }}</td>
                <td>{{ item.toName }}</td>
                <td class="admin-code">{{ item.quantity }}</td>
              </tr>
            </tbody>
          </table>
          <div v-else class="admin-empty">
            <div class="admin-empty__title">当前没有调拨记录</div>
            <div class="admin-empty__body">提交调拨后，这里会显示最近的流转情况。</div>
          </div>
        </article>
      </aside>
    </section>

    <div v-if="editorMode" class="goods-editor-backdrop" @click.self="closeEditor">
      <aside class="goods-editor admin-panel">
        <div class="admin-panel__head">
          <div>
            <span class="admin-kicker">版面集成</span>
            <h3 class="admin-panel__title">{{ editorMode === "goods" ? "新增货物" : editorMode === "goods-delete" ? "删除货物" : editorMode === "category" ? "编辑货品分类" : editingPolicyId ? "编辑阈值模板" : "新增阈值模板" }}</h3>
          </div>
          <button class="admin-button admin-button--ghost" @click="closeEditor">关闭</button>
        </div>

        <div v-if="editorMode === 'goods'" class="goods-overview-form">
          <label class="admin-field"><span class="admin-field__label">商品编号</span><input v-model="goodsForm.goodsCode" class="admin-input" placeholder="例如 6901234567895" /></label>
          <label class="admin-field"><span class="admin-field__label">商品全称</span><input v-model="goodsForm.fullName" class="admin-input" placeholder="例如 美年达橙味500ml" /></label>
          <label class="admin-field"><span class="admin-field__label">商品名称</span><input v-model="goodsForm.name" class="admin-input" placeholder="例如 美年达" /></label>
          <label class="admin-field"><span class="admin-field__label">商品大类</span><select v-model="goodsForm.category" class="admin-select"><option v-for="(label, value) in categoryLabelMap" :key="value" :value="value">{{ label }}</option></select></label>
          <label class="admin-field"><span class="admin-field__label">分类</span><select v-model="goodsForm.categoryName" class="admin-select"><option value="">未分类</option><option v-for="item in filteredGoodsCategories" :key="item.id" :value="item.name">{{ item.name }}</option></select></label>
          <label class="admin-field"><span class="admin-field__label">零售价</span><input v-model.number="goodsForm.price" type="number" min="0" step="0.1" class="admin-input" /></label>
          <label class="admin-field"><span class="admin-field__label">包装形式</span><select v-model="goodsForm.packageForm" class="admin-select"><option v-for="item in packageFormOptions" :key="item" :value="item">{{ item }}</option></select></label>
          <label class="admin-field"><span class="admin-field__label">商品规格</span><input v-model="goodsForm.specification" class="admin-input" placeholder="例如 500ml / 12枚装" /></label>
          <label class="admin-field"><span class="admin-field__label">厂家</span><input v-model="goodsForm.manufacturer" class="admin-input" placeholder="例如 可口可乐公司" /></label>
          <label class="admin-field"><span class="admin-field__label">商品图片</span><input class="admin-input" type="file" accept="image/*" @change="uploadGoodsImage" /><span class="admin-table__subtext">{{ uploadingImage ? "上传中" : "选择本地图片后会自动上传" }}</span><img v-if="goodsForm.imageUrl" class="goods-overview-preview" :src="goodsForm.imageUrl" alt="货品图片预览" /></label>
          <div class="admin-toolbar goods-editor__actions"><button class="admin-button" :disabled="saving" @click="saveGoods">{{ saving ? "保存中" : "新增货物" }}</button><button class="admin-button admin-button--ghost" @click="resetGoodsForm">清空表单</button></div>
        </div>

        <div v-else-if="editorMode === 'goods-delete'" class="goods-overview-form goods-overview-form--single">
          <label class="admin-field">
            <span class="admin-field__label">选择货物</span>
            <select v-model="selectedGoodsStatusId" class="admin-select">
              <option v-for="item in sortedCatalog" :key="item.goodsId" :value="item.goodsId">
                {{ item.name }} / {{ item.goodsCode }} / {{ item.status === "inactive" ? "已停用" : "正常" }}
              </option>
            </select>
          </label>
          <div v-if="selectedGoodsForStatus" class="admin-note">
            当前货物：{{ selectedGoodsForStatus.name }}，状态：
            {{ selectedGoodsForStatus.status === "inactive" ? "已停用" : "正常" }}。
            删除会按逻辑停用处理，不会清掉历史记录。
          </div>
          <div class="admin-toolbar goods-editor__actions">
            <button class="admin-button admin-button--danger" :disabled="saving || !selectedGoodsForStatus" @click="toggleGoodsStatus()">
              {{ saving ? "处理中" : selectedGoodsForStatus?.status === "inactive" ? "重新启用货物" : "删除货物" }}
            </button>
          </div>
        </div>

        <div v-else-if="editorMode === 'category'" class="goods-overview-form goods-overview-form--single">
          <label class="admin-field"><span class="admin-field__label">分类名称</span><input v-model="categoryForm.name" class="admin-input" placeholder="例如 碳酸饮料" /></label>
          <label class="admin-field"><span class="admin-field__label">所属大类</span><select v-model="categoryForm.category" class="admin-select"><option v-for="(label, value) in categoryLabelMap" :key="value" :value="value">{{ label }}</option></select></label>
          <label class="admin-field"><span class="admin-field__label">排序</span><input v-model.number="categoryForm.sortOrder" type="number" min="0" class="admin-input" /></label>
          <div class="admin-toolbar goods-editor__actions"><button class="admin-button" :disabled="saving" @click="saveCategory">{{ saving ? "保存中" : editingCategoryId ? "保存分类" : "新增分类" }}</button><button class="admin-button admin-button--ghost" @click="resetCategoryForm">取消</button></div>
          <div v-if="categories.length" class="admin-list goods-category-list"><div v-for="item in categories" :key="item.id" class="admin-list__row"><div class="admin-list__main"><span class="admin-list__title">{{ item.name }}</span><span class="admin-list__meta">{{ categoryLabelMap[item.category] }} · 排序 {{ item.sortOrder }}</span></div><div class="admin-inline-links"><span class="admin-pill" :class="item.status === 'active' ? 'admin-pill--success' : 'admin-pill--neutral'">{{ item.status === "active" ? "正常" : "已停用" }}</span><button class="admin-button admin-button--ghost" @click="editCategory(item)">编辑</button><button class="admin-button admin-button--ghost" :disabled="saving" @click="toggleCategoryStatus(item)">{{ item.status === "active" ? "删除分类" : "重新启用" }}</button></div></div></div>
        </div>

        <div v-else class="goods-overview-form goods-overview-form--single">
          <label class="admin-field"><span class="admin-field__label">模板名称</span><input v-model="policyForm.name" class="admin-input" placeholder="例如 早餐柜机低库存模板" /></label>
          <label class="admin-field"><span class="admin-field__label">状态</span><select v-model="policyForm.status" class="admin-select"><option value="active">启用</option><option value="inactive">停用</option></select></label>
          <div class="goods-threshold-rows"><div v-for="(threshold, index) in policyForm.thresholds" :key="`threshold-${index}`" class="goods-threshold-row"><select v-model="threshold.goodsId" class="admin-select"><option value="">请选择货品</option><option v-for="item in catalog.filter((entry) => entry.status !== 'inactive')" :key="item.goodsId" :value="item.goodsId">{{ item.name }} / {{ item.goodsCode }}</option></select><input v-model.number="threshold.lowStockThreshold" type="number" min="1" class="admin-input" placeholder="阈值" /><button class="admin-button admin-button--ghost" @click="removeThresholdRow(index)">删除</button></div></div>
          <div class="admin-toolbar"><button class="admin-button admin-button--ghost" @click="addThresholdRow">增加货品阈值</button></div>
          <div class="goods-checklist"><span class="admin-field__label">适用柜机</span><label v-for="device in devices" :key="device.deviceCode" class="goods-checklist__item"><input :checked="policyForm.applicableDeviceCodes.includes(device.deviceCode)" type="checkbox" @change="toggleSelection(policyForm.applicableDeviceCodes, device.deviceCode)" /><span>{{ device.name }} / {{ device.deviceCode }}</span></label></div>
          <div class="admin-toolbar goods-editor__actions"><button class="admin-button" :disabled="saving" @click="savePolicy">{{ saving ? "保存中" : editingPolicyId ? "保存模板" : "新增模板" }}</button><button class="admin-button admin-button--ghost" @click="resetPolicyForm">取消</button></div>
        </div>
      </aside>
    </div>
  </section>
</template>

<style scoped>
.goods-message--error {
  border-left-color: #b42318;
  color: #7a271a;
  background: #fff2f0;
}

.goods-stat-button {
  padding: 0;
  border: 0;
  background: transparent;
  text-align: left;
  cursor: pointer;
}

.goods-overview-form {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 10px;
  margin-bottom: 12px;
}

.goods-overview-form--single {
  grid-template-columns: 1fr;
}

.goods-overview-preview {
  width: 100%;
  max-width: 180px;
  height: 180px;
  object-fit: cover;
  border-radius: 8px;
  border: 1px solid var(--admin-line);
}

.goods-table-actions {
  display: grid;
  gap: 4px;
  justify-items: start;
}

.goods-category-list,
.goods-distribution-list,
.goods-checklist {
  display: grid;
  gap: 8px;
}

.goods-distribution-item {
  display: grid;
  gap: 2px;
}

.goods-threshold-rows {
  display: grid;
  gap: 10px;
  margin-bottom: 12px;
}

.goods-threshold-row {
  display: grid;
  grid-template-columns: minmax(0, 1fr) 120px 84px;
  gap: 8px;
}

.goods-checklist {
  padding: 10px 0;
}

.goods-checklist__item {
  display: flex;
  align-items: center;
  gap: 8px;
  color: var(--admin-text);
}

.goods-expand-panel {
  margin-top: 12px;
}

.goods-editor-backdrop {
  position: fixed;
  inset: 0;
  z-index: 40;
  display: flex;
  justify-content: flex-end;
  background: rgba(15, 23, 42, 0.32);
}

.goods-editor {
  width: min(720px, 100%);
  height: 100%;
  border-radius: 0;
  border-top: 0;
  border-right: 0;
  border-bottom: 0;
  overflow: auto;
}

.goods-editor__actions {
  grid-column: 1 / -1;
}

.admin-text-button {
  border: 0;
  padding: 0;
  background: transparent;
  color: var(--admin-accent);
  font: inherit;
  cursor: pointer;
}

@media (max-width: 960px) {
  .goods-overview-form,
  .goods-threshold-row {
    grid-template-columns: 1fr;
  }
}
</style>
