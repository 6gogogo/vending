<script setup lang="ts">
import { computed, onMounted, ref, watch } from "vue";
import { RouterLink } from "vue-router";

import type { DeviceMonitoringDetail, DeviceRecord, WarehouseInventorySnapshot } from "@vm/shared-types";

import { adminApi } from "../api/admin";
import StatTile from "../components/StatTile.vue";
import { useAdminSessionStore } from "../stores/session";

const sessionStore = useAdminSessionStore();
const loading = ref(false);
const saving = ref(false);
const snapshot = ref<WarehouseInventorySnapshot>();
const devices = ref<DeviceRecord[]>([]);
const stocktakeDetail = ref<DeviceMonitoringDetail>();
const message = ref<{ type: "success" | "error"; text: string }>();

const transferForm = ref({
  fromCode: "WAREHOUSE-LOCAL",
  toCode: "",
  goodsId: "",
  quantity: 1,
  note: ""
});

const stocktakeForm = ref({
  deviceCode: "",
  note: ""
});

const stocktakeItems = ref<Array<{ goodsId: string; goodsName: string; actualQuantity: number; systemQuantity: number }>>([]);

const locationOptions = computed(() => {
  const warehouse = snapshot.value?.warehouse;
  return [
    ...(warehouse
      ? [
          {
            code: warehouse.code,
            name: warehouse.name
          }
        ]
      : []),
    ...devices.value.map((item) => ({
      code: item.deviceCode,
      name: item.name
    }))
  ];
});

const sourceGoodsOptions = computed(() => {
  if (!transferForm.value.fromCode) {
    return [];
  }

  if (transferForm.value.fromCode === snapshot.value?.warehouse.code) {
    return snapshot.value.items.map((item) => ({
      goodsId: item.goodsId,
      goodsName: item.goodsName,
      currentStock: item.totalStock
    }));
  }

  const device = devices.value.find((item) => item.deviceCode === transferForm.value.fromCode);

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

const loadStocktakeDevice = async (deviceCode: string) => {
  if (!deviceCode) {
    stocktakeDetail.value = undefined;
    stocktakeItems.value = [];
    return;
  }

  stocktakeDetail.value = await adminApi.deviceDetail(deviceCode);
  stocktakeItems.value = stocktakeDetail.value.stockChanges.map((item) => ({
    goodsId: item.goodsId,
    goodsName: item.goodsName,
    actualQuantity: item.currentStock,
    systemQuantity: item.currentStock
  }));
};

const load = async () => {
  loading.value = true;
  try {
    const [warehouseResponse, deviceResponse] = await Promise.all([
      adminApi.warehouseInventory(),
      adminApi.devices()
    ]);

    snapshot.value = warehouseResponse;
    devices.value = deviceResponse;

    transferForm.value.toCode = transferForm.value.toCode || deviceResponse[0]?.deviceCode || "";
    transferForm.value.goodsId =
      transferForm.value.goodsId || sourceGoodsOptions.value[0]?.goodsId || "";
    stocktakeForm.value.deviceCode = stocktakeForm.value.deviceCode || deviceResponse[0]?.deviceCode || "";

    if (stocktakeForm.value.deviceCode) {
      await loadStocktakeDevice(stocktakeForm.value.deviceCode);
    }
  } catch (error) {
    message.value = {
      type: "error",
      text: error instanceof Error ? `操作失败：${error.message}` : "操作失败"
    };
  } finally {
    loading.value = false;
  }
};

const submitTransfer = async () => {
  if (!transferForm.value.fromCode || !transferForm.value.toCode || !transferForm.value.goodsId) {
    message.value = {
      type: "error",
      text: "操作失败：请先选择完整的调拨信息"
    };
    return;
  }

  saving.value = true;
  try {
    await adminApi.createInventoryTransfer({
      fromCode: transferForm.value.fromCode,
      toCode: transferForm.value.toCode,
      goodsId: transferForm.value.goodsId,
      quantity: transferForm.value.quantity,
      note: transferForm.value.note || undefined
    });
    message.value = {
      type: "success",
      text: "操作成功"
    };
    transferForm.value.note = "";
    await load();
  } catch (error) {
    message.value = {
      type: "error",
      text: error instanceof Error ? `操作失败：${error.message}` : "操作失败"
    };
  } finally {
    saving.value = false;
  }
};

const submitStocktake = async () => {
  if (!stocktakeForm.value.deviceCode || !stocktakeItems.value.length) {
    message.value = {
      type: "error",
      text: "操作失败：请先选择盘点柜机"
    };
    return;
  }

  saving.value = true;
  try {
    await adminApi.createStocktake({
      deviceCode: stocktakeForm.value.deviceCode,
      note: stocktakeForm.value.note || undefined,
      items: stocktakeItems.value.map((item) => ({
        goodsId: item.goodsId,
        actualQuantity: item.actualQuantity
      }))
    });
    message.value = {
      type: "success",
      text: "操作成功"
    };
    stocktakeForm.value.note = "";
    await load();
  } catch (error) {
    message.value = {
      type: "error",
      text: error instanceof Error ? `操作失败：${error.message}` : "操作失败"
    };
  } finally {
    saving.value = false;
  }
};

const exportStocktake = async (id: string) => {
  if (!sessionStore.token) {
    message.value = {
      type: "error",
      text: "操作失败：登录状态已失效"
    };
    return;
  }

  try {
    const file = await adminApi.exportStocktake(id, sessionStore.token);
    const url = window.URL.createObjectURL(file.blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = file.filename;
    anchor.click();
    window.URL.revokeObjectURL(url);
    message.value = {
      type: "success",
      text: "操作成功"
    };
  } catch (error) {
    message.value = {
      type: "error",
      text: error instanceof Error ? `操作失败：${error.message}` : "操作失败"
    };
  }
};

watch(
  () => transferForm.value.fromCode,
  () => {
    transferForm.value.goodsId = sourceGoodsOptions.value[0]?.goodsId || "";
  }
);

watch(
  () => stocktakeForm.value.deviceCode,
  async (value) => {
    await loadStocktakeDevice(value);
  }
);

onMounted(load);
</script>

<template>
  <section class="admin-page">
    <section class="admin-page__section">
      <div class="admin-page__section-head">
        <div>
          <p class="admin-kicker">本地仓库</p>
          <h3 class="admin-page__section-title">作为中转站处理调拨、盘点与库存衔接</h3>
        </div>
      </div>

      <div v-if="message" class="admin-note" :class="{ 'warehouse-note--error': message.type === 'error' }">
        {{ message.text }}
      </div>

      <div class="admin-grid admin-grid--stats-4">
        <StatTile title="仓库库存总量" :value="snapshot?.totalStock ?? 0" hint="本地仓库当前剩余件数" />
        <StatTile title="仓库货品种类" :value="snapshot?.goodsKinds ?? 0" hint="本地仓库当前覆盖种类" />
        <StatTile title="最近调拨" :value="snapshot?.transfers.length ?? 0" hint="最近 20 条调拨记录" />
        <StatTile title="最近盘点" :value="snapshot?.stocktakes.length ?? 0" hint="最近 20 条盘点记录" />
      </div>
    </section>

    <section class="admin-grid admin-grid--main-aside">
      <article class="admin-panel admin-panel-block">
        <div class="admin-panel__head">
          <div>
            <span class="admin-kicker">仓库库存</span>
            <h3 class="admin-panel__title">查看仓库当前在库量和最短保质期</h3>
          </div>
        </div>

        <table v-if="snapshot?.items.length" class="admin-table">
          <thead>
            <tr>
              <th>货品</th>
              <th>库存</th>
              <th>批次数</th>
              <th>最短保质期</th>
              <th>详情</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="item in snapshot.items" :key="item.goodsId">
              <td>
                <RouterLink class="admin-link admin-table__strong" :to="`/goods/${item.goodsId}`">
                  {{ item.goodsName }}
                </RouterLink>
                <span class="admin-table__subtext">{{ item.goodsId }}</span>
              </td>
              <td class="admin-code">{{ item.totalStock }}</td>
              <td class="admin-code">{{ item.batchCount }}</td>
              <td class="admin-code">{{ item.nearestExpiryAt ? item.nearestExpiryAt.slice(0, 16).replace("T", " ") : "-" }}</td>
              <td><RouterLink class="admin-link" :to="`/goods/${item.goodsId}`">详情</RouterLink></td>
            </tr>
          </tbody>
        </table>
        <div v-else class="admin-empty">
          <div class="admin-empty__title">{{ loading ? "正在加载仓库库存" : "当前仓库没有库存" }}</div>
          <div class="admin-empty__body">调拨到本地仓库后，这里会展示当前在库情况。</div>
        </div>
      </article>

      <aside class="admin-grid">
        <article class="admin-panel admin-panel-block">
          <div class="admin-panel__head">
            <div>
              <span class="admin-kicker">调拨</span>
              <h3 class="admin-panel__title">在柜机与本地仓库之间调拨物资</h3>
            </div>
          </div>

          <div class="warehouse-form">
            <label class="admin-field">
              <span class="admin-field__label">来源</span>
              <select v-model="transferForm.fromCode" class="admin-select">
                <option v-for="item in locationOptions" :key="item.code" :value="item.code">
                  {{ item.name }} / {{ item.code }}
                </option>
              </select>
            </label>
            <label class="admin-field">
              <span class="admin-field__label">去向</span>
              <select v-model="transferForm.toCode" class="admin-select">
                <option v-for="item in locationOptions" :key="item.code" :value="item.code">
                  {{ item.name }} / {{ item.code }}
                </option>
              </select>
            </label>
            <label class="admin-field">
              <span class="admin-field__label">货品</span>
              <select v-model="transferForm.goodsId" class="admin-select">
                <option v-for="item in sourceGoodsOptions" :key="item.goodsId" :value="item.goodsId">
                  {{ item.goodsName }} / 当前 {{ item.currentStock }}
                </option>
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
            <button class="admin-button" :disabled="saving" @click="submitTransfer">{{ saving ? "处理中" : "提交调拨" }}</button>
          </div>
        </article>

        <article class="admin-panel admin-panel-block">
          <div class="admin-panel__head">
            <div>
              <span class="admin-kicker">盘点</span>
              <h3 class="admin-panel__title">按单柜机盘点并导出 Excel</h3>
            </div>
          </div>

          <div class="warehouse-form">
            <label class="admin-field">
              <span class="admin-field__label">盘点柜机</span>
              <select v-model="stocktakeForm.deviceCode" class="admin-select">
                <option v-for="device in devices" :key="device.deviceCode" :value="device.deviceCode">
                  {{ device.name }} / {{ device.deviceCode }}
                </option>
              </select>
            </label>
            <div v-if="stocktakeItems.length" class="warehouse-stocktake-list">
              <div v-for="item in stocktakeItems" :key="item.goodsId" class="warehouse-stocktake-item">
                <div class="admin-list__main">
                  <span class="admin-list__title">{{ item.goodsName }}</span>
                  <span class="admin-list__meta">系统库存 {{ item.systemQuantity }}</span>
                </div>
                <input v-model.number="item.actualQuantity" class="admin-input" type="number" min="0" />
              </div>
            </div>
            <label class="admin-field">
              <span class="admin-field__label">备注</span>
              <input v-model="stocktakeForm.note" class="admin-input" placeholder="例如 早班盘点" />
            </label>
            <button class="admin-button" :disabled="saving || !stocktakeItems.length" @click="submitStocktake">
              {{ saving ? "处理中" : "提交盘点" }}
            </button>
          </div>
        </article>
      </aside>
    </section>

    <section class="admin-grid admin-grid--main-aside">
      <article class="admin-panel admin-panel-block">
        <div class="admin-panel__head">
          <div>
            <span class="admin-kicker">最近调拨</span>
            <h3 class="admin-panel__title">记录来源、去向和数量</h3>
          </div>
        </div>

        <table v-if="snapshot?.transfers.length" class="admin-table">
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
            <tr v-for="item in snapshot.transfers" :key="item.id">
              <td class="admin-code">{{ item.happenedAt.slice(0, 16).replace("T", " ") }}</td>
              <td>{{ item.goodsName }}</td>
              <td>{{ item.fromName }}</td>
              <td>{{ item.toName }}</td>
              <td class="admin-code">{{ item.quantity }}</td>
            </tr>
          </tbody>
        </table>
        <div v-else class="admin-empty">
          <div class="admin-empty__title">当前没有调拨记录</div>
          <div class="admin-empty__body">提交一次调拨后，这里会出现最新记录。</div>
        </div>
      </article>

      <article class="admin-panel admin-panel-block">
        <div class="admin-panel__head">
          <div>
            <span class="admin-kicker">最近盘点</span>
            <h3 class="admin-panel__title">盘点后可直接导出 Excel</h3>
          </div>
        </div>

        <table v-if="snapshot?.stocktakes.length" class="admin-table">
          <thead>
            <tr>
              <th>时间</th>
              <th>柜机</th>
              <th>条目数</th>
              <th>导出</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="item in snapshot.stocktakes" :key="item.id">
              <td class="admin-code">{{ item.createdAt.slice(0, 16).replace("T", " ") }}</td>
              <td>
                <RouterLink class="admin-link" :to="`/operations/${item.deviceCode}`">{{ item.deviceName }}</RouterLink>
              </td>
              <td class="admin-code">{{ item.items.length }}</td>
              <td>
                <button class="admin-button admin-button--ghost" @click="exportStocktake(item.id)">导出 Excel</button>
              </td>
            </tr>
          </tbody>
        </table>
        <div v-else class="admin-empty">
          <div class="admin-empty__title">当前没有盘点记录</div>
          <div class="admin-empty__body">完成一次盘点后，这里会保留最近结果。</div>
        </div>
      </article>
    </section>
  </section>
</template>

<style scoped>
.warehouse-form,
.warehouse-stocktake-list {
  display: grid;
  gap: 10px;
}

.warehouse-stocktake-item {
  display: grid;
  grid-template-columns: minmax(0, 1fr) 120px;
  gap: 10px;
  align-items: center;
}

.warehouse-note--error {
  color: #b42318;
}
</style>
