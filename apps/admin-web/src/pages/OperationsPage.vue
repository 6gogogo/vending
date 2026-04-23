<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from "vue";
import { RouterLink } from "vue-router";
import type { DeviceRecord } from "@vm/shared-types";

import { adminApi } from "../api/admin";
import { formatDateTime, formatNowInBeijing } from "../utils/datetime";

type DrawerMode = "" | "create-device" | "edit-device";

const devices = ref<DeviceRecord[]>([]);
const loading = ref(false);
const lastUpdatedAt = ref("");
const savingDevice = ref(false);
const removingDeviceCode = ref("");
const editingDeviceCode = ref("");
const drawerMode = ref<DrawerMode>("");

const deviceForm = ref<{
  deviceCode: string;
  name: string;
  location: string;
  address: string;
  status: DeviceRecord["status"];
  longitude: string;
  latitude: string;
}>({
  deviceCode: "",
  name: "",
  location: "",
  address: "",
  status: "online",
  longitude: "",
  latitude: ""
});

let timer: ReturnType<typeof setInterval> | undefined;
let visibilityHandler: (() => void) | undefined;

const isEditing = computed(() => drawerMode.value === "edit-device" && Boolean(editingDeviceCode.value));
const isDeviceMutating = computed(() => savingDevice.value || Boolean(removingDeviceCode.value));
const currentDrawerTitle = computed(() => (drawerMode.value === "create-device" ? "新增柜机" : drawerMode.value === "edit-device" ? "编辑柜机" : ""));
const sortedDevices = computed(() =>
  [...devices.value].sort((left, right) => {
    if (left.status === right.status) {
      return left.deviceCode.localeCompare(right.deviceCode);
    }

    if (left.status === "online") {
      return -1;
    }

    if (right.status === "online") {
      return 1;
    }

    return left.deviceCode.localeCompare(right.deviceCode);
  })
);

const totalStock = (device: DeviceRecord) =>
  device.doors.flatMap((door) => door.goods).reduce((sum, goods) => sum + goods.stock, 0);

const previewGoods = (device: DeviceRecord) => device.doors.flatMap((door) => door.goods).slice(0, 5);

const remainingGoodsCount = (device: DeviceRecord) =>
  Math.max(0, device.doors.flatMap((door) => door.goods).length - 5);

const formatStatus = (status: DeviceRecord["status"]) =>
  status === "online" ? "在线" : status === "maintenance" ? "维护中" : "离线";

const formatDoorState = (doorState?: "open" | "closed" | "unknown") => {
  if (doorState === "open") {
    return "门已开";
  }

  if (doorState === "closed") {
    return "门已关";
  }

  return "门状态未知";
};

const formatGoodsStock = (goods: DeviceRecord["doors"][number]["goods"][number]) => {
  const base =
    goods.thresholdEnabled && goods.lowStockThreshold !== undefined
      ? `${goods.stock}/${goods.lowStockThreshold}`
      : `${goods.stock}`;
  const tags: string[] = [];

  if (
    goods.thresholdEnabled &&
    goods.lowStockThreshold !== undefined &&
    goods.stock <= goods.lowStockThreshold
  ) {
    tags.push("缺货");
  }

  if (goods.expiringSoon) {
    tags.push("临期");
  }

  return tags.length ? `${base}（${tags.join("，")}）` : base;
};

const hasDoorWarning = (device: DeviceRecord) =>
  device.runtime?.doorState === "closed" &&
  Boolean(device.runtime.lastCommandAt) &&
  device.runtime.openedAfterLastCommand === false;

const resetDeviceForm = () => {
  editingDeviceCode.value = "";
  deviceForm.value = {
    deviceCode: "",
    name: "",
    location: "",
    address: "",
    status: "online",
    longitude: "",
    latitude: ""
  };
};

const openCreateDevice = () => {
  resetDeviceForm();
  drawerMode.value = "create-device";
};

const openEditDevice = (device: DeviceRecord) => {
  editingDeviceCode.value = device.deviceCode;
  deviceForm.value = {
    deviceCode: device.deviceCode,
    name: device.name,
    location: device.location,
    address: device.address ?? "",
    status: device.status,
    longitude: device.longitude !== undefined ? String(device.longitude) : "",
    latitude: device.latitude !== undefined ? String(device.latitude) : ""
  };
  drawerMode.value = "edit-device";
};

const closeDeviceDrawer = () => {
  drawerMode.value = "";
  resetDeviceForm();
};

const requestCloseDeviceDrawer = () => {
  if (!isDeviceMutating.value) {
    closeDeviceDrawer();
  }
};

const parseOptionalNumber = (value: string) => {
  const normalized = value.trim();

  if (!normalized) {
    return undefined;
  }

  const parsed = Number(normalized);
  return Number.isFinite(parsed) ? parsed : Number.NaN;
};

const submitDevice = async () => {
  const payload = {
    deviceCode: deviceForm.value.deviceCode.trim(),
    name: deviceForm.value.name.trim(),
    location: deviceForm.value.location.trim(),
    address: deviceForm.value.address.trim() || undefined,
    status: deviceForm.value.status,
    longitude: parseOptionalNumber(deviceForm.value.longitude),
    latitude: parseOptionalNumber(deviceForm.value.latitude)
  };

  if (!payload.deviceCode || !payload.name || !payload.location) {
    window.alert("操作失败：请填写柜机编号、柜机名称和柜机位置");
    return;
  }

  if (Number.isNaN(payload.longitude) || Number.isNaN(payload.latitude)) {
    window.alert("操作失败：经纬度必须是数字");
    return;
  }

  savingDevice.value = true;
  try {
    await adminApi.upsertDevice(payload);
    closeDeviceDrawer();
    await load();
  } catch (error) {
    window.alert(error instanceof Error ? `操作失败：${error.message}` : "操作失败");
  } finally {
    savingDevice.value = false;
  }
};

const removeDevice = async (device: DeviceRecord) => {
  if (!window.confirm(`确认从当前运行柜机列表中移除 ${device.name}（${device.deviceCode}）吗？`)) {
    return;
  }

  removingDeviceCode.value = device.deviceCode;
  try {
    await adminApi.removeDevice(device.deviceCode);
    if (editingDeviceCode.value === device.deviceCode) {
      closeDeviceDrawer();
    }
    await load();
  } catch (error) {
    window.alert(error instanceof Error ? `操作失败：${error.message}` : "操作失败");
  } finally {
    removingDeviceCode.value = "";
  }
};

const removeEditingDevice = async () => {
  const device = devices.value.find((item) => item.deviceCode === editingDeviceCode.value);

  if (!device) {
    window.alert("操作失败：未找到当前编辑的柜机");
    return;
  }

  await removeDevice(device);
};

const load = async () => {
  loading.value = true;
  try {
    devices.value = await adminApi.devices();
    lastUpdatedAt.value = formatNowInBeijing();
  } finally {
    loading.value = false;
  }
};

onMounted(async () => {
  await load();
  timer = setInterval(load, 8_000);
  if (typeof document !== "undefined") {
    visibilityHandler = () => {
      if (document.hidden) {
        if (timer) {
          clearInterval(timer);
          timer = undefined;
        }
        return;
      }

      void load();
      if (timer) {
        clearInterval(timer);
      }
      timer = setInterval(load, 8_000);
    };
    document.addEventListener("visibilitychange", visibilityHandler);
  }
});

onUnmounted(() => {
  if (timer) {
    clearInterval(timer);
  }
  if (visibilityHandler) {
    document.removeEventListener("visibilitychange", visibilityHandler);
  }
});
</script>

<template>
  <section class="admin-page">
    <section class="admin-page__section">
      <div class="admin-page__section-head">
        <div>
          <p class="admin-kicker">柜机面板</p>
          <h3 class="admin-page__section-title">每列一个柜机，集中查看状态、门状态和货品数量</h3>
        </div>
        <div class="admin-toolbar">
          <span class="admin-copy">当前柜机数：{{ sortedDevices.length }}</span>
          <span class="admin-copy">自动刷新 8 秒一次</span>
          <span class="admin-copy">最近刷新：{{ lastUpdatedAt || "尚未加载" }}</span>
          <button class="admin-button" @click="openCreateDevice">新增柜机</button>
          <button class="admin-button admin-button--ghost" :disabled="loading" @click="load">
            {{ loading ? "刷新中" : "立即刷新" }}
          </button>
        </div>
      </div>
    </section>

    <section v-if="sortedDevices.length" class="operations-grid">
      <article v-for="device in sortedDevices" :key="device.deviceCode" class="admin-panel admin-panel-block operations-card">
        <div class="operations-card__head">
          <div>
            <h3 class="operations-card__title">{{ device.name }}</h3>
            <p class="admin-copy admin-code">{{ device.deviceCode }} · {{ device.location }}</p>
          </div>
          <div class="admin-inline-links">
            <span
              class="admin-pill"
              :class="device.status === 'online' ? 'admin-pill--success' : device.status === 'maintenance' ? 'admin-pill--warning' : 'admin-pill--danger'"
            >
              {{ formatStatus(device.status) }}
            </span>
            <span class="admin-pill" :class="device.runtime?.doorState === 'open' ? 'admin-pill--warning' : 'admin-pill--neutral'">
              {{ formatDoorState(device.runtime?.doorState) }}
            </span>
          </div>
        </div>

        <div class="operations-card__rows">
          <div class="operations-card__row">
            <span>总库存</span>
            <strong class="admin-code">{{ totalStock(device) }}</strong>
          </div>
          <div class="operations-card__row">
            <span>最近在线</span>
            <span class="admin-code">{{ formatDateTime(device.lastSeenAt) }}</span>
          </div>
          <div class="operations-card__row">
            <span>最近开门</span>
            <span class="admin-code">{{ formatDateTime(device.runtime?.lastOpenedAt) }}</span>
          </div>
          <div class="operations-card__row">
            <span>最近关门</span>
            <span class="admin-code">{{ formatDateTime(device.runtime?.lastClosedAt) }}</span>
          </div>
        </div>

        <div v-if="hasDoorWarning(device)" class="admin-note operations-card__warning">
          该柜机最近一次开门后未收到“门已打开”确认。
        </div>

        <table class="admin-table operations-card__table">
          <thead>
            <tr>
              <th>货品</th>
              <th>数量</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="goods in previewGoods(device)" :key="goods.goodsId">
              <td>
                <span class="admin-table__strong">{{ goods.name }}</span>
                <span class="admin-table__subtext">{{ goods.goodsId }}</span>
              </td>
              <td class="admin-code">{{ formatGoodsStock(goods) }}</td>
            </tr>
            <tr v-if="remainingGoodsCount(device)">
              <td colspan="2" class="admin-code">其余 {{ remainingGoodsCount(device) }} 个货品请进入详情页查看</td>
            </tr>
          </tbody>
        </table>

        <div class="operations-card__actions">
          <button class="admin-button admin-button--ghost" :disabled="removingDeviceCode === device.deviceCode" @click="openEditDevice(device)">
            编辑柜机
          </button>
          <RouterLink class="admin-link" :to="`/operations/${device.deviceCode}`">详情</RouterLink>
          <RouterLink class="admin-link" :to="`/logs?subjectType=device&subjectId=${device.deviceCode}`">日志</RouterLink>
        </div>
      </article>
    </section>

    <div v-else class="admin-empty">
      <div class="admin-empty__title">{{ loading ? "正在加载柜机列表" : "当前没有柜机数据" }}</div>
      <div class="admin-empty__body">点击右上角“新增柜机”创建柜机，创建后会进入监控矩阵。</div>
    </div>

    <div v-if="drawerMode" class="operations-drawer-backdrop" @click.self="requestCloseDeviceDrawer">
      <aside class="operations-drawer admin-panel">
        <div class="admin-panel__head">
          <div>
            <span class="admin-kicker">柜机管理</span>
            <h3 class="admin-panel__title">{{ currentDrawerTitle }}</h3>
          </div>
          <button class="admin-button admin-button--ghost" :disabled="isDeviceMutating" @click="requestCloseDeviceDrawer">关闭</button>
        </div>

        <div class="operations-drawer__body">
          <div class="operations-manager__grid">
            <label class="admin-field">
              <span class="admin-field__label">柜机编号</span>
              <input v-model="deviceForm.deviceCode" class="admin-input admin-code" :disabled="isEditing || savingDevice" placeholder="例如 CAB-1003" />
            </label>
            <label class="admin-field">
              <span class="admin-field__label">柜机名称</span>
              <input v-model="deviceForm.name" class="admin-input" :disabled="savingDevice" placeholder="例如 东门便民柜机" />
            </label>
            <label class="admin-field">
              <span class="admin-field__label">柜机位置</span>
              <input v-model="deviceForm.location" class="admin-input" :disabled="savingDevice" placeholder="例如 社区服务中心东门" />
            </label>
            <label class="admin-field">
              <span class="admin-field__label">详细地址</span>
              <input v-model="deviceForm.address" class="admin-input" :disabled="savingDevice" placeholder="可选，默认跟柜机位置一致" />
            </label>
            <label class="admin-field">
              <span class="admin-field__label">状态</span>
              <select v-model="deviceForm.status" class="admin-select" :disabled="savingDevice">
                <option value="online">在线</option>
                <option value="maintenance">维护中</option>
                <option value="offline">离线</option>
              </select>
            </label>
            <label class="admin-field">
              <span class="admin-field__label">经度</span>
              <input v-model="deviceForm.longitude" class="admin-input admin-code" :disabled="savingDevice" placeholder="可选" />
            </label>
            <label class="admin-field">
              <span class="admin-field__label">纬度</span>
              <input v-model="deviceForm.latitude" class="admin-input admin-code" :disabled="savingDevice" placeholder="可选" />
            </label>
          </div>

          <div class="operations-manager__actions">
            <button class="admin-button" :disabled="savingDevice" @click="submitDevice">
              {{ savingDevice ? "提交中" : isEditing ? "保存修改" : "新增柜机" }}
            </button>
            <RouterLink v-if="isEditing" class="admin-link" :to="`/operations/${editingDeviceCode}`">进入当前柜机详情</RouterLink>
          </div>

          <div v-if="isEditing" class="operations-danger-zone">
            <div>
              <strong>删除柜机</strong>
              <p>删除柜机会同时清理当前库存批次、阈值设置和未完成预警；历史日志与历史事件保留，便于后续追溯。</p>
            </div>
            <button class="admin-button admin-button--danger" :disabled="savingDevice || removingDeviceCode === editingDeviceCode" @click="removeEditingDevice">
              {{ removingDeviceCode === editingDeviceCode ? "移除中" : "删除当前柜机" }}
            </button>
          </div>
        </div>
      </aside>
    </div>
  </section>
</template>

<style scoped>
.operations-manager {
  display: grid;
  gap: 12px;
}

.operations-manager__grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
  gap: 10px;
}

.operations-manager__actions {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
}

.operations-drawer-backdrop {
  position: fixed;
  inset: 0;
  z-index: 40;
  display: flex;
  justify-content: flex-end;
  background: rgba(15, 23, 42, 0.28);
}

.operations-drawer {
  width: min(560px, 100%);
  height: 100%;
  border-radius: 0;
  border-top: 0;
  border-right: 0;
  border-bottom: 0;
  overflow: auto;
}

.operations-drawer__body {
  display: grid;
  gap: 14px;
}

.operations-danger-zone {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  align-items: center;
  gap: 12px;
  padding: 14px;
  border: 1px solid #efc0ba;
  border-radius: 12px;
  background: #fff4f2;
  color: #8c2f29;
}

.operations-danger-zone p {
  margin: 4px 0 0;
  color: #9a514b;
  line-height: 1.6;
}

.operations-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(250px, 1fr));
  gap: 8px;
}

.operations-card {
  display: grid;
  gap: 10px;
}

.operations-card__head,
.operations-card__row,
.operations-card__actions {
  display: flex;
  justify-content: space-between;
  gap: 10px;
  flex-wrap: wrap;
}

.operations-card__head {
  align-items: flex-start;
}

.operations-card__title {
  margin: 0 0 4px;
  font-size: 1rem;
}

.operations-card__rows {
  display: grid;
  gap: 0;
  border: 1px solid var(--admin-line);
  border-radius: 8px;
  overflow: hidden;
}

.operations-card__row {
  padding: 8px 10px;
  border-bottom: 1px solid var(--admin-line);
  background: var(--admin-panel-muted);
  color: var(--admin-muted);
}

.operations-card__row:last-child {
  border-bottom: 0;
}

.operations-card__table :deep(td:last-child),
.operations-card__table :deep(th:last-child) {
  width: 72px;
}

.operations-card__actions {
  align-items: center;
  justify-content: flex-start;
}

.operations-card__warning {
  background: #fff7e8;
  border-color: #efcf8d;
  color: #8e6414;
}

@media (max-width: 760px) {
  .operations-drawer-backdrop {
    padding: 0;
  }

  .operations-danger-zone {
    grid-template-columns: 1fr;
  }
}
</style>
