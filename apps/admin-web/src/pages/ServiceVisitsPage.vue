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
const maxPersonVisits = computed(() =>
  Math.max(1, ...(snapshot.value?.people.map((person) => person.visits) ?? [])),
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
    <div class="visits-heading">
      <div>
        <span class="visits-eyebrow">每一次领取，都被看见</span>
        <h2>服务人次，一目了然。</h2>
      </div>
      <button class="visits-button" :disabled="loading" @click="load">
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
        {{ loading ? "更新中" : "刷新数据" }}
      </button>
    </div>

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
      <div class="visits-selectors">
        <label v-if="period === 'year'" class="visits-select"
          ><span>年度</span
          ><select v-model="year" aria-label="选择年度">
            <option v-for="value in availableYears" :key="value" :value="value">
              {{ value }} 年
            </option>
          </select></label
        >
        <label v-if="period === 'month'" class="visits-select"
          ><span>月份</span
          ><input
            v-model="month"
            aria-label="选择月份"
            type="month"
            min="2000-01"
            :max="businessToday.slice(0, 7)"
        /></label>
        <label class="visits-select visits-person-select"
          ><svg
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            stroke-width="1.7"
            aria-hidden="true"
          >
            <circle cx="12" cy="8" r="3.5" />
            <path d="M5 21v-2a7 7 0 0 1 14 0v2" /></svg
          ><select v-model="userId" aria-label="按个人统计">
            <option value="">全部人员</option>
            <option
              v-for="person in personOptions"
              :key="person.userId"
              :value="person.userId"
            >
              {{ person.name }} · {{ person.userId }}
            </option>
          </select></label
        >
      </div>
    </div>

    <div v-if="error" class="visits-error" role="alert">
      <strong>暂时无法获取统计</strong>
      <p>{{ error }}</p>
      <button class="visits-button" @click="load">重新加载</button>
    </div>
    <div v-else-if="loading" class="visits-loading" role="status">
      <div class="visits-skeleton"></div>
      <div class="visits-skeleton"></div>
      <div class="visits-skeleton"></div>
      <span>正在汇总领取记录…</span>
    </div>

    <template v-else-if="snapshot">
      <div class="visits-context" aria-live="polite">
        <span
          ><i></i>{{ scopeLabel
          }}<button v-if="userId" @click="userId = ''">
            返回全部人员 ×
          </button></span
        ><span
          >{{ snapshot.startDate }} <span class="visits-date-separator">—</span>
          {{ snapshot.endDate
          }}<small v-if="period === 'recent-month'">近 30 个业务日</small
          ><small v-else-if="period === 'recent-year'"
            >近 365 个业务日</small
          ></span
        >
      </div>

      <div class="visits-summary">
        <article class="visits-lifetime">
          <div class="visits-lifetime-top">
            <span>{{ userId ? "个人累计服务人次" : "累计服务人次" }}</span
            ><svg
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              stroke-width="1.5"
              aria-hidden="true"
            >
              <path d="M4 16l5-5 4 3 7-9M15 5h5v5" />
            </svg>
          </div>
          <div class="visits-lifetime-value">
            {{ number(snapshot.lifetime.visits) }}<span>人次</span>
          </div>
          <p>自首条有效记录起 · 全部历史累计</p>
          <div class="visits-lifetime-bottom">
            <span
              >覆盖
              <b>{{ number(snapshot.lifetime.people) }}</b> 位领取人员</span
            ><span class="visits-lifetime-symbol" aria-hidden="true">↗</span>
          </div>
        </article>
        <article class="visits-metric visits-metric-primary">
          <span class="visits-metric-label"
            >{{ periodLabel }}<span class="visits-mini-tag">人次</span></span
          >
          <div class="visits-metric-value">
            {{ number(snapshot.summary.visits) }}<small>次</small>
          </div>
          <p
            :title="
              snapshot.previous
                ? `${snapshot.previous.startDate} 至 ${snapshot.previous.endDate}：${snapshot.previous.visits} 人次`
                : undefined
            "
          >
            {{ comparison }}
          </p>
          <span class="visits-metric-note">每次实际领取计 1 人次</span>
        </article>
        <article class="visits-metric">
          <span class="visits-metric-label"
            >服务人数<svg
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              stroke-width="1.5"
              aria-hidden="true"
            >
              <circle cx="9" cy="8" r="3" />
              <path
                d="M3 20v-2a6 6 0 0 1 12 0v2M17 5a3 3 0 0 1 0 6m1 3a5 5 0 0 1 3 4v2"
              /></svg
          ></span>
          <div class="visits-metric-value">
            {{ number(snapshot.summary.people) }}<small>人</small>
          </div>
          <p>所选时段内去重统计</p>
          <span class="visits-metric-note">同一个人仅计 1 位</span>
        </article>
        <article class="visits-metric">
          <span class="visits-metric-label"
            >领取物资<svg
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              stroke-width="1.5"
              aria-hidden="true"
            >
              <path
                d="M12 3L3 8v9l9 5 9-5V8L12 3ZM3 8l9 5 9-5M12 13v9M7.5 5.5l9 5"
              /></svg
          ></span>
          <div class="visits-metric-value">
            {{ number(snapshot.summary.units) }}<small>件</small>
          </div>
          <p>已抵减退回物资</p>
          <span class="visits-metric-note">本期实际领取总件数</span>
        </article>
      </div>

      <article class="visits-chart-panel">
        <div class="visits-panel-heading">
          <div>
            <span class="visits-eyebrow">服务趋势</span>
            <h3>每一份服务的日常</h3>
          </div>
          <span class="visits-chart-legend"
            ><i></i>领取人次
            <span
              >· 按{{
                snapshot.grain === "day"
                  ? "日"
                  : snapshot.grain === "month"
                    ? "月"
                    : "年"
              }}汇总</span
            ></span
          >
        </div>
        <div class="visits-chart-readout" aria-live="polite">
          <template v-if="activePoint"
            ><b>{{ activePoint.label }}</b
            ><span>{{ number(activePoint.visits) }} 人次</span
            ><span
              >{{ number(activePoint.people) }} 人 ·
              {{ number(activePoint.units) }} 件</span
            ></template
          ><template v-else
            ><span
              >日均 <b>{{ number(average) }}</b> 人次</span
            ><span
              >有领取的业务日 <b>{{ snapshot.summary.activeDays }}</b> 天</span
            ><span v-if="peak && peak.visits"
              >峰值 <b>{{ peak.label }}</b> · {{ peak.visits }} 人次</span
            ></template
          >
        </div>
        <div class="visits-chart-wrap">
          <svg
            class="visits-chart"
            viewBox="0 0 800 264"
            role="group"
            aria-label="领取人次趋势图，可聚焦数据点查看具体数值"
          >
            <defs>
              <linearGradient id="visits-area" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stop-color="#2b8b70" stop-opacity=".19" />
                <stop offset="100%" stop-color="#2b8b70" stop-opacity=".01" />
              </linearGradient>
            </defs>
            <g v-for="tick in 5" :key="tick">
              <line
                x1="52"
                x2="770"
                :y1="48 + (tick - 1) * 43"
                :y2="48 + (tick - 1) * 43"
                stroke="#e7edea"
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
              :points="chartLine"
              fill="none"
              stroke="#278269"
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
              stroke="#85b7a7"
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
                fill="#278269"
                stroke="white"
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
          <div v-if="!snapshot.summary.visits" class="visits-chart-empty">
            <strong>这段时间，还没有领取记录</strong
            ><span>可切换月份或查看全部累计。</span>
          </div>
        </div>
        <div class="visits-chart-foot">
          <span>同一次领取多件物资，仅计 1 人次；未领取的日期保留为 0。</span
          ><span v-if="snapshot.previous"
            >对比周期 {{ snapshot.previous.startDate }} —
            {{ snapshot.previous.endDate }}</span
          >
        </div>
      </article>

      <article class="visits-people-panel">
        <div class="visits-panel-heading">
          <div>
            <span class="visits-eyebrow">落实到每一个人</span>
            <h3>
              个人服务统计
              <span class="visits-count">{{ snapshot.people.length }}</span>
            </h3>
          </div>
          <label class="visits-search"
            ><svg
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              stroke-width="1.7"
              aria-hidden="true"
            >
              <circle cx="10.5" cy="10.5" r="6.5" />
              <path d="m16 16 5 5" /></svg
            ><input
              v-model="search"
              type="search"
              aria-label="搜索姓名、人员编号或社区"
              placeholder="搜索姓名、编号或社区"
          /></label>
        </div>
        <p class="visits-mobile-hint">左右滑动，查看完整个人明细</p>
        <div class="visits-table-wrap">
          <table class="visits-table">
            <caption class="visits-sr-only">
              {{
                snapshot.startDate
              }}
              至
              {{
                snapshot.endDate
              }}
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
              <tr
                v-for="(person, index) in displayedPeople"
                :key="person.userId"
              >
                <td>
                  <div class="visits-person">
                    <span
                      class="visits-avatar"
                      :class="`visits-avatar-${index % 3}`"
                      >{{ person.name.slice(0, 1) }}</span
                    ><span
                      ><strong>{{ person.name }}</strong
                      ><small
                        >{{ person.neighborhood }} · {{ person.userId }}</small
                      ></span
                    >
                  </div>
                </td>
                <td>
                  <div class="visits-person-total">
                    <b>{{ number(person.visits) }}</b
                    ><span class="visits-bar"
                      ><i
                        :style="{
                          width: `${(person.visits / maxPersonVisits) * 100}%`,
                        }"
                      ></i
                    ></span>
                  </div>
                </td>
                <td class="visits-numeric">
                  {{ number(person.lifetimeVisits) }}
                </td>
                <td class="visits-numeric">{{ number(person.units) }}</td>
                <td class="visits-numeric">{{ person.activeDays }}</td>
                <td class="visits-last-date">
                  {{ formatDateTime(person.lastPickupAt) }}
                </td>
                <td>
                  <button
                    class="visits-detail"
                    :aria-label="`查看${person.name}的个人统计`"
                    :disabled="userId === person.userId"
                    @click="userId = person.userId"
                  >
                    {{ userId === person.userId ? "当前人员" : "查看趋势"
                    }}<span aria-hidden="true"> ↗</span>
                  </button>
                </td>
              </tr>
              <tr v-if="!displayedPeople.length">
                <td colspan="7" class="visits-table-empty">
                  {{
                    search
                      ? "没有匹配的人员，试试其他姓名或社区。"
                      : "暂无领取人员，产生领取记录后将在这里显示。"
                  }}
                </td>
              </tr>
            </tbody>
          </table>
        </div>
        <div class="visits-table-foot">
          <span>共 {{ filteredPeople.length }} 人 · 按本期领取人次排序</span>
          <div class="visits-pagination">
            <button :disabled="page <= 1" aria-label="上一页" @click="page--">
              ←</button
            ><span>{{ page }} / {{ pageCount }}</span
            ><button
              :disabled="page >= pageCount"
              aria-label="下一页"
              @click="page++"
            >
              →
            </button>
          </div>
        </div>
      </article>

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
            本期有
            {{
              snapshot.legacyVisitCount
            }}
            次历史记录缺少订单/开柜编号，按人员、柜机及完全相同的领取时间合并，无法追溯更细的订单边界。
          </p>
        </details>
        <span
          >更新于 {{ formatDateTime(snapshot.generatedAt) }} ·
          <RouterLink to="/data-monitor">查看按日运营数据 ↗</RouterLink></span
        >
      </footer>
    </template>
  </section>
</template>

<style scoped>
.visits-page {
  --visit-green: #216e56;
  --visit-muted: #63736d;
  display: grid;
  gap: 22px;
  color: #233a30;
}
.visits-heading,
.visits-panel-heading,
.visits-context,
.visits-table-foot,
.visits-notes {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 16px;
}
.visits-heading h2 {
  margin: 7px 0 0;
  font-size: 23px;
  font-weight: 600;
  letter-spacing: -0.7px;
}
.visits-eyebrow {
  font-size: 11px;
  font-weight: 600;
  letter-spacing: 1.5px;
  color: var(--visit-muted);
}
.visits-button {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
  padding: 10px 15px;
  border: 1px solid #d9e2dd;
  background: white;
  color: #37564a;
  border-radius: 8px;
  white-space: nowrap;
}
.visits-page svg:not(.visits-chart) {
  width: 19px;
  height: 19px;
  flex-shrink: 0;
}
.visits-filters {
  display: flex;
  flex-wrap: wrap;
  justify-content: space-between;
  gap: 12px;
  padding: 14px;
  background: #fff;
  border: 1px solid #dfe7e2;
  border-radius: 12px;
}
.visits-periods {
  display: flex;
  gap: 3px;
  padding: 3px;
  border-radius: 8px;
  background: #f1f4f2;
}
.visits-periods button {
  border: 0;
  padding: 9px 13px;
  border-radius: 6px;
  background: transparent;
  color: #60736a;
  font-size: 12px;
  white-space: nowrap;
  transition:
    background 0.18s,
    color 0.18s;
}
.visits-periods button.selected {
  background: #fff;
  color: #205d48;
  box-shadow: 0 1px 5px #183b2412;
  font-weight: 700;
}
.visits-selectors {
  display: flex;
  flex-wrap: wrap;
  gap: 10px;
}
.visits-select {
  display: flex;
  align-items: center;
  gap: 8px;
  border: 1px solid #dce5df;
  border-radius: 7px;
  padding: 0 10px;
  font-size: 12px;
  color: #65756b;
  min-height: 40px;
}
.visits-select select,
.visits-select input {
  border: 0;
  background: transparent;
  color: #304b3e;
  padding: 7px 2px;
  min-width: 0;
  max-width: 215px;
}
.visits-context {
  font-size: 12px;
  color: #52695c;
  margin: -4px 2px;
  flex-wrap: wrap;
}
.visits-context > span {
  display: flex;
  gap: 10px;
  align-items: center;
  flex-wrap: wrap;
}
.visits-context i,
.visits-chart-legend i {
  display: inline-block;
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: #2c8668;
}
.visits-context button {
  border: 0;
  border-bottom: 1px solid #9cbaad;
  color: #2c6c51;
  background: transparent;
  font-size: 11px;
  padding: 0;
}
.visits-context small {
  background: #e8eee9;
  color: #52685b;
  border-radius: 4px;
  padding: 3px 7px;
  font-size: 10px;
}
.visits-date-separator {
  color: #8ca394;
}
.visits-summary {
  display: grid;
  grid-template-columns: 1.28fr repeat(3, 1fr);
  gap: 14px;
}
.visits-lifetime,
.visits-metric {
  padding: 24px 22px 20px;
  border-radius: 12px;
  min-width: 0;
}
.visits-lifetime {
  position: relative;
  overflow: hidden;
  color: #f0f9f2;
  background: #1d4e3c;
  border: 1px solid #1d4e3c;
}
.visits-lifetime::after {
  content: "";
  position: absolute;
  width: 200px;
  height: 200px;
  border: 1px solid #c0dbbd18;
  border-radius: 50%;
  right: -100px;
  top: 20px;
  box-shadow:
    0 0 0 28px #c0dbbd08,
    0 0 0 56px #c0dbbd06;
  pointer-events: none;
}
.visits-lifetime-top,
.visits-metric-label {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 8px;
  font-size: 12px;
}
.visits-lifetime-top {
  color: #d1e4d7;
}
.visits-lifetime-value {
  position: relative;
  z-index: 1;
  font:
    500 clamp(32px, 3.8vw, 49px)/1.1 "Segoe UI",
    sans-serif;
  font-variant-numeric: tabular-nums;
  letter-spacing: -1.8px;
  margin: 22px 0 9px;
  overflow-wrap: anywhere;
}
.visits-lifetime-value span {
  font:
    12px "Microsoft YaHei",
    sans-serif;
  margin-left: 9px;
  letter-spacing: 0;
  color: #d0e2d4;
}
.visits-lifetime p {
  font-size: 10px;
  color: #bfd3c5;
  margin: 0;
}
.visits-lifetime-bottom {
  display: flex;
  justify-content: space-between;
  align-items: center;
  font-size: 11px;
  margin-top: 21px;
  border-top: 1px solid #cde5d327;
  padding-top: 13px;
  color: #d4e8da;
}
.visits-lifetime-bottom b {
  font-weight: 600;
  color: #fff;
}
.visits-lifetime-symbol {
  color: #c3daa4;
  font-size: 20px;
  line-height: 1;
}
.visits-metric {
  background: white;
  border: 1px solid #dfe6e1;
}
.visits-metric-primary {
  background: #f7faf6;
  border-color: #cfdecf;
}
.visits-metric-label {
  color: #51685a;
}
.visits-metric-label svg {
  opacity: 0.7;
}
.visits-mini-tag {
  font-size: 9px;
  color: #4e7054;
  background: #e6efdf;
  padding: 3px 6px;
  border-radius: 4px;
}
.visits-metric-value {
  font:
    500 clamp(27px, 3vw, 38px)/1.1 "Segoe UI",
    sans-serif;
  font-variant-numeric: tabular-nums;
  letter-spacing: -1.2px;
  margin: 24px 0 13px;
  overflow-wrap: anywhere;
}
.visits-metric-value small {
  font:
    11px "Microsoft YaHei",
    sans-serif;
  margin-left: 7px;
  color: #738275;
}
.visits-metric p {
  font-size: 10px;
  color: #4e7258;
  margin: 0;
  min-height: 28px;
}
.visits-metric-note {
  display: block;
  margin-top: 20px;
  font-size: 10px;
  color: #6a786d;
  border-top: 1px solid #edf0ed;
  padding-top: 13px;
}
.visits-chart-panel,
.visits-people-panel {
  background: #fff;
  border: 1px solid #dfe7e2;
  border-radius: 12px;
  overflow: hidden;
}
.visits-chart-panel {
  padding: 24px 26px 0;
}
.visits-panel-heading h3 {
  font-size: 18px;
  margin: 7px 0 0;
  font-weight: 600;
  letter-spacing: -0.4px;
}
.visits-chart-legend {
  display: flex;
  gap: 8px;
  align-items: center;
  font-size: 11px;
  color: #466650;
}
.visits-chart-legend > span {
  color: #79847a;
}
.visits-chart-readout {
  display: flex;
  gap: 22px;
  align-items: center;
  flex-wrap: wrap;
  margin-top: 20px;
  font-size: 11px;
  color: #6b7c70;
  min-height: 20px;
}
.visits-chart-readout b {
  color: #294e3a;
  font-weight: 600;
  margin: 0 3px;
}
.visits-chart-wrap {
  position: relative;
}
.visits-chart {
  display: block;
  width: 100%;
  height: auto;
  max-height: 325px;
  overflow: visible;
}
.visits-axis {
  font:
    11px "Segoe UI",
    "Microsoft YaHei",
    sans-serif;
  fill: #6b7a70;
}
.visits-chart g[tabindex] {
  cursor: crosshair;
  outline: none;
}
.visits-chart g[tabindex]:focus-visible circle {
  stroke: #132d20;
  stroke-width: 3;
}
.visits-chart-empty {
  position: absolute;
  left: 50%;
  top: 45%;
  transform: translate(-50%, -50%);
  text-align: center;
  display: grid;
  gap: 7px;
  padding: 17px 25px;
  border: 1px solid #e5ece5;
  border-radius: 9px;
  background: #fffffff2;
  width: max-content;
  max-width: 95%;
  font-size: 12px;
  color: #798679;
  pointer-events: none;
}
.visits-chart-empty strong {
  font-size: 13px;
  color: #526958;
  font-weight: 500;
}
.visits-chart-foot {
  display: flex;
  justify-content: space-between;
  gap: 10px;
  flex-wrap: wrap;
  border-top: 1px solid #edf1ed;
  padding: 14px 0;
  font-size: 10px;
  color: #748174;
}
.visits-people-panel .visits-panel-heading {
  padding: 24px 26px 20px;
}
.visits-count {
  font-size: 11px;
  vertical-align: middle;
  background: #edf2ec;
  color: #5d745c;
  padding: 3px 7px;
  border-radius: 5px;
  margin-left: 6px;
}
.visits-search {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 9px 12px;
  border: 1px solid #e1e8e1;
  border-radius: 7px;
  color: #829082;
}
.visits-search input {
  width: 175px;
  max-width: 100%;
  min-width: 0;
  border: 0;
  background: transparent;
  font-size: 11px;
  color: #3f5a46;
}
.visits-table-wrap {
  position: relative;
  overflow-x: auto;
}
.visits-mobile-hint {
  display: none;
}
.visits-table {
  width: 100%;
  border-collapse: collapse;
  font-size: 12px;
  white-space: nowrap;
}
.visits-table th {
  color: #6d7d70;
  font-size: 10px;
  font-weight: 500;
  background: #f7f9f6;
  text-align: left;
  padding: 12px 16px;
  border-block: 1px solid #eaf0e8;
}
.visits-table td {
  padding: 17px 16px;
  border-bottom: 1px solid #eef2ed;
  font-variant-numeric: tabular-nums;
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
  background: #fafcf9;
}
.visits-table .visits-numeric {
  text-align: right;
}
.visits-person {
  display: flex;
  align-items: center;
  gap: 10px;
}
.visits-person strong {
  display: block;
  font-weight: 500;
  font-size: 12px;
}
.visits-person small {
  display: block;
  font-size: 9px;
  color: #7a887c;
  margin-top: 4px;
}
.visits-avatar {
  width: 33px;
  height: 33px;
  display: grid;
  place-items: center;
  border-radius: 50%;
  background: #eaf1e8;
  color: #637d51;
  font-size: 12px;
}
.visits-avatar-1 {
  background: #f5ede0;
  color: #95784d;
}
.visits-avatar-2 {
  background: #e9eef2;
  color: #58768c;
}
.visits-person-total {
  display: flex;
  align-items: center;
  gap: 12px;
  min-width: 85px;
}
.visits-person-total b {
  font-weight: 600;
  min-width: 18px;
  color: #2f5d41;
}
.visits-bar {
  width: 55px;
  height: 4px;
  border-radius: 4px;
  background: #edf2eb;
  overflow: hidden;
}
.visits-bar i {
  display: block;
  height: 100%;
  background: #8eaf81;
  border-radius: inherit;
}
.visits-last-date {
  color: #6c7f71;
  font-size: 10px;
}
.visits-detail {
  border: 0;
  padding: 5px 0;
  background: transparent;
  color: #417454;
  font-size: 10px;
}
.visits-table-foot {
  padding: 15px 26px;
  color: #768577;
  font-size: 10px;
}
.visits-pagination {
  display: flex;
  align-items: center;
  gap: 14px;
}
.visits-pagination button {
  border: 1px solid #dfe8dd;
  border-radius: 5px;
  background: white;
  color: #5c765c;
  width: 28px;
  height: 27px;
}
.visits-table .visits-table-empty {
  text-align: center;
  color: #738575;
  padding: 40px 20px;
}
.visits-notes {
  align-items: flex-start;
  color: #6e7f71;
  font-size: 10px;
  padding: 0 3px 12px;
  flex-wrap: wrap;
}
.visits-notes details {
  max-width: 630px;
}
.visits-notes summary {
  cursor: pointer;
  width: fit-content;
}
.visits-notes p {
  line-height: 1.9;
}
.visits-notes a {
  color: #416c50;
  text-decoration: none;
}
.visits-page button:disabled {
  opacity: 0.45;
  cursor: default;
}
.visits-page button:not(:disabled):hover {
  filter: brightness(0.96);
}
.visits-page :is(button, input, select, summary):focus-visible {
  outline: 2px solid #72a68a;
  outline-offset: 3px;
}
.visits-error {
  padding: 36px;
  border-radius: 12px;
  background: #fff6f3;
  border: 1px solid #edc9be;
  color: #914d37;
}
.visits-loading {
  display: grid;
  grid-template-columns: 1.3fr 1fr 1fr;
  gap: 16px;
  padding-bottom: 220px;
}
.visits-loading > span {
  grid-column: 1 / -1;
  color: #788a7a;
  font-size: 12px;
}
.visits-skeleton {
  height: 210px;
  border-radius: 12px;
  background: linear-gradient(110deg, #e7eee7 25%, #f8faf6 45%, #e7eee7 65%);
  background-size: 250% 100%;
  animation: visits-shimmer 1.5s infinite;
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
@media (max-width: 1350px) {
  .visits-summary {
    gap: 10px;
  }
  .visits-lifetime,
  .visits-metric {
    padding: 21px 16px 17px;
  }
}
@media (max-width: 900px) {
  .visits-summary {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }
  .visits-heading h2 {
    font-size: 19px;
  }
  .visits-chart-foot {
    flex-direction: column;
  }
}
@media (max-width: 600px) {
  .visits-page {
    gap: 16px;
  }
  .visits-heading {
    align-items: flex-start;
  }
  .visits-heading h2 {
    font-size: 16px;
    line-height: 1.6;
    max-width: 220px;
  }
  .visits-heading .visits-button {
    font-size: 11px;
    padding: 9px;
  }
  .visits-eyebrow {
    font-size: 9px;
  }
  .visits-filters {
    padding: 9px;
  }
  .visits-periods {
    width: 100%;
    overflow-x: auto;
  }
  .visits-periods button {
    flex: 1;
    font-size: 10px;
    padding: 9px 7px;
  }
  .visits-selectors {
    width: 100%;
  }
  .visits-person-select {
    flex: 1;
    min-width: 0;
  }
  .visits-person-select select {
    width: 100%;
    max-width: 100%;
  }
  .visits-context {
    font-size: 10px;
  }
  .visits-lifetime,
  .visits-metric {
    padding: 18px 14px 15px;
  }
  .visits-lifetime-value {
    font-size: 34px;
  }
  .visits-metric-value {
    font-size: 30px;
  }
  .visits-metric-label {
    font-size: 11px;
  }
  .visits-chart-panel {
    padding: 20px 14px 0;
  }
  .visits-panel-heading {
    align-items: flex-start;
    flex-wrap: wrap;
  }
  .visits-panel-heading h3 {
    font-size: 16px;
  }
  .visits-chart-readout {
    gap: 10px;
    font-size: 10px;
  }
  .visits-chart {
    min-height: 180px;
  }
  .visits-people-panel .visits-panel-heading {
    padding: 20px 16px 16px;
  }
  .visits-search {
    width: 100%;
  }
  .visits-search input {
    width: 100%;
  }
  .visits-table-foot {
    padding: 13px 16px;
  }
  .visits-loading {
    grid-template-columns: 1fr 1fr;
  }
  .visits-skeleton:last-of-type {
    display: none;
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
@media (max-width: 600px) {
  .visits-axis {
    font-size: 22px;
  }
  .visits-mobile-hint {
    display: block;
    font-size: 10px;
    color: #6e7f71;
    margin: 0 16px 12px;
  }
}
</style>
