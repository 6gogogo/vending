<script setup lang="ts">
import { computed, onMounted, ref, watch } from "vue";
import { RouterLink } from "vue-router";
import type {
  ServiceVisitPeriod,
  ServiceVisitSnapshot,
} from "@vm/shared-types";
import { adminApi } from "../api/admin";
import { formatDateTime, getTodayDateKeyInBeijing } from "../utils/datetime";
import { getAdminErrorMessage } from "../utils/error-message";

const periods: Array<{ value: ServiceVisitPeriod; label: string }> = [
  { value: "recent-month", label: "最近一个月" },
  { value: "recent-year", label: "最近一年" },
  { value: "month", label: "按月" },
  { value: "year", label: "按年" },
  { value: "all", label: "全部累计" },
];
const today = getTodayDateKeyInBeijing();
const period = ref<ServiceVisitPeriod>("recent-month");
const year = ref(today.slice(0, 4));
const month = ref(today.slice(0, 7));
const userId = ref("");
const snapshot = ref<ServiceVisitSnapshot>();
const personOptions = ref<ServiceVisitSnapshot["personOptions"]>([]);
const availableYears = ref([today.slice(0, 4)]);
const businessToday = ref(today);
const loading = ref(true);
const error = ref("");
const search = ref("");
const page = ref(1);
const hovered = ref<number>();
let requestVersion = 0;
let initialized = false;
const number = (value: number) =>
  new Intl.NumberFormat("zh-CN", { maximumFractionDigits: 1 }).format(value);
const selectedName = computed(
  () =>
    personOptions.value.find((person) => person.userId === userId.value)?.name,
);
const scopeLabel = computed(() =>
  selectedName.value ? `${selectedName.value}的领取记录` : "全体领取人员",
);
const periodLabel = computed(
  () => periods.find((item) => item.value === period.value)?.label,
);
const filteredPeople = computed(() => {
  const keyword = search.value.trim().toLocaleLowerCase();
  return (snapshot.value?.people ?? []).filter((person) =>
    `${person.name} ${person.userId} ${person.neighborhood}`
      .toLocaleLowerCase()
      .includes(keyword),
  );
});
const pageCount = computed(() =>
  Math.max(1, Math.ceil(filteredPeople.value.length / 8)),
);
const displayedPeople = computed(() =>
  filteredPeople.value.slice((page.value - 1) * 8, page.value * 8),
);
const comparison = computed(() => {
  const current = snapshot.value?.summary.visits ?? 0;
  const previous = snapshot.value?.previous;
  if (!previous) return "全部有效历史领取记录";
  if (!previous.visits)
    return current
      ? `比上一周期增加 ${number(current)} 人次`
      : "本期与上一周期均无领取";
  const change = ((current - previous.visits) / previous.visits) * 100;
  return change === 0
    ? "与上一周期持平"
    : `较上一周期${change > 0 ? "增加" : "减少"} ${number(Math.abs(change))}%`;
});
const series = computed(() => snapshot.value?.series ?? []);
const ceiling = computed(() => {
  const max = Math.max(1, ...series.value.map((point) => point.visits));
  return Math.max(4, Math.ceil(max / 4) * 4);
});
const points = computed(() =>
  series.value.map((point, index) => ({
    ...point,
    x:
      series.value.length === 1
        ? 410
        : 52 + (index / (series.value.length - 1)) * 718,
    y: 220 - (point.visits / ceiling.value) * 172,
  })),
);
const chartLine = computed(() =>
  points.value.map((point) => `${point.x},${point.y}`).join(" "),
);
const chartArea = computed(() =>
  points.value.length
    ? `M ${points.value[0].x},220 L ${points.value.map((point) => `${point.x},${point.y}`).join(" L ")} L ${points.value.at(-1)!.x},220 Z`
    : "",
);
const chartLabels = computed(() =>
  points.value.filter(
    (_, index) =>
      index === 0 ||
      index === points.value.length - 1 ||
      index % Math.ceil(points.value.length / 6) === 0,
  ),
);
const activePoint = computed(() =>
  hovered.value === undefined ? undefined : points.value[hovered.value],
);
const peak = computed(() =>
  series.value.reduce<(typeof series.value)[number] | undefined>(
    (best, point) => (!best || point.visits > best.visits ? point : best),
    undefined,
  ),
);
const average = computed(() => {
  const data = snapshot.value;
  if (!data) return 0;
  const days =
    Math.round(
      (Date.parse(data.endDate) - Date.parse(data.startDate)) / 86_400_000,
    ) + 1;
  return data.summary.visits / days;
});
const load = async () => {
  const version = ++requestVersion;
  loading.value = true;
  error.value = "";
  snapshot.value = undefined;
  hovered.value = undefined;
  page.value = 1;
  try {
    const data = await adminApi.serviceVisits({
      period: period.value,
      year: year.value,
      month: month.value,
      userId: userId.value || undefined,
    });
    if (version !== requestVersion) return;
    snapshot.value = data;
    if (!initialized) {
      initialized = true;
      year.value = data.today.slice(0, 4);
      month.value = data.today.slice(0, 7);
    }
    personOptions.value = data.personOptions;
    availableYears.value = data.availableYears;
    businessToday.value = data.today;
  } catch (reason) {
    if (version === requestVersion)
      error.value = getAdminErrorMessage(reason, "统计暂时无法加载，请重试。");
  } finally {
    if (version === requestVersion) loading.value = false;
  }
};
watch([period, year, month, userId], load);
watch(search, () => {
  page.value = 1;
});
onMounted(load);
</script>

<template>
  <section class="visits-page" :aria-busy="loading">
    <div class="visits-filters">
      <div class="visits-periods" role="group" aria-label="统计周期">
        <button
          v-for="item in periods"
          :key="item.value"
          :aria-pressed="period === item.value"
          :class="{ selected: period === item.value }"
          @click="period = item.value"
        >
          {{ item.label }}
        </button>
      </div>
      <div class="visits-filter-actions">
        <div class="visits-selectors">
          <label v-if="period === 'year'" class="visits-select">
            <span>年度</span>
            <select v-model="year" aria-label="选择年度">
              <option
                v-for="value in availableYears"
                :key="value"
                :value="value"
              >
                {{ value }} 年
              </option>
            </select>
          </label>
          <label v-if="period === 'month'" class="visits-select">
            <span>月份</span>
            <input
              v-model="month"
              aria-label="选择月份"
              type="month"
              min="2000-01"
              :max="businessToday.slice(0, 7)"
            />
          </label>
          <label class="visits-select visits-person-select">
            <span class="visits-sr-only">统计人员</span>
            <svg
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              stroke-width="1.7"
              aria-hidden="true"
            >
              <circle cx="12" cy="8" r="3.5" />
              <path d="M5 21v-2a7 7 0 0 1 14 0v2" />
            </svg>
            <select v-model="userId" aria-label="按个人统计">
              <option value="">全部人员</option>
              <option
                v-for="person in personOptions"
                :key="person.userId"
                :value="person.userId"
              >
                {{ person.name }} · {{ person.userId }}
              </option>
            </select>
          </label>
        </div>
        <button
          class="visits-refresh"
          :disabled="loading"
          :aria-label="loading ? '正在更新服务统计' : '刷新服务统计'"
          title="刷新数据"
          @click="load"
        >
          <svg
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            stroke-width="1.7"
            aria-hidden="true"
          >
            <path d="M20 7v5h-5M4 17v-5h5" />
            <path d="M6.1 7a7 7 0 0 1 11.6-1L20 9M4 15l2.3 3A7 7 0 0 0 18 17" />
          </svg>
          <span>{{ loading ? "更新中" : "刷新" }}</span>
        </button>
      </div>
    </div>

    <div v-if="error" class="visits-error" role="alert">
      <div>
        <strong>暂时无法获取统计</strong>
        <p>{{ error }}</p>
      </div>
      <button class="visits-refresh" @click="load">重新加载</button>
    </div>
    <div v-else-if="loading" class="visits-loading" role="status">
      <span>正在汇总领取记录…</span>
      <div class="visits-skeleton visits-skeleton-overview"></div>
      <div class="visits-skeleton visits-skeleton-chart"></div>
    </div>

    <template v-else-if="snapshot">
      <div class="visits-context" aria-live="polite">
        <div class="visits-scope">
          <span>{{ scopeLabel }}</span>
          <button v-if="userId" @click="userId = ''">清除个人筛选 ×</button>
        </div>
        <div class="visits-date-range">
          <time :datetime="snapshot.startDate">{{ snapshot.startDate }}</time>
          <span>至</span>
          <time :datetime="snapshot.endDate">{{ snapshot.endDate }}</time>
          <small v-if="period === 'recent-month'">近 30 个业务日</small>
          <small v-else-if="period === 'recent-year'">近 365 个业务日</small>
        </div>
      </div>

      <section class="visits-hero" aria-label="服务数据展示">
        <div class="visits-hero-layout">
          <div class="visits-primary">
            <span class="visits-primary-label">
              <i aria-hidden="true"></i>{{ periodLabel }}服务人次
            </span>
            <div class="visits-primary-value">
              {{ number(snapshot.summary.visits) }}<small>人次</small>
            </div>
            <p
              class="visits-comparison"
              :title="
                snapshot.previous
                  ? `${snapshot.previous.startDate} 至 ${snapshot.previous.endDate}：${snapshot.previous.visits} 人次`
                  : undefined
              "
            >
              {{ comparison }}
            </p>
            <dl class="visits-hero-metrics">
              <div>
                <dt>服务人数</dt>
                <dd>{{ number(snapshot.summary.people) }}<small>人</small></dd>
                <p>所选时段内去重</p>
              </div>
              <div>
                <dt>领取物资</dt>
                <dd>{{ number(snapshot.summary.units) }}<small>件</small></dd>
                <p>已抵减退回物资</p>
              </div>
            </dl>
          </div>

          <div class="visits-hero-visual" aria-labelledby="visits-trend-title">
            <div class="visits-hero-chart-heading">
              <div class="visits-hero-chart-title">
                <h3 id="visits-trend-title">服务趋势</h3>
                <span>
                  领取人次 · 按{{
                    snapshot.grain === "day"
                      ? "日"
                      : snapshot.grain === "month"
                        ? "月"
                        : "年"
                  }}汇总
                </span>
              </div>
              <div class="visits-chart-readout" aria-live="polite">
                <template v-if="activePoint">
                  <b>{{ activePoint.label }}</b>
                  <span>{{ number(activePoint.visits) }} 人次</span>
                  <span>
                    {{ number(activePoint.people) }} 人 ·
                    {{ number(activePoint.units) }} 件
                  </span>
                </template>
                <span v-else>
                  <b>{{ snapshot.summary.activeDays }}</b> 个活跃业务日
                </span>
              </div>
            </div>
            <div class="visits-chart-wrap">
              <svg
                v-if="snapshot.summary.visits"
                class="visits-chart"
                viewBox="0 0 800 264"
                role="group"
                aria-label="领取人次趋势图，可聚焦数据点查看具体数值"
              >
                <defs>
                  <linearGradient id="visits-area" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stop-color="#2d7154" stop-opacity=".38" />
                    <stop offset="100%" stop-color="#2d7154" stop-opacity=".015" />
                  </linearGradient>
                </defs>
                <g v-for="tick in 5" :key="tick">
                  <line
                    x1="52"
                    x2="770"
                    :y1="48 + (tick - 1) * 43"
                    :y2="48 + (tick - 1) * 43"
                    stroke="#d7f8e8"
                    stroke-opacity=".14"
                    :stroke-dasharray="tick === 5 ? '0' : '3 5'"
                  />
                  <text
                    x="35"
                    :y="53 + (tick - 1) * 43"
                    text-anchor="end"
                    class="visits-axis"
                  >
                    {{ number((ceiling * (5 - tick)) / 4) }}
                  </text>
                </g>
                <path :d="chartArea" fill="url(#visits-area)" />
                <polyline
                  class="visits-chart-line"
                  :points="chartLine"
                  fill="none"
                  stroke="#2d7154"
                  stroke-width="2.6"
                  stroke-linejoin="round"
                  stroke-linecap="round"
                />
                <line
                  v-if="activePoint"
                  :x1="activePoint.x"
                  :x2="activePoint.x"
                  y1="45"
                  y2="220"
                  stroke="#b5e7ce"
                  stroke-opacity=".65"
                  stroke-dasharray="4 4"
                />
                <g
                  v-for="(point, index) in points"
                  :key="point.key"
                  tabindex="0"
                  role="img"
                  :aria-label="`${point.label}，${point.visits} 人次，${point.people} 人，${point.units} 件`"
                  @mouseenter="hovered = index"
                  @mouseleave="hovered = undefined"
                  @focus="hovered = index"
                  @blur="hovered = undefined"
                  @click="hovered = index"
                >
                  <rect
                    :x="point.x - Math.min(16, 350 / points.length)"
                    y="40"
                    :width="Math.min(32, 700 / points.length)"
                    height="182"
                    fill="transparent"
                  />
                  <circle
                    :cx="point.x"
                    :cy="point.y"
                    :r="hovered === index ? 5 : points.length < 16 ? 3 : 0"
                    fill="#b8f6cf"
                    stroke="#0c2c26"
                    stroke-width="2"
                  />
                  <title>
                    {{ point.label }}：{{ point.visits }} 人次 ·
                    {{ point.people }} 人 · {{ point.units }} 件
                  </title>
                </g>
                <text
                  v-for="point in chartLabels"
                  :key="point.key"
                  :x="point.x"
                  y="250"
                  text-anchor="middle"
                  class="visits-axis"
                >
                  {{ point.label }}
                </text>
              </svg>
              <div v-else class="visits-chart-empty">
                <strong>当前时段暂无领取记录</strong>
                <span>可切换统计周期，或查看其他人员的记录。</span>
              </div>
            </div>
          </div>
        </div>

        <dl class="visits-hero-footer">
          <div>
            <dt>累计服务</dt>
            <dd>{{ number(snapshot.lifetime.visits) }}<small>人次</small></dd>
            <p>覆盖 {{ number(snapshot.lifetime.people) }} 位领取人员</p>
          </div>
          <div>
            <dt>日均服务</dt>
            <dd>{{ number(average) }}<small>人次</small></dd>
            <p>按所选起止日期计算</p>
          </div>
          <div>
            <dt>服务峰值</dt>
            <dd>{{ number(peak?.visits ?? 0) }}<small>人次</small></dd>
            <p>{{ peak?.visits ? peak.label : "当前时段暂无峰值" }}</p>
          </div>
        </dl>
        <div class="visits-hero-note">
          <span>每次实际领取计 1 人次，同次多件不重复；未领取的日期保留为 0。</span>
          <span v-if="snapshot.previous">
            对比周期 {{ snapshot.previous.startDate }} — {{ snapshot.previous.endDate }}
          </span>
        </div>
      </section>

      <section class="visits-people-panel" aria-labelledby="visits-people-title">
        <div class="visits-panel-heading">
          <div>
            <h3 id="visits-people-title">个人明细</h3>
            <p>{{ snapshot.people.length }} 位有领取记录的人员</p>
          </div>
          <label class="visits-search">
            <svg
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              stroke-width="1.7"
              aria-hidden="true"
            >
              <circle cx="10.5" cy="10.5" r="6.5" />
              <path d="m16 16 5 5" />
            </svg>
            <input
              v-model="search"
              type="search"
              aria-label="搜索姓名、人员编号或社区"
              placeholder="搜索姓名、编号或社区"
            />
          </label>
        </div>
        <div class="visits-table-wrap">
          <table class="visits-table">
            <caption class="visits-sr-only">
              {{ snapshot.startDate }} 至 {{ snapshot.endDate }}
              个人领取统计，按本期人次从高到低排列
            </caption>
            <thead>
              <tr>
                <th>领取人员</th>
                <th>本期人次</th>
                <th class="visits-numeric">累计人次</th>
                <th class="visits-numeric">领取件数</th>
                <th class="visits-numeric">服务天数</th>
                <th>本期最近领取</th>
                <th><span class="visits-sr-only">操作</span></th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="person in displayedPeople" :key="person.userId">
                <td>
                  <div class="visits-person">
                    <strong>{{ person.name }}</strong>
                    <small>{{ person.neighborhood }} · {{ person.userId }}</small>
                  </div>
                </td>
                <td class="visits-person-visits" data-label="本期人次">
                  <strong>{{ number(person.visits) }}</strong>
                </td>
                <td class="visits-numeric" data-label="累计人次">
                  {{ number(person.lifetimeVisits) }}
                </td>
                <td class="visits-numeric" data-label="领取件数">
                  {{ number(person.units) }}
                </td>
                <td class="visits-numeric" data-label="服务天数">
                  {{ person.activeDays }}
                </td>
                <td class="visits-last-date" data-label="本期最近领取">
                  {{ formatDateTime(person.lastPickupAt) }}
                </td>
                <td class="visits-person-action">
                  <button
                    class="visits-detail"
                    :aria-label="`查看${person.name}的个人统计`"
                    :disabled="userId === person.userId"
                    @click="userId = person.userId"
                  >
                    {{ userId === person.userId ? "当前人员" : "查看趋势" }}
                    <span v-if="userId !== person.userId" aria-hidden="true">↗</span>
                  </button>
                </td>
              </tr>
              <tr v-if="!displayedPeople.length" class="visits-empty-row">
                <td colspan="7" class="visits-table-empty">
                  <strong>{{ search ? "没有匹配的人员" : "暂无领取人员" }}</strong>
                  <span>
                    {{
                      search
                        ? "试试其他姓名、人员编号或社区。"
                        : "产生领取记录后，个人明细会显示在这里。"
                    }}
                  </span>
                </td>
              </tr>
            </tbody>
          </table>
        </div>
        <div class="visits-table-foot">
          <span>共 {{ filteredPeople.length }} 人 · 按本期领取人次排序</span>
          <div class="visits-pagination">
            <button :disabled="page <= 1" aria-label="上一页" @click="page--">
              ←
            </button>
            <span>{{ page }} / {{ pageCount }}</span>
            <button
              :disabled="page >= pageCount"
              aria-label="下一页"
              @click="page++"
            >
              →
            </button>
          </div>
        </div>
      </section>

      <footer class="visits-notes">
        <details>
          <summary>统计口径说明</summary>
          <p>
            每次实际领取计 1
            人次，同一开柜事件或订单的多件商品合并计算；完全退回的领取不计入。空开柜、补货和手工库存纠错不计入人次。服务人数按人员编号去重，累计数据以系统保留的有效历史记录为准。
          </p>
          <p>
            按业务日归属（UTC{{ snapshot.timezoneOffsetHours >= 0 ? "+" : ""
            }}{{ snapshot.timezoneOffsetHours }}，每日
            {{ String(snapshot.businessDayStartHour).padStart(2, "0") }}:00
            起算）。最近一个月为含今天的近 30 个业务日，最近一年为近 365
            个业务日；按年、按月为指定自然年/月，当前周期截至今日。对比采用紧邻的上一等长周期。
          </p>
          <p v-if="snapshot.legacyVisitCount">
            本期有 {{ snapshot.legacyVisitCount }}
            次历史记录缺少订单/开柜编号，按人员、柜机及完全相同的领取时间合并，无法追溯更细的订单边界。
          </p>
        </details>
        <span>
          更新于 {{ formatDateTime(snapshot.generatedAt) }} ·
          <RouterLink to="/data-monitor">查看按日运营数据 ↗</RouterLink>
        </span>
      </footer>
    </template>
  </section>
</template>

<style scoped>
.visits-page {
  display: grid;
  gap: 20px;
  color: var(--admin-text);
}
.visits-filters,
.visits-filter-actions,
.visits-selectors,
.visits-context,
.visits-scope,
.visits-date-range,
.visits-panel-heading,
.visits-table-foot,
.visits-notes {
  display: flex;
  align-items: center;
}
.visits-filters {
  justify-content: space-between;
  gap: 16px;
  padding-bottom: 16px;
  border-bottom: 1px solid var(--admin-line);
}
.visits-periods {
  display: flex;
  align-items: center;
  gap: 4px;
}
.visits-periods button {
  min-height: 38px;
  padding: 8px 13px;
  border: 0;
  border-radius: 6px;
  background: transparent;
  color: var(--admin-text-muted);
  font-size: 12px;
  white-space: nowrap;
  transition: background-color 160ms, color 160ms;
}
.visits-periods button:hover {
  background: #edf2f0;
  color: var(--admin-text);
}
.visits-periods button.selected {
  background: #e6f2ed;
  color: var(--admin-accent-strong);
  font-weight: 650;
}
.visits-filter-actions,
.visits-selectors {
  justify-content: flex-end;
  gap: 10px;
}
.visits-select {
  display: flex;
  align-items: center;
  gap: 8px;
  min-height: 38px;
  padding: 0 10px;
  border: 1px solid var(--admin-line-strong);
  border-radius: 6px;
  background: #fff;
  color: var(--admin-muted);
  font-size: 12px;
}
.visits-select select,
.visits-select input {
  min-width: 0;
  max-width: 220px;
  padding: 7px 2px;
  border: 0;
  background: transparent;
  color: var(--admin-text);
}
.visits-select select:focus-visible,
.visits-select input:focus-visible,
.visits-search input:focus-visible {
  box-shadow: none;
}
.visits-select:focus-within,
.visits-search:focus-within {
  border-color: var(--admin-accent);
  box-shadow: var(--admin-focus);
}
.visits-page svg:not(.visits-chart) {
  width: 18px;
  height: 18px;
  flex-shrink: 0;
}
.visits-refresh {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 7px;
  min-height: 38px;
  padding: 8px 12px;
  border: 1px solid var(--admin-line-strong);
  border-radius: 6px;
  background: #fff;
  color: var(--admin-text-muted);
  font-size: 12px;
  white-space: nowrap;
}
.visits-refresh:not(:disabled):hover {
  background: var(--admin-panel-muted);
  color: var(--admin-accent-strong);
}
.visits-context {
  justify-content: space-between;
  gap: 12px 24px;
  margin-top: -4px;
  color: var(--admin-text-muted);
  font-size: 12px;
  flex-wrap: wrap;
}
.visits-scope,
.visits-date-range {
  gap: 9px;
  flex-wrap: wrap;
}
.visits-scope > span {
  color: var(--admin-text);
  font-weight: 600;
}
.visits-scope button {
  padding: 0;
  border: 0;
  background: transparent;
  color: var(--admin-accent-strong);
  font-size: 11px;
}
.visits-date-range {
  color: var(--admin-muted);
  font-variant-numeric: tabular-nums;
}
.visits-date-range small {
  padding-left: 9px;
  border-left: 1px solid var(--admin-line-strong);
  font-size: 11px;
}
.visits-hero {
  --hero-paper: var(--admin-panel);
  --hero-paper-strong: var(--admin-panel);
  --hero-ink: var(--admin-text);
  --hero-muted: var(--admin-muted);
  --hero-line: var(--admin-line);
  --hero-accent: var(--admin-accent);
  --hero-highlight: var(--admin-accent);
  position: relative;
  overflow: hidden;
  border: 1px solid var(--admin-line);
  border-radius: 10px;
  background: var(--admin-panel);
  box-shadow: var(--admin-shadow);
  color: var(--hero-ink);
}
.visits-hero-layout {
  display: grid;
  grid-template-columns: minmax(250px, 0.78fr) minmax(0, 1.8fr);
  gap: 32px;
  padding: 27px 28px 24px;
}
.visits-primary {
  display: flex;
  flex-direction: column;
  justify-content: center;
  min-width: 0;
  padding-right: 32px;
  border-right: 1px solid var(--hero-line);
}
.visits-primary-label {
  display: flex;
  align-items: center;
  gap: 9px;
  color: var(--admin-text-muted);
  font-size: 13px;
  font-weight: 600;
}
.visits-primary-label i {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: var(--hero-highlight);
}
.visits-primary-value {
  margin: 14px 0 12px;
  color: var(--admin-accent-strong);
  font-size: clamp(38px, 4vw, 52px);
  font-weight: 600;
  line-height: 1.05;
  letter-spacing: -0.045em;
  font-variant-numeric: tabular-nums;
  overflow-wrap: anywhere;
}
.visits-primary-value small {
  margin-left: 10px;
  color: var(--hero-muted);
  font-size: 12px;
  font-weight: 400;
  letter-spacing: 0;
}
.visits-comparison {
  margin: 0;
  color: var(--hero-muted);
  font-size: 12px;
  line-height: 1.6;
}
.visits-hero-metrics {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 16px;
  margin: 26px 0 0;
  padding-top: 20px;
  border-top: 1px solid var(--hero-line);
}
.visits-hero-metrics > div {
  min-width: 0;
}
.visits-hero-metrics dt,
.visits-hero-footer dt {
  color: var(--hero-muted);
  font-size: 11px;
}
.visits-hero-metrics dd {
  margin: 9px 0 5px;
  color: var(--hero-ink);
  font-size: 28px;
  font-weight: 550;
  line-height: 1.1;
  letter-spacing: -0.035em;
  font-variant-numeric: tabular-nums;
  overflow-wrap: anywhere;
}
.visits-hero-metrics dd small,
.visits-hero-footer dd small {
  margin-left: 6px;
  color: var(--hero-muted);
  font-size: 11px;
  font-weight: 400;
  letter-spacing: 0;
}
.visits-hero-metrics p,
.visits-hero-footer p,
.visits-panel-heading p {
  margin: 0;
  color: var(--hero-muted);
  font-size: 10px;
  line-height: 1.6;
}
.visits-hero-visual {
  min-width: 0;
  align-self: center;
}
.visits-hero-chart-heading {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 16px;
  min-height: 40px;
  margin-bottom: 8px;
}
.visits-hero-chart-title h3 {
  margin: 0;
  color: var(--hero-ink);
  font-size: 16px;
  font-weight: 650;
}
.visits-hero-chart-title > span {
  display: block;
  margin-top: 5px;
  color: var(--hero-muted);
  font-size: 10px;
}
.visits-chart-readout {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: 5px 14px;
  max-width: 62%;
  min-height: 20px;
  color: var(--hero-muted);
  font-size: 11px;
  text-align: right;
  flex-wrap: wrap;
}
.visits-chart-readout b {
  color: var(--hero-accent);
  font-weight: 650;
}
.visits-chart-wrap {
  position: relative;
}
.visits-chart {
  display: block;
  width: 100%;
  height: auto;
  max-height: 260px;
  overflow: visible;
}
#visits-area stop:first-child {
  stop-color: var(--hero-accent);
  stop-opacity: 0.22;
}
#visits-area stop:last-child {
  stop-color: var(--hero-accent);
  stop-opacity: 0.025;
}
.visits-chart-line {
  stroke: var(--hero-accent);
}
.visits-chart > g > line {
  stroke: var(--hero-line);
  stroke-opacity: 1;
}
.visits-chart > line {
  stroke: var(--hero-highlight);
  stroke-opacity: 0.65;
}
.visits-chart g[tabindex] circle {
  fill: var(--hero-highlight);
  stroke: var(--hero-paper-strong);
}
.visits-axis {
  fill: var(--hero-muted);
  font: 11px "Segoe UI", "Microsoft YaHei", sans-serif;
}
.visits-chart g[tabindex] {
  cursor: crosshair;
  outline: none;
}
.visits-chart g[tabindex]:focus-visible circle {
  stroke: var(--hero-ink);
  stroke-width: 3;
}
.visits-chart-empty {
  display: grid;
  place-content: center;
  gap: 8px;
  min-height: 240px;
  padding: 32px 16px;
  text-align: center;
}
.visits-chart-empty::before {
  content: "";
  width: 48px;
  height: 26px;
  margin: 0 auto 8px;
  border-bottom: 1px solid var(--hero-line);
  background: linear-gradient(155deg, transparent 47%, #087f6e33 48%, #087f6e33 52%, transparent 53%);
}
.visits-chart-empty strong {
  color: var(--hero-ink);
  font-size: 14px;
  font-weight: 600;
}
.visits-chart-empty span {
  color: var(--hero-muted);
  font-size: 12px;
}
.visits-hero-footer {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  margin: 0;
  border-top: 1px solid var(--hero-line);
  background: var(--admin-panel-muted);
}
.visits-hero-footer > div {
  min-width: 0;
  padding: 19px 30px;
  border-left: 1px solid var(--hero-line);
}
.visits-hero-footer > div:first-child {
  border-left: 0;
}
.visits-hero-footer dd {
  margin: 8px 0 5px;
  color: var(--hero-ink);
  font-size: 24px;
  font-weight: 550;
  line-height: 1.1;
  letter-spacing: -0.03em;
  font-variant-numeric: tabular-nums;
  overflow-wrap: anywhere;
}
.visits-hero-note {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px 20px;
  padding: 13px 30px;
  border-top: 1px solid var(--hero-line);
  color: var(--hero-muted);
  font-size: 10px;
  flex-wrap: wrap;
}
.visits-people-panel {
  overflow: hidden;
  border: 1px solid var(--admin-line);
  border-radius: 10px;
  background: #fff;
}
.visits-panel-heading {
  justify-content: space-between;
  gap: 16px;
}
.visits-panel-heading h3 {
  margin: 0;
  font-size: 16px;
  font-weight: 650;
  letter-spacing: -0.02em;
}
.visits-panel-heading p {
  margin-top: 5px;
  color: var(--admin-muted);
  font-size: 11px;
}
.visits-people-panel .visits-panel-heading {
  padding: 22px 26px 19px;
}
.visits-search {
  display: flex;
  align-items: center;
  gap: 8px;
  min-height: 38px;
  padding: 8px 11px;
  border: 1px solid var(--admin-line-strong);
  border-radius: 6px;
  color: var(--admin-muted);
}
.visits-search input {
  width: 190px;
  max-width: 100%;
  min-width: 0;
  padding: 0;
  border: 0;
  background: transparent;
  color: var(--admin-text);
  font-size: 12px;
}
.visits-table-wrap {
  overflow-x: auto;
}
.visits-table {
  width: 100%;
  border-collapse: collapse;
  font-size: 12px;
  white-space: nowrap;
}
.visits-table th {
  padding: 11px 16px;
  border-block: 1px solid var(--admin-line);
  background: #f7f9f8;
  color: var(--admin-muted);
  font-size: 11px;
  font-weight: 500;
  text-align: left;
}
.visits-table td {
  padding: 16px;
  border-bottom: 1px solid #edf1ef;
  vertical-align: middle;
  font-variant-numeric: tabular-nums;
}
.visits-table tbody tr:last-child td {
  border-bottom: 0;
}
.visits-table th:first-child,
.visits-table td:first-child {
  padding-left: 26px;
}
.visits-table th:last-child,
.visits-table td:last-child {
  padding-right: 26px;
}
.visits-table tbody tr:hover {
  background: #fafcfa;
}
.visits-table .visits-numeric {
  text-align: right;
}
.visits-person strong {
  display: block;
  font-size: 12px;
  font-weight: 600;
}
.visits-person small {
  display: block;
  margin-top: 4px;
  color: var(--admin-muted);
  font-size: 10px;
}
.visits-person-visits strong {
  color: var(--admin-accent-strong);
  font-size: 14px;
  font-weight: 650;
}
.visits-last-date {
  color: var(--admin-text-muted);
  font-size: 11px;
}
.visits-detail {
  min-height: 30px;
  padding: 4px 0;
  border: 0;
  background: transparent;
  color: var(--admin-accent-strong);
  font-size: 11px;
  white-space: nowrap;
}
.visits-detail:not(:disabled):hover {
  text-decoration: underline;
  text-underline-offset: 3px;
}
.visits-table-foot {
  justify-content: space-between;
  gap: 12px;
  padding: 14px 26px;
  border-top: 1px solid var(--admin-line);
  color: var(--admin-muted);
  font-size: 11px;
}
.visits-pagination {
  display: flex;
  align-items: center;
  gap: 12px;
  font-variant-numeric: tabular-nums;
}
.visits-pagination button {
  width: 30px;
  height: 30px;
  border: 1px solid var(--admin-line-strong);
  border-radius: 5px;
  background: #fff;
  color: var(--admin-text-muted);
}
.visits-pagination button:not(:disabled):hover {
  background: var(--admin-panel-muted);
}
.visits-table .visits-table-empty {
  padding: 42px 20px;
  text-align: center;
  white-space: normal;
}
.visits-table-empty strong,
.visits-table-empty span {
  display: block;
}
.visits-table-empty strong {
  font-size: 13px;
  font-weight: 600;
}
.visits-table-empty span {
  margin-top: 6px;
  color: var(--admin-muted);
  font-size: 12px;
}
.visits-notes {
  justify-content: space-between;
  align-items: flex-start;
  gap: 14px 24px;
  padding: 0 2px 10px;
  color: var(--admin-muted);
  font-size: 11px;
  flex-wrap: wrap;
}
.visits-notes details {
  max-width: 700px;
}
.visits-notes summary {
  width: fit-content;
  cursor: pointer;
  color: var(--admin-text-muted);
}
.visits-notes p {
  line-height: 1.9;
}
.visits-notes a {
  color: var(--admin-accent-strong);
  text-decoration: none;
}
.visits-notes a:hover {
  text-decoration: underline;
  text-underline-offset: 3px;
}
.visits-page button:disabled {
  opacity: 0.45;
  cursor: default;
}
.visits-page :is(button, input, select, summary):focus-visible {
  outline: 2px solid #72a68a;
  outline-offset: 3px;
}
.visits-error {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 20px;
  padding: 24px 26px;
  border: 1px solid #ead6d0;
  border-radius: 10px;
  background: #fffaf8;
}
.visits-error strong {
  color: #8e4337;
  font-size: 14px;
}
.visits-error p {
  margin: 6px 0 0;
  color: #875e55;
  font-size: 12px;
}
.visits-loading {
  display: grid;
  gap: 14px;
}
.visits-loading > span {
  color: var(--admin-muted);
  font-size: 12px;
}
.visits-skeleton {
  border: 1px solid var(--admin-line);
  border-radius: 10px;
  background: linear-gradient(110deg, #edf1ef 25%, #f8faf9 45%, #edf1ef 65%);
  background-size: 250% 100%;
  animation: visits-shimmer 1.5s infinite;
}
.visits-skeleton-overview {
  height: 440px;
  border-radius: 16px;
}
.visits-skeleton-chart {
  height: 180px;
}
.visits-sr-only {
  position: absolute;
  width: 1px;
  height: 1px;
  overflow: hidden;
  clip-path: inset(50%);
}
@keyframes visits-shimmer {
  to {
    background-position: -150% 0;
  }
}
@media (max-width: 1180px) {
  .visits-filters {
    align-items: flex-start;
    flex-direction: column;
  }
  .visits-filter-actions {
    width: 100%;
    justify-content: space-between;
  }
  .visits-selectors {
    justify-content: flex-start;
  }
}
@media (max-width: 1000px) {
  .visits-hero-layout {
    grid-template-columns: minmax(0, 1fr);
    gap: 24px;
  }
  .visits-primary {
    padding: 0 0 23px;
    border-right: 0;
    border-bottom: 1px solid var(--hero-line);
  }
  .visits-primary-value {
    margin-block: 12px 9px;
  }
  .visits-hero-metrics {
    max-width: 380px;
    margin-top: 20px;
  }
  .visits-hero-chart-heading {
    margin-bottom: 0;
  }
}
@media (max-width: 800px) {
  .visits-page {
    gap: 18px;
  }
  .visits-periods button,
  .visits-select,
  .visits-refresh,
  .visits-search {
    min-height: 44px;
  }
  .visits-select select,
  .visits-select input,
  .visits-search input {
    font-size: 16px;
  }
}
@media (max-width: 600px) {
  .visits-page {
    gap: 16px;
  }
  .visits-filters {
    gap: 12px;
    padding-bottom: 14px;
  }
  .visits-periods {
    width: 100%;
    padding-bottom: 2px;
    overflow-x: auto;
    scrollbar-width: thin;
  }
  .visits-periods button {
    flex: 0 0 auto;
    padding-inline: 11px;
    font-size: 12px;
  }
  .visits-filter-actions {
    align-items: flex-start;
    gap: 8px;
  }
  .visits-selectors {
    display: grid;
    grid-template-columns: minmax(0, 1fr);
    flex: 1;
    min-width: 0;
  }
  .visits-select,
  .visits-person-select,
  .visits-person-select select {
    width: 100%;
    max-width: 100%;
  }
  .visits-filter-actions > .visits-refresh {
    width: 44px;
    padding: 0;
  }
  .visits-filter-actions > .visits-refresh span {
    display: none;
  }
  .visits-context {
    align-items: flex-start;
    flex-direction: column;
    gap: 7px;
    margin-top: -2px;
    font-size: 11px;
  }
  .visits-date-range {
    gap: 7px;
  }
  .visits-date-range small {
    padding-left: 7px;
  }
  .visits-hero {
    border-radius: 10px;
  }
  .visits-hero-layout {
    gap: 18px;
    padding: 24px 18px 16px;
  }
  .visits-primary-value {
    font-size: 42px;
  }
  .visits-hero-metrics {
    gap: 12px;
    margin-top: 20px;
    padding-top: 17px;
  }
  .visits-hero-metrics dd {
    font-size: 26px;
  }
  .visits-hero-chart-heading {
    flex-direction: column;
    gap: 9px;
  }
  .visits-chart-readout {
    justify-content: flex-start;
    max-width: 100%;
    gap: 5px 12px;
    font-size: 10px;
    text-align: left;
  }
  .visits-chart {
    min-height: 185px;
  }
  .visits-axis {
    font-size: 22px;
  }
  .visits-chart-empty {
    min-height: 210px;
  }
  .visits-hero-footer > div {
    padding: 16px 12px;
  }
  .visits-hero-footer dt {
    font-size: 10px;
  }
  .visits-hero-footer dd {
    font-size: clamp(20px, 6vw, 26px);
  }
  .visits-hero-footer dd small {
    display: block;
    margin: 5px 0 0;
    font-size: 10px;
  }
  .visits-hero-footer p {
    font-size: 10px;
    line-height: 1.5;
  }
  .visits-hero-note {
    align-items: flex-start;
    flex-direction: column;
    gap: 6px;
    padding: 13px 18px;
    line-height: 1.6;
  }
  .visits-panel-heading {
    align-items: flex-start;
    gap: 12px;
  }
  .visits-panel-heading h3 {
    font-size: 15px;
  }
  .visits-people-panel .visits-panel-heading {
    align-items: stretch;
    flex-direction: column;
    padding: 19px 16px 15px;
  }
  .visits-search {
    width: 100%;
  }
  .visits-search input {
    width: 100%;
  }
  .visits-table-wrap {
    overflow: visible;
  }
  .visits-table,
  .visits-table tbody {
    display: block;
  }
  .visits-table thead {
    position: absolute;
    width: 1px;
    height: 1px;
    overflow: hidden;
    clip-path: inset(50%);
  }
  .visits-table tbody tr {
    display: grid;
    grid-template-columns: repeat(4, minmax(0, 1fr));
    gap: 15px 10px;
    padding: 17px 16px;
    border-bottom: 1px solid var(--admin-line);
    white-space: normal;
  }
  .visits-table tbody tr:last-child {
    border-bottom: 0;
  }
  .visits-table td,
  .visits-table th:first-child,
  .visits-table td:first-child,
  .visits-table th:last-child,
  .visits-table td:last-child {
    display: block;
    min-width: 0;
    padding: 0;
    border: 0;
    text-align: left;
  }
  .visits-table td:first-child {
    grid-column: 1 / -1;
  }
  .visits-table td[data-label]::before {
    content: attr(data-label);
    display: block;
    margin-bottom: 6px;
    color: var(--admin-muted);
    font-size: 10px;
    font-weight: 400;
  }
  .visits-person strong {
    font-size: 13px;
  }
  .visits-person small {
    font-size: 11px;
  }
  .visits-person-visits strong {
    font-size: 16px;
  }
  .visits-last-date {
    grid-column: span 3;
    align-self: end;
    font-size: 11px;
    overflow-wrap: anywhere;
  }
  .visits-person-action {
    align-self: end;
    text-align: right !important;
  }
  .visits-detail {
    min-width: 44px;
    min-height: 44px;
    margin: -10px 0 -10px auto;
    font-size: 11px;
  }
  .visits-table .visits-empty-row {
    display: block;
    padding: 0;
  }
  .visits-table .visits-table-empty {
    padding: 38px 18px;
  }
  .visits-table-foot {
    padding: 13px 16px;
    font-size: 10px;
  }
  .visits-pagination {
    gap: 8px;
  }
  .visits-pagination button {
    width: 40px;
    height: 40px;
  }
  .visits-notes {
    align-items: flex-start;
    flex-direction: column;
    gap: 12px;
    font-size: 11px;
    line-height: 1.7;
  }
  .visits-error {
    align-items: flex-start;
    flex-direction: column;
    padding: 20px;
  }
  .visits-error .visits-refresh {
    width: 100%;
  }
  .visits-skeleton-overview {
    height: 600px;
  }
  .visits-skeleton-chart {
    height: 180px;
  }
}
@media (max-width: 360px) {
  .visits-hero-footer > div {
    padding-inline: 9px;
  }
  .visits-hero-footer dd {
    font-size: 20px;
  }
  .visits-table-foot {
    align-items: flex-start;
    flex-direction: column;
  }
  .visits-pagination {
    align-self: flex-end;
  }
}
@media (prefers-reduced-motion: reduce) {
  .visits-skeleton {
    animation: none;
  }
  .visits-periods button {
    transition: none;
  }
}
</style>
