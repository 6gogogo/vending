<script setup lang="ts">
import { computed, onMounted, ref, watch } from "vue";
import { RouterLink, useRoute } from "vue-router";
import type { DeviceRecord, UserManagementDetail } from "@vm/shared-types";

import { adminApi } from "../api/admin";
import StatTile from "../components/StatTile.vue";
import { resolveActorLink } from "../utils/entity-links";

const route = useRoute();
const detail = ref<UserManagementDetail>();
const devices = ref<DeviceRecord[]>([]);
const loading = ref(false);
const saving = ref(false);

const form = ref({
  deviceCode: "",
  goodsId: "",
  quantity: 1,
  direction: "deduct" as "restock" | "deduct",
  note: ""
});

const selectedDeviceGoods = computed(() => {
  const device = devices.value.find((entry) => entry.deviceCode === form.value.deviceCode);
  return device?.doors.flatMap((door) => door.goods) ?? [];
});

const selectedGoods = computed(() =>
  selectedDeviceGoods.value.find((entry) => entry.goodsId === form.value.goodsId)
);

const resolveLogActorRoute = (actor: UserManagementDetail["recentLogs"][number]["actor"]) =>
  resolveActorLink(actor);

const formatRole = (role: UserManagementDetail["user"]["role"]) =>
  role === "special" ? "特殊群体" : role === "merchant" ? "商户" : "管理员";

const formatLogStatus = (status: UserManagementDetail["recentLogs"][number]["status"]) =>
  status === "success" ? "成功" : status === "warning" ? "预警" : status === "failed" ? "失败" : "待处理";

const formatRecordType = (type: UserManagementDetail["recentRecords"][number]["type"]) =>
  type === "pickup"
    ? "取货"
    : type === "donation" || type === "manual-restock"
      ? "补货"
      : type === "adjustment" || type === "manual-deduction"
        ? "补扣"
        : type === "refund"
          ? "退款"
          : type;

const load = async () => {
  loading.value = true;
  try {
    const [detailResponse, devicesResponse] = await Promise.all([
      adminApi.userDetail(String(route.params.userId)),
      adminApi.devices()
    ]);

    detail.value = detailResponse;
    devices.value = devicesResponse;
    if (!form.value.deviceCode) {
      form.value.deviceCode = devicesResponse[0]?.deviceCode ?? "";
    }
    if (!form.value.goodsId) {
      form.value.goodsId =
        devicesResponse[0]?.doors.flatMap((door) => door.goods)[0]?.goodsId ?? "";
    }
  } finally {
    loading.value = false;
  }
};

const submitAdjustment = async () => {
  if (!detail.value || !selectedGoods.value) {
    return;
  }

  saving.value = true;
  try {
    await adminApi.manualAdjustUser(detail.value.user.id, {
      deviceCode: form.value.deviceCode,
      goodsId: selectedGoods.value.goodsId,
      goodsName: selectedGoods.value.name,
      category: selectedGoods.value.category,
      quantity: form.value.quantity,
      direction: form.value.direction,
      note: form.value.note
    });
    form.value.quantity = 1;
    form.value.note = "";
    await load();
  } finally {
    saving.value = false;
  }
};

watch(selectedDeviceGoods, (goodsList) => {
  if (!goodsList.some((entry) => entry.goodsId === form.value.goodsId)) {
    form.value.goodsId = goodsList[0]?.goodsId ?? "";
  }
});

onMounted(load);
</script>

<template>
  <section class="admin-page">
    <section class="admin-page__section">
      <div class="admin-page__section-head">
        <div>
          <p class="admin-kicker">人员详情</p>
          <h3 class="admin-page__section-title">{{ detail?.user.name ?? "加载中" }}</h3>
        </div>
      </div>
    </section>

    <section v-if="detail" class="admin-grid admin-grid--main-aside">
      <div class="admin-grid">
        <article class="admin-panel admin-panel-block">
          <div class="admin-panel__head">
            <div>
              <span class="admin-kicker">基本信息</span>
              <h3 class="admin-panel__title">人员信息与当前状态</h3>
            </div>
          </div>
          <div class="admin-kv">
            <div class="admin-kv__row">
              <span class="admin-kv__label">姓名</span>
              <span class="admin-kv__value">{{ detail.user.name }}</span>
            </div>
            <div class="admin-kv__row">
              <span class="admin-kv__label">手机号</span>
              <span class="admin-kv__value admin-code">{{ detail.user.phone }}</span>
            </div>
            <div class="admin-kv__row">
              <span class="admin-kv__label">角色</span>
              <span class="admin-kv__value">{{ formatRole(detail.user.role) }}</span>
            </div>
            <div class="admin-kv__row">
              <span class="admin-kv__label">片区</span>
              <span class="admin-kv__value">{{ detail.user.neighborhood ?? "未设置片区" }}</span>
            </div>
            <div class="admin-kv__row">
              <span class="admin-kv__label">状态</span>
              <span class="admin-kv__value">
                <span class="admin-pill" :class="detail.user.status === 'active' ? 'admin-pill--success' : 'admin-pill--warning'">
                  {{ detail.user.status === "active" ? "可继续操作" : "已暂停" }}
                </span>
              </span>
            </div>
            <div class="admin-kv__row">
              <span class="admin-kv__label">标签</span>
              <span class="admin-kv__value">{{ detail.user.tags.join("、") || "暂无标签" }}</span>
            </div>
          </div>
        </article>

        <article v-if="detail.user.role === 'special' && detail.stats" class="admin-panel admin-panel-block">
          <div class="admin-panel__head">
            <div>
              <span class="admin-kicker">统计情况</span>
              <h3 class="admin-panel__title">取货、补货与补扣</h3>
            </div>
          </div>
          <div class="admin-grid admin-grid--stats-3">
            <StatTile title="取货件数" :value="detail.stats.pickupCount" hint="该人员累计取货数量" tone="accent" />
            <StatTile title="补货件数" :value="detail.stats.donationCount" hint="该人员累计补货数量" />
            <StatTile title="补扣件数" :value="detail.stats.adjustmentCount" hint="该人员累计人工补扣数量" tone="warning" />
          </div>
          <div class="admin-note">最近活跃时间：{{ detail.stats.lastActiveAt ? detail.stats.lastActiveAt.slice(0, 16).replace("T", " ") : "暂无" }}</div>
        </article>

        <article v-if="detail.user.role === 'special' && detail.businessDaySummary" class="admin-panel admin-panel-block">
          <div class="admin-panel__head">
            <div>
              <span class="admin-kicker">今日时段配额</span>
              <h3 class="admin-panel__title">业务日 {{ detail.businessDaySummary.businessDateKey }}</h3>
            </div>
            <span class="admin-pill" :class="detail.businessDaySummary.completionStatus === 'complete' ? 'admin-pill--success' : detail.businessDaySummary.completionStatus === 'partial' ? 'admin-pill--warning' : 'admin-pill--neutral'">
              {{ detail.businessDaySummary.completionStatus === "complete" ? "完全服务" : detail.businessDaySummary.completionStatus === "partial" ? "部分服务" : detail.businessDaySummary.completionStatus === "unserved" ? "未服务" : "未配置" }}
            </span>
          </div>

          <table class="admin-table">
            <thead>
              <tr>
                <th>时段</th>
                <th>策略</th>
                <th>领取情况</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="window in detail.businessDaySummary.windows" :key="`${window.policyId}-${window.startHour}`">
                <td class="admin-code">{{ String(window.startHour).padStart(2, "0") }}:00-{{ String(window.endHour).padStart(2, "0") }}:00</td>
                <td>{{ window.policyName }}</td>
                <td>
                  <div class="user-detail__usage-list">
                    <span v-for="goods in window.goodsUsage" :key="goods.goodsId">
                      {{ goods.goodsName }} {{ goods.usedQuantity }}/{{ goods.quantityLimit }}
                    </span>
                  </div>
                </td>
              </tr>
            </tbody>
          </table>
        </article>

        <article v-if="detail.user.role === 'merchant'" class="admin-panel admin-panel-block">
          <div class="admin-panel__head">
            <div>
              <span class="admin-kicker">待办任务</span>
              <h3 class="admin-panel__title">该商户关联任务</h3>
            </div>
          </div>

          <table v-if="detail.relatedTasks?.length" class="admin-table">
            <thead>
              <tr>
                <th>到期时间</th>
                <th>任务</th>
                <th>柜机</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="task in detail.relatedTasks" :key="task.id">
                <td class="admin-code">{{ task.dueAt.slice(0, 16).replace("T", " ") }}</td>
                <td>
                  <span class="admin-table__strong">{{ task.title }}</span>
                  <span class="admin-table__subtext">{{ task.detail }}</span>
                </td>
                <td>
                  <RouterLink v-if="task.deviceCode" class="admin-link" :to="`/operations/${task.deviceCode}`">
                    {{ task.deviceCode }}
                  </RouterLink>
                  <span v-else>-</span>
                </td>
              </tr>
            </tbody>
          </table>
          <div v-else class="admin-empty">
            <div class="admin-empty__title">当前没有关联任务</div>
            <div class="admin-empty__body">临期、缺货和设备问题会在这里显示。</div>
          </div>
        </article>

        <article class="admin-panel admin-panel-block">
          <div class="admin-panel__head">
            <div>
              <span class="admin-kicker">日志记录</span>
              <h3 class="admin-panel__title">该人员相关日志</h3>
            </div>
          </div>
          <table v-if="detail.recentLogs.length" class="admin-table">
            <thead>
              <tr>
                <th>时间</th>
                <th>动作</th>
                <th>动作人</th>
                <th>状态</th>
                <th>详情</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="log in detail.recentLogs" :key="log.id">
                <td class="admin-code">{{ log.occurredAt.slice(0, 16).replace("T", " ") }}</td>
                <td>
                  <span class="admin-table__strong">{{ log.description }}</span>
                  <span class="admin-table__subtext">{{ log.detail }}</span>
                </td>
                <td>
                  <RouterLink v-if="resolveLogActorRoute(log.actor)" class="admin-link" :to="resolveLogActorRoute(log.actor)!">
                    {{ log.actor.name }}
                  </RouterLink>
                  <span v-else>{{ log.actor.name }}</span>
                  <span class="admin-table__subtext">{{ log.actor.type }}</span>
                </td>
                <td>
                  <span class="admin-pill" :class="log.status === 'warning' ? 'admin-pill--warning' : log.status === 'failed' ? 'admin-pill--danger' : log.status === 'success' ? 'admin-pill--success' : 'admin-pill--neutral'">
                    {{ formatLogStatus(log.status) }}
                  </span>
                </td>
                <td>
                  <RouterLink class="admin-link" :to="`/logs/${log.id}`">详情</RouterLink>
                </td>
              </tr>
            </tbody>
          </table>
          <div v-else class="admin-empty">
            <div class="admin-empty__title">还没有相关日志</div>
            <div class="admin-empty__body">当该人员发生取货、补货、补扣或状态调整时，这里会自动记录。</div>
          </div>
        </article>

        <article v-if="detail.user.role !== 'admin'" class="admin-panel admin-panel-block">
          <div class="admin-panel__head">
            <div>
              <span class="admin-kicker">记录明细</span>
              <h3 class="admin-panel__title">{{ detail.user.role === "merchant" ? "最近投放记录" : "最近取货 / 补货记录" }}</h3>
            </div>
          </div>
          <table class="admin-table">
            <thead>
              <tr>
                <th>时间</th>
                <th>货品</th>
                <th>数量</th>
                <th>柜机</th>
                <th>类型</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="record in detail.recentRecords" :key="record.id">
                <td class="admin-code">{{ record.happenedAt.slice(0, 16).replace("T", " ") }}</td>
                <td>
                  <span class="admin-table__strong">{{ record.goodsName }}</span>
                  <span class="admin-table__subtext">{{ record.goodsId }}</span>
                </td>
                <td class="admin-code">{{ record.quantity }}</td>
                <td>
                  <RouterLink class="admin-link" :to="`/operations/${record.deviceCode}`">{{ record.deviceCode }}</RouterLink>
                </td>
                <td>{{ formatRecordType(record.type) }}</td>
              </tr>
            </tbody>
          </table>
        </article>
      </div>

      <aside class="admin-grid">
        <article v-if="detail.user.role === 'special'" class="admin-panel admin-panel-block">
          <div class="admin-panel__head">
            <div>
              <span class="admin-kicker">手工补扣</span>
              <h3 class="admin-panel__title">从货物库中选择商品</h3>
            </div>
          </div>
          <div class="user-detail-form">
            <label class="admin-field">
              <span class="admin-field__label">柜机</span>
              <select v-model="form.deviceCode" class="admin-select">
                <option v-for="device in devices" :key="device.deviceCode" :value="device.deviceCode">
                  {{ device.name }} / {{ device.deviceCode }}
                </option>
              </select>
            </label>
            <label class="admin-field">
              <span class="admin-field__label">货品</span>
              <select v-model="form.goodsId" class="admin-select">
                <option v-for="goods in selectedDeviceGoods" :key="goods.goodsId" :value="goods.goodsId">
                  {{ goods.name }} / {{ goods.goodsId }}
                </option>
              </select>
            </label>
            <label class="admin-field">
              <span class="admin-field__label">数量</span>
              <input v-model.number="form.quantity" class="admin-input" type="number" min="1" />
            </label>
            <label class="admin-field">
              <span class="admin-field__label">方向</span>
              <select v-model="form.direction" class="admin-select">
                <option value="deduct">补扣</option>
                <option value="restock">补货</option>
              </select>
            </label>
            <label class="admin-field">
              <span class="admin-field__label">备注</span>
              <input v-model="form.note" class="admin-input" placeholder="例如用户领取异常后人工补扣" />
            </label>
            <button class="admin-button" :disabled="saving || !selectedGoods" @click="submitAdjustment">
              {{ saving ? "提交中" : form.direction === "restock" ? "提交手工补货" : "提交手工补扣" }}
            </button>
          </div>
        </article>

        <article class="admin-panel admin-panel-block">
          <div class="admin-panel__head">
            <div>
              <span class="admin-kicker">关联事件</span>
              <h3 class="admin-panel__title">最近开柜事件</h3>
            </div>
          </div>
          <div v-if="detail.recentEvents.length" class="admin-list">
            <div v-for="event in detail.recentEvents" :key="event.eventId" class="admin-list__row">
              <div class="admin-list__main">
                <span class="admin-list__title">{{ event.orderNo }}</span>
                <span class="admin-list__meta">{{ event.updatedAt.slice(0, 16).replace("T", " ") }} · {{ event.deviceCode }} · {{ event.status }}</span>
              </div>
              <RouterLink class="admin-link" :to="`/logs?subjectType=event&subjectId=${event.eventId}`">查看日志</RouterLink>
            </div>
          </div>
          <div v-else class="admin-empty">
            <div class="admin-empty__title">{{ loading ? "正在加载事件记录" : "还没有开柜事件" }}</div>
            <div class="admin-empty__body">后续产生的开柜链路会同步显示在这里。</div>
          </div>
        </article>
      </aside>
    </section>
  </section>
</template>

<style scoped>
.user-detail-form {
  display: grid;
  gap: 10px;
}

.user-detail__usage-list {
  display: grid;
  gap: 4px;
}
</style>
