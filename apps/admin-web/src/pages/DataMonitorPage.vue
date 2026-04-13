<script setup lang="ts">
import { computed, onMounted, ref } from "vue";
import { RouterLink } from "vue-router";
import type { DataMonitorSnapshot } from "@vm/shared-types";

import { adminApi } from "../api/admin";

const snapshot = ref<DataMonitorSnapshot>();
const loading = ref(false);
const calendarMonth = ref(new Date().toISOString().slice(0, 7));
const selectedDateKey = ref(`${calendarMonth.value}-01`);

const currentMonthTitle = computed(() => {
  const source = snapshot.value?.monthKey ?? calendarMonth.value;
  if (!source) {
    return "";
  }

  const [year, month] = source.split("-");
  return `${year}年 ${month}月`;
});

const metricBars = computed(() => snapshot.value?.selectedDateSummary?.metricBars ?? []);
const maxBarValue = computed(() =>
  Math.max(1, ...metricBars.value.map((item) => item.value))
);

const formatDateTime = (value?: string) =>
  value ? value.slice(0, 16).replace("T", " ") : "-";

const load = async () => {
  loading.value = true;
  try {
    const response = await adminApi.dataMonitor({
      month: calendarMonth.value,
      date: selectedDateKey.value
    });
    snapshot.value = response;
    calendarMonth.value = response.monthKey;
    selectedDateKey.value = response.selectedDateKey;
  } finally {
    loading.value = false;
  }
};

const changeMonth = async (offset: number) => {
  const [year, month] = calendarMonth.value.split("-").map(Number);
  const next = new Date(year, month - 1 + offset, 1);
  calendarMonth.value = `${next.getFullYear()}-${String(next.getMonth() + 1).padStart(2, "0")}`;
  selectedDateKey.value = `${calendarMonth.value}-01`;
  await load();
};

const selectDate = async (dateKey: string) => {
  selectedDateKey.value = dateKey;
  if (!dateKey.startsWith(calendarMonth.value)) {
    calendarMonth.value = dateKey.slice(0, 7);
  }
  await load();
};

onMounted(load);
</script>

<template>
  <section class="admin-page">
    <section class="admin-page__section">
      <div class="admin-page__section-head">
        <div>
          <p class="admin-kicker">数据监控</p>
          <h3 class="admin-page__section-title">按业务日查看服务、货品、事件与日志变化</h3>
        </div>
        <div class="admin-toolbar">
          <button class="admin-button admin-button--ghost" :disabled="loading" @click="load">
            {{ loading ? "刷新中" : "刷新数据" }}
          </button>
        </div>
      </div>
    </section>

    <section class="admin-grid admin-grid--main-aside">
      <article class="admin-panel admin-panel-block">
        <div class="admin-panel__head">
          <div>
            <span class="admin-kicker">日期选择</span>
            <h3 class="admin-panel__title">按日查看全部运营数据</h3>
          </div>
          <div class="admin-toolbar">
            <button class="admin-button admin-button--ghost" @click="changeMonth(-1)">上月</button>
            <span class="admin-code">{{ currentMonthTitle }}</span>
            <button class="admin-button admin-button--ghost" @click="changeMonth(1)">下月</button>
          </div>
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

        <div v-if="snapshot?.selectedDateSummary" class="admin-note">
          已选业务日 {{ snapshot.selectedDateSummary.businessDateKey }}：
          服务人数 {{ snapshot.selectedDateSummary.servedUsers }} 人，
          领取 {{ snapshot.selectedDateSummary.pickupUnits }} 件，
          补货与调拨 {{ snapshot.selectedDateSummary.restockUnits }} 件。
        </div>
      </article>

      <aside class="admin-grid">
        <article class="admin-panel admin-panel-block">
          <div class="admin-panel__head">
            <div>
              <span class="admin-kicker">柱状图</span>
              <h3 class="admin-panel__title">按选中日期汇总关键指标</h3>
            </div>
          </div>

          <div v-if="metricBars.length" class="data-monitor-chart">
            <div v-for="item in metricBars" :key="item.key" class="data-monitor-chart__item">
              <div class="data-monitor-chart__bar-shell">
                <div
                  class="data-monitor-chart__bar-fill"
                  :style="{ height: `${Math.max(10, (item.value / maxBarValue) * 100)}%` }"
                />
              </div>
              <span class="data-monitor-chart__label">{{ item.label }}</span>
              <span class="data-monitor-chart__value">{{ item.value }}{{ item.unit }}</span>
            </div>
          </div>
          <div v-else class="admin-empty">
            <div class="admin-empty__title">当前日期没有可视化数据</div>
            <div class="admin-empty__body">选择一个有业务动作的日期后，这里会显示柱状图。</div>
          </div>
        </article>
      </aside>
    </section>

    <section v-if="snapshot?.selectedDateSummary" class="admin-grid admin-grid--two">
      <article class="admin-panel admin-panel-block">
        <div class="admin-panel__head">
          <div>
            <span class="admin-kicker">热门货品</span>
            <h3 class="admin-panel__title">当日流动最多的货品</h3>
          </div>
        </div>

        <table v-if="snapshot.selectedDateSummary.topGoods.length" class="admin-table">
          <thead>
            <tr>
              <th>货品</th>
              <th>数量</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="item in snapshot.selectedDateSummary.topGoods" :key="item.goodsId">
              <td>
                <RouterLink class="admin-link admin-table__strong" :to="`/goods/${item.goodsId}`">
                  {{ item.goodsName }}
                </RouterLink>
              </td>
              <td class="admin-code">{{ item.quantity }}</td>
            </tr>
          </tbody>
        </table>
        <div v-else class="admin-empty">
          <div class="admin-empty__title">当前日期没有货品流动</div>
          <div class="admin-empty__body">领取、补货、补扣和调拨都会在这里汇总。</div>
        </div>
      </article>

      <article class="admin-panel admin-panel-block">
        <div class="admin-panel__head">
          <div>
            <span class="admin-kicker">柜机活跃度</span>
            <h3 class="admin-panel__title">按柜机查看当日动作量</h3>
          </div>
        </div>

        <table v-if="snapshot.selectedDateSummary.topDevices.length" class="admin-table">
          <thead>
            <tr>
              <th>柜机</th>
              <th>领取</th>
              <th>补货</th>
              <th>事件</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="item in snapshot.selectedDateSummary.topDevices" :key="item.deviceCode">
              <td>
                <RouterLink class="admin-link admin-table__strong" :to="`/operations/${item.deviceCode}`">
                  {{ item.deviceName }}
                </RouterLink>
                <span class="admin-table__subtext">{{ item.deviceCode }}</span>
              </td>
              <td class="admin-code">{{ item.pickupUnits }}</td>
              <td class="admin-code">{{ item.restockUnits }}</td>
              <td class="admin-code">{{ item.eventCount }}</td>
            </tr>
          </tbody>
        </table>
        <div v-else class="admin-empty">
          <div class="admin-empty__title">当前日期没有柜机动作</div>
          <div class="admin-empty__body">选择其他日期后可查看对应柜机的当日活跃度。</div>
        </div>
      </article>
    </section>

    <section v-if="snapshot?.selectedDateSummary" class="admin-page__section">
      <article class="admin-panel admin-panel-block">
        <div class="admin-panel__head">
          <div>
            <span class="admin-kicker">当日日志</span>
            <h3 class="admin-panel__title">查看该业务日的关键系统动作</h3>
          </div>
        </div>

        <table v-if="snapshot.selectedDateSummary.recentLogs.length" class="admin-table">
          <thead>
            <tr>
              <th>时间</th>
              <th>动作</th>
              <th>状态</th>
              <th>详情</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="log in snapshot.selectedDateSummary.recentLogs" :key="log.id">
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
          <div class="admin-empty__title">当前日期没有日志</div>
          <div class="admin-empty__body">选择其他日期后可以查看对应业务日的系统动作。</div>
        </div>
      </article>
    </section>
  </section>
</template>

<style scoped>
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

.data-monitor-chart {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(88px, 1fr));
  gap: 12px;
  align-items: end;
  min-height: 260px;
}

.data-monitor-chart__item {
  display: grid;
  gap: 8px;
  justify-items: center;
}

.data-monitor-chart__bar-shell {
  width: 100%;
  max-width: 56px;
  height: 170px;
  display: flex;
  align-items: flex-end;
  padding: 4px;
  border-radius: 10px;
  border: 1px solid var(--admin-line);
  background: var(--admin-panel-muted);
}

.data-monitor-chart__bar-fill {
  width: 100%;
  border-radius: 6px;
  background: linear-gradient(180deg, var(--admin-accent) 0%, var(--admin-accent-strong) 100%);
}

.data-monitor-chart__label {
  text-align: center;
  font-size: 0.82rem;
  color: var(--admin-muted);
}

.data-monitor-chart__value {
  font-family: var(--admin-code-font);
  font-weight: 700;
}

@media (max-width: 720px) {
  .data-monitor-chart {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }
}
</style>
