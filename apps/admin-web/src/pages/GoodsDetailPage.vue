<script setup lang="ts">
import { computed, onMounted, ref, watch } from "vue";
import { RouterLink, useRoute } from "vue-router";

import { adminApi } from "../api/admin";

const route = useRoute();

const detail = ref<Awaited<ReturnType<typeof adminApi.goodsDetail>>>();
const loading = ref(false);
const saving = ref(false);

const goodsForm = ref({
  goodsCode: "",
  name: "",
  category: "daily" as "food" | "drink" | "daily",
  price: 0,
  imageUrl: "",
  status: "active" as "active" | "inactive"
});

const batchForm = ref({
  deviceCode: "",
  quantity: 1,
  expiresAt: "",
  sourceType: "admin" as "admin" | "merchant" | "system",
  sourceUserName: "",
  note: ""
});

const batchRemoveForm = ref<Record<string, { quantity: number; note: string }>>({});
const thresholdForm = ref<Record<string, { enabled: boolean; lowStockThreshold: number }>>({});

const goods = computed(() => detail.value?.goods);
const batches = computed(() => detail.value?.batches ?? []);
const deviceSettings = computed(() => detail.value?.deviceSettings ?? []);
const recentLogs = computed(() => detail.value?.recentLogs ?? []);

const load = async () => {
  loading.value = true;
  try {
    const response = await adminApi.goodsDetail(String(route.params.goodsId));
    detail.value = response;
    goodsForm.value = {
      goodsCode: response.goods.goodsCode,
      name: response.goods.name,
      category: response.goods.category,
      price: response.goods.price,
      imageUrl: response.goods.imageUrl,
      status: response.goods.status ?? "active"
    };
    batchForm.value.deviceCode = response.deviceSettings[0]?.deviceCode ?? "";
    thresholdForm.value = Object.fromEntries(
      response.deviceSettings.map((item) => [
        item.deviceCode,
        {
          enabled: item.enabled,
          lowStockThreshold: item.lowStockThreshold ?? 1
        }
      ])
    );
    batchRemoveForm.value = Object.fromEntries(
      response.batches.map((item) => [
        item.batchId,
        {
          quantity: Math.max(1, item.remainingQuantity),
          note: ""
        }
      ])
    );
  } finally {
    loading.value = false;
  }
};

const saveGoods = async () => {
  if (!goods.value) {
    return;
  }

  saving.value = true;
  try {
    await adminApi.updateGoods(goods.value.goodsId, {
      goodsCode: goodsForm.value.goodsCode,
      name: goodsForm.value.name,
      category: goodsForm.value.category,
      price: goodsForm.value.price,
      imageUrl: goodsForm.value.imageUrl,
      status: goodsForm.value.status
    });
    await load();
  } finally {
    saving.value = false;
  }
};

const addBatch = async () => {
  if (!goods.value || !batchForm.value.deviceCode || batchForm.value.quantity <= 0) {
    return;
  }

  saving.value = true;
  try {
    await adminApi.addGoodsBatch(goods.value.goodsId, {
      deviceCode: batchForm.value.deviceCode,
      quantity: batchForm.value.quantity,
      expiresAt: batchForm.value.expiresAt ? new Date(batchForm.value.expiresAt).toISOString() : undefined,
      sourceType: batchForm.value.sourceType,
      sourceUserName: batchForm.value.sourceUserName || undefined,
      note: batchForm.value.note || undefined
    });
    batchForm.value.quantity = 1;
    batchForm.value.expiresAt = "";
    batchForm.value.note = "";
    await load();
  } finally {
    saving.value = false;
  }
};

const removeBatch = async (batchId: string) => {
  const form = batchRemoveForm.value[batchId];

  if (!form || form.quantity <= 0) {
    return;
  }

  saving.value = true;
  try {
    await adminApi.removeGoodsBatch(batchId, {
      quantity: form.quantity,
      note: form.note || undefined
    });
    await load();
  } finally {
    saving.value = false;
  }
};

const saveThreshold = async (deviceCode: string) => {
  if (!goods.value) {
    return;
  }

  const form = thresholdForm.value[deviceCode];

  if (!form) {
    return;
  }

  saving.value = true;
  try {
    await adminApi.updateDeviceGoodsThreshold(deviceCode, goods.value.goodsId, {
      enabled: form.enabled,
      lowStockThreshold: form.enabled ? form.lowStockThreshold : undefined
    });
    await load();
  } finally {
    saving.value = false;
  }
};

watch(
  () => route.params.goodsId,
  async () => {
    await load();
  }
);

onMounted(load);
</script>

<template>
  <section class="admin-page">
    <section v-if="detail" class="admin-grid">
      <article class="admin-panel admin-panel-block">
        <div class="admin-panel__head">
          <div>
            <span class="admin-kicker">货物详情</span>
            <h3 class="admin-panel__title">{{ detail.goods.name }}</h3>
          </div>
          <RouterLink class="admin-link" to="/goods">返回货物总览</RouterLink>
        </div>

        <div class="admin-grid admin-grid--stats-4">
          <div class="device-detail-status__item">
            <span class="admin-kicker">货品编号</span>
            <strong class="admin-code">{{ detail.goods.goodsId }}</strong>
            <span class="admin-table__subtext">{{ detail.goods.goodsCode }}</span>
          </div>
          <div class="device-detail-status__item">
            <span class="admin-kicker">当前总库存</span>
            <strong class="admin-code">{{ detail.totalStock }}</strong>
            <span class="admin-table__subtext">按批次剩余量聚合</span>
          </div>
          <div class="device-detail-status__item">
            <span class="admin-kicker">最短保质期</span>
            <strong class="admin-code">{{ detail.nearestExpiryAt ? detail.nearestExpiryAt.slice(0, 16).replace("T", " ") : "-" }}</strong>
            <span class="admin-table__subtext">取当前剩余批次中最早到期的一批</span>
          </div>
          <div class="device-detail-status__item">
            <span class="admin-kicker">柜机分布</span>
            <strong class="admin-code">{{ detail.deviceDistribution.length }}</strong>
            <span class="admin-table__subtext">已覆盖柜机 / 阈值设置同时在下方可改</span>
          </div>
        </div>
      </article>

      <section class="admin-grid admin-grid--main-aside">
        <article class="admin-panel admin-panel-block">
          <div class="admin-panel__head">
            <div>
              <span class="admin-kicker">基础信息</span>
              <h3 class="admin-panel__title">可停用货品种类，但不物理删除历史</h3>
            </div>
          </div>

          <div class="goods-detail-form">
            <label class="admin-field">
              <span class="admin-field__label">货品码</span>
              <input v-model="goodsForm.goodsCode" class="admin-input" />
            </label>
            <label class="admin-field">
              <span class="admin-field__label">名称</span>
              <input v-model="goodsForm.name" class="admin-input" />
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
              <input v-model.number="goodsForm.price" type="number" min="0" class="admin-input" />
            </label>
            <label class="admin-field">
              <span class="admin-field__label">图片地址</span>
              <input v-model="goodsForm.imageUrl" class="admin-input" />
            </label>
            <label class="admin-field">
              <span class="admin-field__label">状态</span>
              <select v-model="goodsForm.status" class="admin-select">
                <option value="active">启用</option>
                <option value="inactive">停用</option>
              </select>
            </label>
          </div>

          <button class="admin-button" :disabled="saving" @click="saveGoods">
            {{ saving ? "保存中" : "保存货品信息" }}
          </button>
        </article>

        <aside class="admin-grid">
          <article class="admin-panel admin-panel-block">
            <div class="admin-panel__head">
              <div>
                <span class="admin-kicker">手工入库</span>
                <h3 class="admin-panel__title">新增批次并记录来源</h3>
              </div>
            </div>

            <div class="goods-detail-form">
              <label class="admin-field">
                <span class="admin-field__label">柜机</span>
                <select v-model="batchForm.deviceCode" class="admin-select">
                  <option v-for="item in detail.deviceSettings" :key="item.deviceCode" :value="item.deviceCode">
                    {{ item.deviceName }} / {{ item.deviceCode }}
                  </option>
                </select>
              </label>
              <label class="admin-field">
                <span class="admin-field__label">数量</span>
                <input v-model.number="batchForm.quantity" type="number" min="1" class="admin-input" />
              </label>
              <label class="admin-field">
                <span class="admin-field__label">保质期</span>
                <input v-model="batchForm.expiresAt" type="datetime-local" class="admin-input" />
              </label>
              <label class="admin-field">
                <span class="admin-field__label">来源类型</span>
                <select v-model="batchForm.sourceType" class="admin-select">
                  <option value="admin">管理员</option>
                  <option value="merchant">商户</option>
                  <option value="system">系统补录</option>
                </select>
              </label>
              <label class="admin-field">
                <span class="admin-field__label">来源名称</span>
                <input v-model="batchForm.sourceUserName" class="admin-input" placeholder="例如 鲜食爱心商户" />
              </label>
              <label class="admin-field">
                <span class="admin-field__label">备注</span>
                <input v-model="batchForm.note" class="admin-input" placeholder="例如 上午批次" />
              </label>
            </div>

            <button class="admin-button" :disabled="saving" @click="addBatch">
              {{ saving ? "处理中" : "新增批次" }}
            </button>
          </article>

          <article class="admin-panel admin-panel-block">
            <div class="admin-panel__head">
              <div>
                <span class="admin-kicker">最近日志</span>
                <h3 class="admin-panel__title">货物流动与阈值调整</h3>
              </div>
            </div>

            <div v-if="recentLogs.length" class="admin-list">
              <div v-for="log in recentLogs" :key="log.id" class="admin-list__row">
                <div class="admin-list__main">
                  <span class="admin-list__title">{{ log.description }}</span>
                  <span class="admin-list__meta">{{ log.occurredAt.slice(0, 16).replace("T", " ") }}</span>
                </div>
                <RouterLink class="admin-link" :to="`/logs/${log.id}`">详情</RouterLink>
              </div>
            </div>
            <div v-else class="admin-empty">
              <div class="admin-empty__title">当前没有相关日志</div>
              <div class="admin-empty__body">手工入库、去除、阈值设置和同步种类会记录在这里。</div>
            </div>
          </article>
        </aside>
      </section>

      <section class="admin-page__section">
        <div class="admin-page__section-head">
          <div>
            <p class="admin-kicker">批次列表</p>
            <h3 class="admin-page__section-title">来源、柜机、数量与保质期</h3>
          </div>
        </div>

        <article class="admin-panel admin-panel-block">
          <table v-if="batches.length" class="admin-table">
            <thead>
              <tr>
                <th>批次</th>
                <th>来源</th>
                <th>所在柜机</th>
                <th>数量</th>
                <th>保质期</th>
                <th>去除</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="batch in batches" :key="batch.batchId">
                <td>
                  <span class="admin-table__strong">{{ batch.batchId }}</span>
                  <span class="admin-table__subtext">{{ batch.createdAt.slice(0, 16).replace("T", " ") }}</span>
                </td>
                <td>
                  <span class="admin-table__strong">{{ batch.sourceUserName || batch.sourceType }}</span>
                  <span class="admin-table__subtext">{{ batch.sourceType }}{{ batch.sourceUserId ? ` · ${batch.sourceUserId}` : "" }}</span>
                </td>
                <td>
                  <RouterLink class="admin-link" :to="`/operations/${batch.deviceCode}`">{{ batch.deviceCode }}</RouterLink>
                </td>
                <td class="admin-code">{{ batch.remainingQuantity }} / {{ batch.quantity }}</td>
                <td class="admin-code">{{ batch.expiresAt ? batch.expiresAt.slice(0, 16).replace("T", " ") : "-" }}</td>
                <td>
                  <div class="goods-batch-actions">
                    <input
                      v-model.number="batchRemoveForm[batch.batchId].quantity"
                      type="number"
                      min="1"
                      :max="Math.max(1, batch.remainingQuantity)"
                      class="admin-input"
                    />
                    <input
                      v-model="batchRemoveForm[batch.batchId].note"
                      class="admin-input"
                      placeholder="去除说明"
                    />
                    <button
                      class="admin-button admin-button--ghost"
                      :disabled="saving || batch.remainingQuantity <= 0"
                      @click="removeBatch(batch.batchId)"
                    >
                      {{ saving ? "处理中" : "去除" }}
                    </button>
                  </div>
                </td>
              </tr>
            </tbody>
          </table>
          <div v-else class="admin-empty">
            <div class="admin-empty__title">当前还没有批次记录</div>
            <div class="admin-empty__body">新增批次后，这里会按保质期和创建时间展示明细。</div>
          </div>
        </article>
      </section>

      <section class="admin-page__section">
        <div class="admin-page__section-head">
          <div>
            <p class="admin-kicker">柜机阈值</p>
            <h3 class="admin-page__section-title">每台柜机单独开启或关闭低库存提醒</h3>
          </div>
        </div>

        <article class="admin-panel admin-panel-block">
          <table class="admin-table">
            <thead>
              <tr>
                <th>柜机</th>
                <th>当前库存</th>
                <th>最短保质期</th>
                <th>阈值开关</th>
                <th>阈值</th>
                <th>保存</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="item in deviceSettings" :key="item.deviceCode">
                <td>
                  <RouterLink class="admin-link" :to="`/operations/${item.deviceCode}`">{{ item.deviceName }}</RouterLink>
                  <span class="admin-table__subtext">{{ item.deviceCode }}</span>
                </td>
                <td class="admin-code">{{ item.currentStock }}</td>
                <td class="admin-code">{{ item.nearestExpiryAt ? item.nearestExpiryAt.slice(0, 16).replace("T", " ") : "-" }}</td>
                <td>
                  <label class="goods-threshold-toggle">
                    <input v-model="thresholdForm[item.deviceCode].enabled" type="checkbox" />
                    <span>{{ thresholdForm[item.deviceCode].enabled ? "已开启" : "未启用" }}</span>
                  </label>
                </td>
                <td>
                  <input
                    v-model.number="thresholdForm[item.deviceCode].lowStockThreshold"
                    type="number"
                    min="0"
                    class="admin-input"
                    :disabled="!thresholdForm[item.deviceCode].enabled"
                  />
                </td>
                <td>
                  <button class="admin-button admin-button--ghost" :disabled="saving" @click="saveThreshold(item.deviceCode)">
                    {{ saving ? "保存中" : "保存" }}
                  </button>
                </td>
              </tr>
            </tbody>
          </table>
        </article>
      </section>
    </section>

    <div v-else class="admin-empty">
      <div class="admin-empty__title">{{ loading ? "正在加载货物详情" : "未找到对应货物" }}</div>
      <div class="admin-empty__body">请返回货物总览重新选择货品，或确认货物编号是否正确。</div>
    </div>
  </section>
</template>

<style scoped>
.goods-detail-form {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 10px;
  margin-bottom: 12px;
}

.goods-batch-actions {
  display: grid;
  grid-template-columns: 90px minmax(0, 1fr) 80px;
  gap: 8px;
}

.goods-threshold-toggle {
  display: inline-flex;
  align-items: center;
  gap: 6px;
}

.device-detail-status__item {
  display: grid;
  gap: 6px;
  padding: 10px 12px;
  border: 1px solid var(--admin-line);
  border-radius: 8px;
  background: var(--admin-panel-muted);
}

@media (max-width: 960px) {
  .goods-detail-form,
  .goods-batch-actions {
    grid-template-columns: 1fr;
  }
}
</style>
