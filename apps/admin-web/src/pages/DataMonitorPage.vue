<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from "vue";
import { RouterLink } from "vue-router";
import type {
  DataMonitorMetricKey,
  DataMonitorRange,
  DataMonitorSnapshot
} from "@vm/shared-types";

import { adminApi } from "../api/admin";
import StatTile from "../components/StatTile.vue";
import { formatDateTime, getTodayDateKeyInBeijing } from "../utils/datetime";

const metricOptions: Array<{
  key: DataMonitorMetricKey;
  label: string;
  unit: string;
}> = [
  { key: "servedUsers", label: "服务人数", unit: "人" },
  { key: "pickupUnits", label: "领取件数", unit: "件" },
  { key: "restockUnits", label: "补货件数", unit: "件" },
  { key: "transferUnits", label: "调拨件数", unit: "件" },
  { key: "eventCount", label: "开柜事件", unit: "次" },
  { key: "feedbackResolvedCount", label: "完成反馈数", unit: "项" },
  { key: "logCount", label: "日志数量", unit: "条" }
];

const rangeOptions: Array<{ value: DataMonitorRange; label: string }> = [
  { value: "today", label: "今天" },
  { value: "3d", label: "近三天" },
  { value: "7d", label: "一周内" }
];

const todayDateKey = getTodayDateKeyInBeijing();
const snapshot = ref<DataMonitorSnapshot>();
const loading = ref(false);
const calendarMonth = ref(todayDateKey.slice(0, 7));
const selectedDateKey = ref(todayDateKey);
const selectedMetric = ref<DataMonitorMetricKey>("servedUsers");
const selectedRange = ref<DataMonitorRange>("today");

let timer: ReturnType<typeof setInterval> | undefined;
let visibilityHandler: (() => void) | undefined;

const currentMonthTitle = computed(() => {
  const source = snapshot.value?.monthKey ?? calendarMonth.value;
  const [year, month] = source.split("-");
  return `${year}年 ${month}月`;
});

const selectedDateSummary = computed(() => snapshot.value?.selectedDateSummary);
const periodSummary = computed(() => snapshot.value?.periodSummary ?? snapshot.value?.selectedDateSummary);
const metricBars = computed(() => selectedDateSummary.value?.metricBars ?? []);
const rangeSeries = computed(() => snapshot.value?.rangeSeries ?? []);
const regionBreakdown = computed(() => snapshot.value?.regionBreakdown ?? []);
const rangeSummary = computed(() => snapshot.value?.rangeSummary);

const selectedMetricMeta = computed(
  () => metricOptions.find((item) => item.key === selectedMetric.value) ?? metricOptions[0]
);

const getMetricValue = (
  point:
    | NonNullable<DataMonitorSnapshot["rangeSeries"]>[number]
    | NonNullable<DataMonitorSnapshot["rangeSummary"]>,
  metric: DataMonitorMetricKey
) => point[metric];

const chartBars = computed(() =>
  selectedRange.value === "today"
    ? metricBars.value.map((item) => ({
        key: item.key,
        label: item.label,
        value: item.value,
        unit: item.unit
      }))
    : rangeSeries.value.map((item) => ({
        key: item.dateKey,
        label: item.label,
        value: getMetricValue(item, selectedMetric.value),
        unit: selectedMetricMeta.value.unit
      }))
);

const maxChartValue = computed(() => Math.max(1, ...chartBars.value.map((item) => item.value)));
const maxRegionValue = computed(() => Math.max(1, ...regionBreakdown.value.map((item) => item.pickupUnits)));

const formatRangeTitle = computed(() => {
  if (!snapshot.value) {
    return selectedRange.value === "today" ? "按选中日期汇总关键指标" : "按日期查看指标分布";
  }

  if (selectedRange.value === "today") {
    return `业务日 ${snapshot.value.selectedDateKey} 指标汇总`;
  }

  return `${selectedMetricMeta.value.label}在 ${snapshot.value.rangeStartDateKey} 至 ${snapshot.value.rangeEndDateKey} 的分布`;
});

const load = async () => {
  loading.value = true;
  try {
    const response = await adminApi.dataMonitor({
      month: calendarMonth.value,
      date: selectedDateKey.value,
      range: selectedRange.value
    });
    snapshot.value = response;
    calendarMonth.value = response.monthKey;
    selectedDateKey.value = response.selectedDateKey;
    selectedRange.value = response.range;
  } finally {
    loading.value = false;
  }
};

const startPolling = () => {
  if (timer) {
    clearInterval(timer);
  }

  if (typeof document !== "undefined" && document.hidden) {
    return;
  }

  timer = setInterval(() => {
    void load();
  }, 15_000);
};

const stopPolling = () => {
  if (timer) {
    clearInterval(timer);
    timer = undefined;
  }
};

const changeMonth = async (offset: number) => {
  const [year, month] = calendarMonth.value.split("-").map(Number);
  const next = new Date(year, month - 1 + offset, 1);
  const nextMonth = `${next.getFullYear()}-${String(next.getMonth() + 1).padStart(2, "0")}`;
  calendarMonth.value = nextMonth;
  selectedDateKey.value = `${nextMonth}-01`;
  await load();
};

const selectDate = async (dateKey: string) => {
  selectedDateKey.value = dateKey;
  if (!dateKey.startsWith(calendarMonth.value)) {
    calendarMonth.value = dateKey.slice(0, 7);
  }
  await load();
};

const selectRange = async (nextRange: DataMonitorRange) => {
  selectedRange.value = nextRange;
  await load();
};

const buildLogQuery = (category?: string) => ({
  path: "/logs",
  query: {
    category,
    dateFrom: snapshot.value?.rangeStartDateKey,
    dateTo: snapshot.value?.rangeEndDateKey
  }
});

onMounted(async () => {
  await load();
  startPolling();
  visibilityHandler = () => {
    if (document.hidden) {
      stopPolling();
      return;
    }

    void load();
    startPolling();
  };
  document.addEventListener("visibilitychange", visibilityHandler);
});

onUnmounted(() => {
  stopPolling();
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
          <p class="admin-kicker">数据监控</p>
          <h3 class="admin-page__section-title">按业务日、时间段与区域查看服务走势</h3>
        </div>
        <div class="admin-toolbar">
          <span class="admin-copy">自动刷新 15 秒一次</span>
          <button class="admin-button admin-button--ghost" :disabled="loading" @click="load">
            {{ loading ? "刷新中" : "刷新数据" }}
          </button>
        </div>
      </div>
    </section>

    <section v-if="rangeSummary" class="admin-grid admin-grid--stats-4">
      <RouterLink class="data-monitor-stat-link" :to="buildLogQuery('pickup')">
        <StatTile
          title="服务人数"
          :value="`${rangeSummary.servedUsers} 人`"
          hint="所选时间段内至少发生过一次领取或补扣的人员"
          action-label="查看明细 >"
          tone="accent"
        />
      </RouterLink>
      <RouterLink class="data-monitor-stat-link" :to="buildLogQuery('pickup')">
        <StatTile
          title="领取件数"
          :value="`${rangeSummary.pickupUnits} 件`"
          hint="包含领取、补扣和人工补扣"
          action-label="查看明细 >"
          tone="success"
        />
      </RouterLink>
      <RouterLink class="data-monitor-stat-link" :to="buildLogQuery('restock')">
        <StatTile
          title="补货件数"
          :value="`${rangeSummary.restockUnits} 件`"
          hint="仅统计补货，不再混入调拨"
          action-label="查看明细 >"
        />
      </RouterLink>
      <RouterLink class="data-monitor-stat-link" :to="buildLogQuery('inventory')">
        <StatTile
          title="调拨件数"
          :value="`${rangeSummary.transferUnits} 件`"
          hint="仓库与柜机之间的调拨流转"
          action-label="查看明细 >"
          tone="warning"
        />
      </RouterLink>
    </section>

    <section v-if="rangeSummary" class="admin-grid admin-grid--stats-3">
      <RouterLink class="data-monitor-stat-link" :to="buildLogQuery('device')">
        <StatTile
          title="开柜事件"
          :value="`${rangeSummary.eventCount} 次`"
          hint="该时间段内记录到的全部开门事件"
          action-label="查看明细 >"
        />
      </RouterLink>
      <RouterLink class="data-monitor-stat-link" :to="buildLogQuery('alert')">
        <StatTile
          title="完成反馈数"
          :value="`${rangeSummary.feedbackResolvedCount} 项`"
          hint="仅统计已完成的反馈事项"
          action-label="查看明细 >"
          tone="warning"
        />
      </RouterLink>
      <RouterLink class="data-monitor-stat-link" :to="buildLogQuery()">
        <StatTile
          title="日志数量"
          :value="`${rangeSummary.logCount} 条`"
          hint="操作日志与盘点记录汇总"
          action-label="查看明细 >"
        />
      </RouterLink>
    </section>

    <section class="admin-grid admin-grid--main-aside">
      <article class="admin-panel admin-panel-block">
        <div class="admin-panel__head">
          <div>
            <span class="admin-kicker">日期选择</span>
            <h3 class="admin-panel__title">选择业务日并切换观察区间</h3>
          </div>
          <div class="admin-toolbar">
            <button class="admin-button admin-button--ghost" @click="changeMonth(-1)">上月</button>
            <span class="admin-code">{{ currentMonthTitle }}</span>
            <button class="admin-button admin-button--ghost" @click="changeMonth(1)">下月</button>
          </div>
        </div>

        <div class="data-monitor-range-switch">
          <button
            v-for="item in rangeOptions"
            :key="item.value"
            class="admin-button admin-button--ghost"
            :class="selectedRange === item.value ? 'data-monitor-range-switch__active' : ''"
            @click="selectRange(item.value)"
          >
            {{ item.label }}
          </button>
        </div>

        <div class="data-monitor-calendar">
          <div
            v-for="weekday in ['周一', '周二', '周三', '周四', '周五', '周六', '周日']"
            :key="weekday"
            class="data-monitor-calendar__weekday"
          >
            {{ weekday }}
          </div>
          <button
            v-for="day in snapshot?.days ?? []"
            :key="day.dateKey"
            class="data-monitor-calendar__day"
            :class="[
              day.inCurrentMonth ? '' : 'data-monitor-calendar__day--muted',
              day.dateKey === snapshot?.selectedDateKey ? 'data-monitor-calendar__day--selected' : '',
              day.activityLevel === 'light' ? 'data-monitor-calendar__day--light' : '',
              day.activityLevel === 'medium' ? 'data-monitor-calendar__day--medium' : '',
              day.activityLevel === 'high' ? 'data-monitor-calendar__day--high' : ''
            ]"
            @click="selectDate(day.dateKey)"
          >
            <span>{{ day.day }}</span>
            <span
              v-if="day.hasData"
              class="data-monitor-calendar__marker"
              :class="`data-monitor-calendar__marker--${day.activityLevel}`"
            />
          </button>
        </div>

        <div v-if="selectedDateSummary" class="admin-note">
          已选业务日 {{ selectedDateSummary.businessDateKey }}：
          服务 {{ selectedDateSummary.servedUsers }} 人，
          领取 {{ selectedDateSummary.pickupUnits }} 件，
          补货 {{ selectedDateSummary.restockUnits }} 件，
          调拨 {{ selectedDateSummary.transferUnits }} 件，
          完成反馈 {{ selectedDateSummary.feedbackResolvedCount }} 项。
        </div>
      </article>

      <aside class="admin-grid">
        <article class="admin-panel admin-panel-block">
          <div class="admin-panel__head">
            <div>
              <span class="admin-kicker">指标切换</span>
              <h3 class="admin-panel__title">{{ formatRangeTitle }}</h3>
            </div>
          </div>

          <div class="data-monitor-metric-switch">
            <button
              v-for="item in metricOptions"
              :key="item.key"
              class="admin-button admin-button--ghost"
              :class="selectedMetric === item.key ? 'data-monitor-metric-switch__active' : ''"
              @click="selectedMetric = item.key"
            >
              {{ item.label }}
            </button>
          </div>

          <div v-if="chartBars.length" class="data-monitor-series-chart">
            <div v-for="item in chartBars" :key="item.key" class="data-monitor-series-chart__item">
              <span class="data-monitor-series-chart__value">{{ item.value }}{{ item.unit }}</span>
              <div class="data-monitor-series-chart__shell">
                <div
                  class="data-monitor-series-chart__fill"
                  :style="{ height: `${Math.max(10, (item.value / maxChartValue) * 100)}%` }"
                />
              </div>
              <span class="data-monitor-series-chart__label">{{ item.label }}</span>
            </div>
          </div>
          <div v-else class="admin-empty">
            <div class="admin-empty__title">当前区间没有可视化数据</div>
            <div class="admin-empty__body">选择一个有业务动作的日期或切换时间范围后，这里会显示指标分布。</div>
          </div>
        </article>
      </aside>
    </section>

    <section class="admin-grid admin-grid--two">
      <article class="admin-panel admin-panel-block">
        <div class="admin-panel__head">
          <div>
            <span class="admin-kicker">区域服务分布</span>
            <h3 class="admin-panel__title">按区域查看领取人数、件数与时间段</h3>
          </div>
        </div>

        <div v-if="regionBreakdown.length" class="region-chart">
          <section v-for="region in regionBreakdown" :key="region.regionId ?? region.regionName" class="region-chart__row">
            <div class="region-chart__main">
              <div class="region-chart__head">
                <div>
                  <span class="admin-table__strong">{{ region.regionName }}</span>
                  <span class="admin-table__subtext">
                    服务 {{ region.servedUsers }} 人 · 领取 {{ region.pickupUnits }} 件 · 发生 {{ region.pickupTimes }} 次
                  </span>
                </div>
                <span class="admin-code">{{ region.peakHourLabel ?? "无峰值" }}</span>
              </div>
              <div class="region-chart__bar-shell">
                <div
                  class="region-chart__bar-fill"
                  :style="{ width: `${Math.max(8, (region.pickupUnits / maxRegionValue) * 100)}%` }"
                />
              </div>
              <div class="region-chart__time-strip">
                <span
                  v-for="timeBar in region.timeBars"
                  :key="timeBar.key"
                  class="region-chart__time-segment"
                  :class="`region-chart__time-segment--${timeBar.key}`"
                  :style="{ flexGrow: String(Math.max(1, timeBar.value)) }"
                >
                  {{ timeBar.label }} {{ timeBar.value }}
                </span>
              </div>
            </div>
            <div class="region-chart__meta">
              <span class="admin-table__subtext">首次领取：{{ formatDateTime(region.firstPickupAt) }}</span>
              <span class="admin-table__subtext">最近领取：{{ formatDateTime(region.lastPickupAt) }}</span>
            </div>
          </section>
        </div>
        <div v-else class="admin-empty">
          <div class="admin-empty__title">当前范围没有区域领取数据</div>
          <div class="admin-empty__body">当普通用户产生领取或补扣动作后，这里会按区域显示时间分布。</div>
        </div>
      </article>

      <article class="admin-panel admin-panel-block">
        <div class="admin-panel__head">
          <div>
            <span class="admin-kicker">柜机与货品</span>
            <h3 class="admin-panel__title">查看当前时间范围的活跃柜机和热门货品</h3>
          </div>
        </div>

        <div class="data-monitor-side-grid">
          <section>
            <div class="data-monitor-side-grid__head">热门货品</div>
            <table v-if="periodSummary?.topGoods.length" class="admin-table">
              <thead>
                <tr>
                  <th>货品</th>
                  <th>数量</th>
                </tr>
              </thead>
              <tbody>
                <tr v-for="item in periodSummary.topGoods" :key="item.goodsId">
                  <td>
                    <RouterLink class="admin-link admin-table__strong" :to="`/goods/${item.goodsId}`">
                      {{ item.goodsName }}
                    </RouterLink>
                    <span class="admin-table__subtext">{{ item.goodsId }}</span>
                  </td>
                  <td class="admin-code">{{ item.quantity }}</td>
                </tr>
              </tbody>
            </table>
            <div v-else class="admin-empty admin-empty--compact">
              <div class="admin-empty__title">没有货品流动</div>
            </div>
          </section>

          <section>
            <div class="data-monitor-side-grid__head">活跃柜机</div>
            <table v-if="periodSummary?.topDevices.length" class="admin-table">
              <thead>
                <tr>
                  <th>柜机</th>
                  <th>领取</th>
                  <th>事件</th>
                </tr>
              </thead>
              <tbody>
                <tr v-for="item in periodSummary.topDevices" :key="item.deviceCode">
                  <td>
                    <RouterLink class="admin-link admin-table__strong" :to="`/operations/${item.deviceCode}`">
                      {{ item.deviceName }}
                    </RouterLink>
                    <span class="admin-table__subtext">{{ item.deviceCode }}</span>
                  </td>
                  <td class="admin-code">{{ item.pickupUnits }}</td>
                  <td class="admin-code">{{ item.eventCount }}</td>
                </tr>
              </tbody>
            </table>
            <div v-else class="admin-empty admin-empty--compact">
              <div class="admin-empty__title">没有柜机动作</div>
            </div>
          </section>
        </div>
      </article>
    </section>

    <section v-if="periodSummary" class="admin-page__section">
      <article class="admin-panel admin-panel-block">
        <div class="admin-panel__head">
          <div>
            <span class="admin-kicker">范围内日志</span>
            <h3 class="admin-panel__title">查看当前时间范围的关键动作</h3>
          </div>
        </div>

        <table v-if="periodSummary.recentLogs.length" class="admin-table">
          <thead>
            <tr>
              <th>时间</th>
              <th>动作</th>
              <th>状态</th>
              <th>详情</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="log in periodSummary.recentLogs" :key="log.id">
              <td class="admin-code">{{ formatDateTime(log.occurredAt) }}</td>
              <td>
                <span class="admin-table__strong">{{ log.description }}</span>
                <span class="admin-table__subtext">{{ log.detail }}</span>
              </td>
              <td>
                <span
                  class="admin-pill"
                  :class="
                    log.status === 'success'
                      ? 'admin-pill--success'
                      : log.status === 'failed'
                        ? 'admin-pill--danger'
                        : log.status === 'warning'
                          ? 'admin-pill--warning'
                          : 'admin-pill--neutral'
                  "
                >
                  {{ log.status === "success" ? "成功" : log.status === "failed" ? "失败" : log.status === "warning" ? "预警" : "待处理" }}
                </span>
              </td>
              <td>
                <RouterLink class="admin-link" :to="`/logs/${log.id}`">详情</RouterLink>
              </td>
            </tr>
          </tbody>
        </table>
        <div v-else class="admin-empty">
          <div class="admin-empty__title">当前范围没有日志</div>
          <div class="admin-empty__body">切换到有业务动作的日期或放宽范围后，这里会显示关键动作。</div>
        </div>
      </article>
    </section>
  </section>
</template>

<style scoped>
.data-monitor-stat-link {
  display: block;
  color: inherit;
  text-decoration: none;
}

.data-monitor-stat-link:hover {
  text-decoration: none;
}

.data-monitor-stat-link :deep(.stat-tile) {
  height: 100%;
}

.data-monitor-range-switch,
.data-monitor-metric-switch {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}

.data-monitor-range-switch__active,
.data-monitor-metric-switch__active {
  background: var(--admin-accent-soft);
  border-color: #aebfe1;
  color: var(--admin-accent-strong);
}

.data-monitor-calendar {
  display: grid;
  grid-template-columns: repeat(7, minmax(0, 1fr));
  gap: 8px;
}

.data-monitor-calendar__weekday {
  padding: 6px 4px;
  text-align: center;
  color: var(--admin-muted);
  font-size: 0.78rem;
  font-weight: 700;
}

.data-monitor-calendar__day {
  min-height: 70px;
  display: grid;
  justify-items: center;
  align-content: center;
  gap: 8px;
  border: 1px solid var(--admin-line);
  border-radius: 10px;
  background: var(--admin-panel);
  cursor: pointer;
}

.data-monitor-calendar__day--muted {
  color: #98a4b3;
  background: var(--admin-panel-muted);
}

.data-monitor-calendar__day--selected {
  border-color: var(--admin-accent);
  background: var(--admin-accent-soft);
}

.data-monitor-calendar__day--light .data-monitor-calendar__marker {
  background: #9bb3d7;
}

.data-monitor-calendar__day--medium .data-monitor-calendar__marker {
  background: #587fc0;
}

.data-monitor-calendar__day--high .data-monitor-calendar__marker {
  background: var(--admin-accent-strong);
}

.data-monitor-calendar__marker {
  width: 10px;
  height: 10px;
  border-radius: 999px;
}

.data-monitor-series-chart {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(74px, 1fr));
  gap: 12px;
  align-items: end;
  min-height: 290px;
}

.data-monitor-series-chart__item {
  min-width: 0;
  display: grid;
  gap: 8px;
  justify-items: center;
}

.data-monitor-series-chart__shell {
  width: 100%;
  max-width: 60px;
  height: 190px;
  display: flex;
  align-items: flex-end;
  padding: 4px;
  border-radius: 10px;
  border: 1px solid var(--admin-line);
  background: var(--admin-panel-muted);
}

.data-monitor-series-chart__fill {
  width: 100%;
  border-radius: 6px;
  background: linear-gradient(180deg, var(--admin-accent) 0%, var(--admin-accent-strong) 100%);
}

.data-monitor-series-chart__label {
  text-align: center;
  font-size: 0.82rem;
  color: var(--admin-muted);
}

.data-monitor-series-chart__value {
  font-family: var(--admin-code-font);
  font-weight: 700;
}

.data-monitor-side-grid {
  display: grid;
  gap: 12px;
}

.data-monitor-side-grid__head {
  margin-bottom: 8px;
  color: var(--admin-muted);
  font-size: 0.82rem;
  font-weight: 700;
}

.admin-empty--compact {
  min-height: 120px;
}

.region-chart {
  display: grid;
  gap: 12px;
}

.region-chart__row {
  display: grid;
  gap: 8px;
  padding: 12px;
  border: 1px solid var(--admin-line);
  border-radius: 8px;
  background: var(--admin-panel-muted);
}

.region-chart__main {
  display: grid;
  gap: 8px;
}

.region-chart__head {
  display: flex;
  justify-content: space-between;
  align-items: flex-start;
  gap: 12px;
}

.region-chart__bar-shell {
  height: 12px;
  border-radius: 999px;
  background: #e5ebf3;
  overflow: hidden;
}

.region-chart__bar-fill {
  height: 100%;
  border-radius: inherit;
  background: linear-gradient(90deg, var(--admin-accent) 0%, var(--admin-accent-strong) 100%);
}

.region-chart__time-strip {
  display: flex;
  gap: 6px;
}

.region-chart__time-segment {
  min-width: 0;
  display: flex;
  justify-content: center;
  align-items: center;
  min-height: 26px;
  padding: 0 8px;
  border-radius: 6px;
  color: #fff;
  font-size: 0.76rem;
  font-weight: 700;
  white-space: nowrap;
}

.region-chart__time-segment--morning {
  background: #4c6fff;
}

.region-chart__time-segment--midday {
  background: #2a91d8;
}

.region-chart__time-segment--afternoon {
  background: #18a06f;
}

.region-chart__time-segment--night {
  background: #7a5af8;
}

.region-chart__meta {
  display: flex;
  flex-wrap: wrap;
  gap: 12px;
}

@media (max-width: 960px) {
  .data-monitor-series-chart {
    grid-template-columns: repeat(3, minmax(0, 1fr));
  }

  .region-chart__head,
  .region-chart__meta {
    flex-direction: column;
    align-items: flex-start;
  }

  .region-chart__time-strip {
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }
}

@media (max-width: 720px) {
  .data-monitor-series-chart {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }

  .data-monitor-calendar {
    gap: 6px;
  }

  .data-monitor-calendar__day {
    min-height: 60px;
  }
}
</style>
