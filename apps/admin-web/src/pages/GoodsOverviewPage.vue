<script setup lang="ts">
import { computed, onMounted, ref } from "vue";
import { RouterLink } from "vue-router";
import type { GoodsAlertPolicy, GoodsCatalogItem, GoodsOverviewSnapshot } from "@vm/shared-types";

import { adminApi } from "../api/admin";
import StatTile from "../components/StatTile.vue";

type DrawerMode = "" | "create-policy" | "edit-policy" | "create-goods";

interface PolicyFormState {
  name: string;
  status: GoodsAlertPolicy["status"];
  thresholds: Array<{
    goodsId: string;
    lowStockThreshold: number;
  }>;
}

interface GoodsFormState {
  goodsCode: string;
  goodsId: string;
  name: string;
  category: GoodsCatalogItem["category"];
  price: number;
  imageUrl: string;
}

const overview = ref<GoodsOverviewSnapshot>();
const policies = ref<GoodsAlertPolicy[]>([]);
const goodsCatalog = ref<GoodsCatalogItem[]>([]);
const loading = ref(false);
const saving = ref(false);
const drawerMode = ref<DrawerMode>("");
const editingPolicyId = ref("");
const goodsForm = ref<GoodsFormState>({
  goodsCode: "",
  goodsId: "",
  name: "",
  category: "daily",
  price: 0,
  imageUrl: ""
});

const selectedDeviceCodes = ref<string[]>([]);
const batchPolicyIds = ref<string[]>([]);
const batchMode = ref<"bind" | "unbind" | "replace">("bind");

const policyForm = ref<PolicyFormState>({
  name: "",
  status: "active",
  thresholds: [
    {
      goodsId: "",
      lowStockThreshold: 2
    }
  ]
});

const goodsMap = computed(() => new Map(goodsCatalog.value.map((item) => [item.goodsId, item])));

const currentDrawerTitle = computed(() =>
  drawerMode.value === "create-policy"
    ? "新增货品预警模板"
    : drawerMode.value === "edit-policy"
      ? "编辑货品预警模板"
      : "新增货品种类"
);

const allDevicesSelected = computed(
  () =>
    Boolean(overview.value?.byDevice.length) &&
    overview.value?.byDevice.every((device) => selectedDeviceCodes.value.includes(device.deviceCode))
);

const resetPolicyForm = () => {
  policyForm.value = {
    name: "",
    status: "active",
    thresholds: [
      {
        goodsId: goodsCatalog.value[0]?.goodsId ?? "",
        lowStockThreshold: 2
      }
    ]
  };
};

const load = async () => {
  loading.value = true;
  try {
    const [overviewResponse, policiesResponse, goodsCatalogResponse] = await Promise.all([
      adminApi.goodsOverview(),
      adminApi.goodsAlertPolicies(),
      adminApi.goodsCatalog()
    ]);

    overview.value = overviewResponse;
    policies.value = policiesResponse;
    goodsCatalog.value = goodsCatalogResponse;

    if (!policyForm.value.thresholds[0]?.goodsId && goodsCatalogResponse[0]) {
      policyForm.value.thresholds[0].goodsId = goodsCatalogResponse[0].goodsId;
    }
  } finally {
    loading.value = false;
  }
};

const toggleSelectAllDevices = () => {
  const deviceCodes = overview.value?.byDevice.map((item) => item.deviceCode) ?? [];

  if (allDevicesSelected.value) {
    selectedDeviceCodes.value = [];
    return;
  }

  selectedDeviceCodes.value = deviceCodes;
};

const toggleDevice = (deviceCode: string) => {
  selectedDeviceCodes.value = selectedDeviceCodes.value.includes(deviceCode)
    ? selectedDeviceCodes.value.filter((entry) => entry !== deviceCode)
    : [...selectedDeviceCodes.value, deviceCode];
};

const openCreatePolicy = () => {
  editingPolicyId.value = "";
  resetPolicyForm();
  drawerMode.value = "create-policy";
};

const openCreateGoods = () => {
  goodsForm.value = {
    goodsCode: "",
    goodsId: "",
    name: "",
    category: "daily",
    price: 0,
    imageUrl: ""
  };
  drawerMode.value = "create-goods";
};

const openEditPolicy = (policy: GoodsAlertPolicy) => {
  editingPolicyId.value = policy.id;
  policyForm.value = {
    name: policy.name,
    status: policy.status,
    thresholds: policy.thresholds.map((threshold) => ({
      goodsId: threshold.goodsId,
      lowStockThreshold: threshold.lowStockThreshold
    }))
  };
  drawerMode.value = "edit-policy";
};

const closeDrawer = () => {
  drawerMode.value = "";
  editingPolicyId.value = "";
};

const addThresholdRow = () => {
  policyForm.value.thresholds.push({
    goodsId: goodsCatalog.value[0]?.goodsId ?? "",
    lowStockThreshold: 2
  });
};

const removeThresholdRow = (index: number) => {
  policyForm.value.thresholds.splice(index, 1);
  if (!policyForm.value.thresholds.length) {
    addThresholdRow();
  }
};

const submitPolicyForm = async () => {
  const normalizedThresholds = policyForm.value.thresholds
    .filter((entry) => entry.goodsId && entry.lowStockThreshold >= 0)
    .map((entry) => {
      const goods = goodsMap.value.get(entry.goodsId);

      if (!goods) {
        throw new Error(`未找到货品 ${entry.goodsId}。`);
      }

      return {
        goodsId: goods.goodsId,
        goodsName: goods.name,
        category: goods.category,
        lowStockThreshold: entry.lowStockThreshold
      };
    });

  if (!policyForm.value.name.trim() || !normalizedThresholds.length) {
    return;
  }

  saving.value = true;
  try {
    const payload = {
      name: policyForm.value.name.trim(),
      status: policyForm.value.status,
      thresholds: normalizedThresholds
    };

    if (drawerMode.value === "create-policy") {
      await adminApi.createGoodsAlertPolicy({
        ...payload,
        applicableDeviceCodes: []
      });
    } else if (drawerMode.value === "edit-policy" && editingPolicyId.value) {
      const existing = policies.value.find((policy) => policy.id === editingPolicyId.value);
      await adminApi.updateGoodsAlertPolicy(editingPolicyId.value, {
        ...payload,
        applicableDeviceCodes: existing?.applicableDeviceCodes ?? []
      });
    }

    closeDrawer();
    await load();
  } finally {
    saving.value = false;
  }
};

const submitGoodsForm = async () => {
  if (!goodsForm.value.goodsCode.trim() || !goodsForm.value.goodsId.trim() || !goodsForm.value.name.trim()) {
    return;
  }

  saving.value = true;
  try {
    await adminApi.createGoods({
      goodsCode: goodsForm.value.goodsCode.trim(),
      goodsId: goodsForm.value.goodsId.trim(),
      name: goodsForm.value.name.trim(),
      category: goodsForm.value.category,
      price: goodsForm.value.price,
      imageUrl: goodsForm.value.imageUrl.trim()
    });
    closeDrawer();
    await load();
  } finally {
    saving.value = false;
  }
};

const applyBatchPolicies = async () => {
  if (!selectedDeviceCodes.value.length || !batchPolicyIds.value.length) {
    return;
  }

  saving.value = true;
  try {
    await adminApi.batchAssignGoodsAlertPolicies({
      deviceCodes: selectedDeviceCodes.value,
      policyIds: batchPolicyIds.value,
      mode: batchMode.value
    });
    await load();
  } finally {
    saving.value = false;
  }
};

const syncDeviceGoods = async (deviceCode: string) => {
  saving.value = true;
  try {
    await adminApi.syncDeviceGoods(deviceCode);
    await load();
  } finally {
    saving.value = false;
  }
};

const policyDeviceSummary = (policy: GoodsAlertPolicy) =>
  policy.applicableDeviceCodes.length
    ? policy.applicableDeviceCodes.join("、")
    : "当前未绑定任何柜机";

onMounted(load);
</script>

<template>
  <section class="admin-page">
    <section class="admin-page__section">
      <div class="admin-page__section-head">
        <div>
          <p class="admin-kicker">货物总览</p>
          <h3 class="admin-page__section-title">查看商品种类、库存分布和货品预警模板</h3>
        </div>
        <div class="admin-toolbar">
          <button class="admin-button admin-button--ghost" @click="openCreateGoods">新增货品种类</button>
          <button class="admin-button" @click="openCreatePolicy">新增货品预警模板</button>
        </div>
      </div>

      <div class="admin-grid admin-grid--stats-4">
        <StatTile title="货品总种类" :value="overview?.totalKinds ?? 0" hint="本地货物主数据中的种类数" />
        <StatTile title="低库存种类" :value="overview?.lowStockKinds ?? 0" hint="命中模板阈值的货品种类数" tone="warning" />
        <StatTile title="缺货种类" :value="overview?.outOfStockKinds ?? 0" hint="库存为 0 的货品种类数" tone="warning" />
        <StatTile title="预警模板数" :value="overview?.policyCount ?? policies.length" hint="可批量绑定到选中柜机" />
      </div>
    </section>

    <section class="admin-grid admin-grid--main-aside">
      <article class="admin-panel admin-panel-block">
        <div class="admin-panel__head">
          <div>
            <span class="admin-kicker">商品种类分布</span>
            <h3 class="admin-panel__title">每个货品在各柜机中的库存和阈值分布</h3>
          </div>
        </div>

        <table v-if="overview?.byGoods.length" class="admin-table">
          <thead>
            <tr>
              <th>货品</th>
              <th>总库存</th>
              <th>低库存柜机</th>
              <th>缺货柜机</th>
              <th>最短保质期</th>
              <th>柜机分布</th>
              <th>操作</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="item in overview.byGoods" :key="item.goodsId">
              <td>
                <RouterLink class="admin-link admin-table__strong" :to="`/goods/${item.goodsId}`">
                  {{ item.goodsName }}
                </RouterLink>
                <span class="admin-table__subtext">{{ item.goodsId }} · {{ item.category }}</span>
              </td>
              <td class="admin-code">{{ item.totalStock }}</td>
              <td class="admin-code">{{ item.lowStockDevices }}</td>
              <td class="admin-code">{{ item.outOfStockDevices }}</td>
              <td class="admin-code">{{ item.nearestExpiryAt ? item.nearestExpiryAt.slice(0, 16).replace("T", " ") : "-" }}</td>
              <td>
                <div class="goods-distribution">
                  <div
                    v-for="distribution in item.deviceDistribution"
                    :key="`${item.goodsId}-${distribution.deviceCode}`"
                    class="goods-distribution__item"
                  >
                    <RouterLink class="admin-link" :to="`/operations/${distribution.deviceCode}`">
                      {{ distribution.deviceName }}
                    </RouterLink>
                    <span class="admin-table__subtext">
                      {{ distribution.deviceCode }} · 库存 {{ distribution.stock }} · 阈值 {{ distribution.thresholdEnabled ? distribution.lowStockThreshold : "未启用" }}
                    </span>
                  </div>
                </div>
              </td>
              <td>
                <RouterLink class="admin-link" :to="`/goods/${item.goodsId}`">详情</RouterLink>
              </td>
            </tr>
          </tbody>
        </table>
        <div v-else class="admin-empty">
          <div class="admin-empty__title">{{ loading ? "正在加载货品总览" : "当前没有货品种类数据" }}</div>
          <div class="admin-empty__body">请先同步柜机商品类型，或检查本地货物主数据是否为空。</div>
        </div>
      </article>

      <aside class="admin-grid">
        <article class="admin-panel admin-panel-block">
          <div class="admin-panel__head">
            <div>
              <span class="admin-kicker">批量绑定模板</span>
              <h3 class="admin-panel__title">对选中柜机应用货品预警模板</h3>
            </div>
            <button class="admin-button admin-button--ghost" @click="toggleSelectAllDevices">
              {{ allDevicesSelected ? "取消全选" : "全选柜机" }}
            </button>
          </div>

          <div class="goods-device-checklist">
            <label
              v-for="device in overview?.byDevice ?? []"
              :key="device.deviceCode"
              class="goods-device-checklist__item"
            >
              <input
                type="checkbox"
                :checked="selectedDeviceCodes.includes(device.deviceCode)"
                @change="toggleDevice(device.deviceCode)"
              />
              <span>{{ device.deviceName }}</span>
              <span class="admin-table__subtext">{{ device.deviceCode }} · 总库存 {{ device.totalStock }}</span>
            </label>
          </div>

          <label class="admin-field">
            <span class="admin-field__label">操作方式</span>
            <select v-model="batchMode" class="admin-select">
              <option value="bind">追加绑定</option>
              <option value="replace">替换为以下模板</option>
              <option value="unbind">解绑以下模板</option>
            </select>
          </label>

          <div class="admin-field">
            <span class="admin-field__label">模板选择</span>
            <div class="goods-policy-checklist">
              <label v-for="policy in policies" :key="policy.id" class="goods-policy-checklist__item">
                <input v-model="batchPolicyIds" type="checkbox" :value="policy.id" />
                <span>{{ policy.name }}</span>
                <span class="admin-table__subtext">{{ policy.applicableDeviceCodes.length }} 台柜机</span>
              </label>
            </div>
          </div>

          <button
            class="admin-button"
            :disabled="saving || !selectedDeviceCodes.length || !batchPolicyIds.length"
            @click="applyBatchPolicies"
          >
            {{ saving ? "保存中" : "应用模板到选中柜机" }}
          </button>
        </article>

        <article class="admin-panel admin-panel-block">
          <div class="admin-panel__head">
            <div>
              <span class="admin-kicker">模板库</span>
              <h3 class="admin-panel__title">维护每种货品的低库存阈值</h3>
            </div>
          </div>

          <div v-if="policies.length" class="admin-list">
            <div v-for="policy in policies" :key="policy.id" class="admin-list__row goods-policy-row">
              <div class="admin-list__main">
                <span class="admin-list__title">{{ policy.name }}</span>
                <span class="admin-list__meta">{{ policy.status === "active" ? "启用中" : "已停用" }}</span>
                <span class="admin-table__subtext">
                  {{ policy.thresholds.map((item) => `${item.goodsName}≤${item.lowStockThreshold}`).join("，") }}
                </span>
                <span class="admin-table__subtext">{{ policyDeviceSummary(policy) }}</span>
              </div>
              <button class="admin-text-button" @click="openEditPolicy(policy)">编辑</button>
            </div>
          </div>
          <div v-else class="admin-empty">
            <div class="admin-empty__title">当前没有货品预警模板</div>
            <div class="admin-empty__body">请先新增模板，再将其批量绑定到选中柜机。</div>
          </div>
        </article>

        <article class="admin-panel admin-panel-block">
          <div class="admin-panel__head">
            <div>
              <span class="admin-kicker">柜机快速同步</span>
              <h3 class="admin-panel__title">读取柜机上的商品种类</h3>
            </div>
          </div>

          <div class="admin-list">
            <div v-for="device in overview?.byDevice ?? []" :key="device.deviceCode" class="admin-list__row">
              <div class="admin-list__main">
                <span class="admin-list__title">{{ device.deviceName }}</span>
                <span class="admin-table__subtext">{{ device.deviceCode }} · 异常项 {{ device.lowStockItems }}</span>
              </div>
              <button class="admin-button admin-button--ghost" :disabled="saving" @click="syncDeviceGoods(device.deviceCode)">
                {{ saving ? "处理中" : "同步种类" }}
              </button>
            </div>
          </div>
        </article>
      </aside>
    </section>
  </section>

  <div v-if="drawerMode" class="goods-drawer-backdrop" @click.self="closeDrawer">
    <aside class="goods-drawer admin-panel">
      <div class="admin-panel__head">
        <div>
          <span class="admin-kicker">模板编辑</span>
          <h3 class="admin-panel__title">{{ currentDrawerTitle }}</h3>
        </div>
        <button class="admin-button admin-button--ghost" @click="closeDrawer">关闭</button>
      </div>

        <div v-if="drawerMode === 'create-goods'" class="goods-drawer__body">
          <label class="admin-field">
            <span class="admin-field__label">货品码</span>
            <input v-model="goodsForm.goodsCode" class="admin-input" placeholder="例如 690000000001" />
          </label>
          <label class="admin-field">
            <span class="admin-field__label">货品编号</span>
            <input v-model="goodsForm.goodsId" class="admin-input" placeholder="例如 93020323" />
          </label>
          <label class="admin-field">
            <span class="admin-field__label">名称</span>
            <input v-model="goodsForm.name" class="admin-input" placeholder="例如 可口可乐" />
          </label>
          <label class="admin-field">
            <span class="admin-field__label">分类</span>
            <select v-model="goodsForm.category" class="admin-select">
              <option value="food">食品</option>
              <option value="drink">饮品</option>
              <option value="daily">日用品</option>
            </select>
          </label>
          <label class="admin-field">
            <span class="admin-field__label">价格</span>
            <input v-model.number="goodsForm.price" class="admin-input" type="number" min="0" />
          </label>
          <label class="admin-field">
            <span class="admin-field__label">图片地址</span>
            <input v-model="goodsForm.imageUrl" class="admin-input" placeholder="http://example.com/goods.png" />
          </label>
          <button
            class="admin-button"
            :disabled="saving || !goodsForm.goodsCode.trim() || !goodsForm.goodsId.trim() || !goodsForm.name.trim()"
            @click="submitGoodsForm"
          >
            {{ saving ? "保存中" : "保存货品种类" }}
          </button>
        </div>

        <div v-else class="goods-drawer__body">
          <label class="admin-field">
            <span class="admin-field__label">模板名称</span>
            <input v-model="policyForm.name" class="admin-input" placeholder="例如早餐柜机低库存模板" />
        </label>
        <label class="admin-field">
          <span class="admin-field__label">状态</span>
          <select v-model="policyForm.status" class="admin-select">
            <option value="active">启用</option>
            <option value="inactive">停用</option>
          </select>
        </label>

        <div class="admin-field">
          <span class="admin-field__label">货品阈值</span>
          <div class="goods-thresholds">
            <div
              v-for="(threshold, index) in policyForm.thresholds"
              :key="`${index}-${threshold.goodsId}`"
              class="goods-thresholds__row"
            >
              <select v-model="threshold.goodsId" class="admin-select">
                <option v-for="goods in goodsCatalog" :key="goods.goodsId" :value="goods.goodsId">
                  {{ goods.name }} / {{ goods.goodsId }}
                </option>
              </select>
              <input v-model.number="threshold.lowStockThreshold" class="admin-input" type="number" min="0" />
              <button class="admin-button admin-button--ghost" @click="removeThresholdRow(index)">删除</button>
            </div>
          </div>
          <button class="admin-text-button" @click="addThresholdRow">继续添加货品阈值</button>
        </div>

        <button class="admin-button" :disabled="saving || !policyForm.name.trim()" @click="submitPolicyForm">
          {{ saving ? "保存中" : "保存货品预警模板" }}
        </button>
      </div>
    </aside>
  </div>
</template>

<style scoped>
.goods-distribution {
  display: grid;
  gap: 6px;
}

.goods-distribution__item {
  display: grid;
  gap: 2px;
}

.goods-device-checklist,
.goods-policy-checklist,
.goods-thresholds,
.goods-drawer__body {
  display: grid;
  gap: 8px;
}

.goods-device-checklist__item,
.goods-policy-checklist__item {
  display: grid;
  gap: 2px;
  padding: 8px 10px;
  border: 1px solid var(--admin-line);
  border-radius: 8px;
  background: var(--admin-panel-muted);
}

.goods-thresholds__row {
  display: grid;
  grid-template-columns: minmax(0, 1fr) 100px 80px;
  gap: 8px;
}

.goods-policy-row {
  align-items: flex-start;
}

.admin-text-button {
  padding: 0;
  border: 0;
  background: transparent;
  color: var(--admin-accent-strong);
  font-weight: 700;
  cursor: pointer;
}

.goods-drawer-backdrop {
  position: fixed;
  inset: 0;
  z-index: 30;
  display: grid;
  justify-items: end;
  padding: 16px;
  background: rgba(21, 31, 43, 0.26);
}

.goods-drawer {
  width: min(560px, 100%);
  max-height: calc(100vh - 32px);
  display: grid;
  gap: 12px;
  padding: 14px;
  overflow: auto;
}

@media (max-width: 720px) {
  .goods-thresholds__row {
    grid-template-columns: 1fr;
  }

  .goods-drawer-backdrop {
    justify-items: stretch;
    padding: 0;
  }

  .goods-drawer {
    width: 100%;
    max-height: 100vh;
    border-radius: 0;
  }
}
</style>
