<script setup lang="ts">
import { computed, onMounted, ref, watch } from "vue";
import type { ServiceVisitDaySnapshot } from "@vm/shared-types";
import { adminApi } from "../api/admin";
import { formatDateTime } from "../utils/datetime";
import { getAdminErrorMessage } from "../utils/error-message";

const props = defineProps<{ userId: string; personName: string }>();
const snapshot = ref<ServiceVisitDaySnapshot>();
const selectedDate = ref("");
const loading = ref(false);
const error = ref("");
let requestVersion = 0;

const currentMonthTitle = computed(() => {
  const source = snapshot.value?.monthKey ?? selectedDate.value.slice(0, 7);
  if (!source) return "选择月份";
  const [year, month] = source.split("-");
  return `${year}年 ${month}月`;
});
const canPreviousMonth = computed(
  () => (snapshot.value?.monthKey ?? selectedDate.value.slice(0, 7)) > "2000-01",
);
const canNextMonth = computed(
  () =>
    (snapshot.value?.monthKey ?? selectedDate.value.slice(0, 7)) <
    (snapshot.value?.today ?? selectedDate.value).slice(0, 7),
);
const activityLevel = (visits: number) =>
  visits <= 0 ? "none" : visits === 1 ? "light" : visits <= 3 ? "medium" : "high";
const load = async (resetDate = false) => {
  const version = ++requestVersion;
  if (resetDate) selectedDate.value = "";
  loading.value = true;
  error.value = "";
  try {
    const data = await adminApi.serviceVisitDay({
      userId: props.userId,
      date: selectedDate.value || undefined,
    });
    if (version !== requestVersion) return;
    snapshot.value = data;
    selectedDate.value = data.date;
  } catch (reason) {
    if (version === requestVersion)
      error.value = getAdminErrorMessage(reason, "领取明细暂时无法加载，请重试。");
  } finally {
    if (version === requestVersion) loading.value = false;
  }
};
const selectDate = (dateKey: string) => {
  selectedDate.value = dateKey;
  void load();
};
const changeMonth = (offset: number) => {
  const source = snapshot.value?.monthKey ?? selectedDate.value.slice(0, 7);
  const [year, month] = source.split("-").map(Number);
  const next = new Date(year, month - 1 + offset, 1);
  const nextMonth = `${next.getFullYear()}-${String(next.getMonth() + 1).padStart(2, "0")}`;
  selectedDate.value = `${nextMonth}-01`;
  void load();
};
watch(() => props.userId, () => void load(true));
onMounted(() => void load(true));
</script>

<template>
  <section class="day-panel" :aria-busy="loading" aria-label="个人单日领取明细">
    <div class="day-panel__heading">
      <div>
        <span class="admin-kicker">按日查看</span>
        <h3>{{ personName }}的领取明细</h3>
      </div>
      <span v-if="snapshot" class="day-panel__summary">
        {{ snapshot.summary.visits }} 人次 · {{ snapshot.summary.units }} 件
      </span>
    </div>

    <div v-if="error" class="day-error" role="alert">
      <div><strong>暂时无法获取领取明细</strong><p>{{ error }}</p></div>
      <button class="admin-button admin-button--ghost" @click="load()">重新加载</button>
    </div>
    <div v-else-if="loading && !snapshot" class="day-loading" role="status">
      正在查询个人领取明细…
    </div>

    <template v-else-if="snapshot">
      <p v-if="loading" class="day-updating" role="status">正在更新日期…</p>
      <div class="day-layout">
        <article class="admin-panel admin-panel-block day-calendar-panel">
          <div class="admin-panel__head">
            <div>
              <span class="admin-kicker">日期选择</span>
              <h4 class="admin-panel__title">选择业务日</h4>
            </div>
            <div class="admin-toolbar">
              <button class="admin-button admin-button--ghost" :disabled="loading || !canPreviousMonth" @click="changeMonth(-1)">上月</button>
              <span class="admin-code">{{ currentMonthTitle }}</span>
              <button class="admin-button admin-button--ghost" :disabled="loading || !canNextMonth" @click="changeMonth(1)">下月</button>
            </div>
          </div>
          <div class="day-calendar">
            <div v-for="weekday in ['周一', '周二', '周三', '周四', '周五', '周六', '周日']" :key="weekday" class="day-calendar__weekday">
              {{ weekday }}
            </div>
            <button
              v-for="day in snapshot.days"
              :key="day.dateKey"
              class="day-calendar__day"
              :class="[
                day.inCurrentMonth ? '' : 'day-calendar__day--muted',
                day.dateKey === snapshot.date ? 'day-calendar__day--selected' : '',
                `day-calendar__day--${activityLevel(day.visits)}`
              ]"
              :aria-pressed="day.dateKey === snapshot.date"
              :aria-label="`${day.dateKey}，${day.visits} 人次，${day.units} 件`"
              @click="selectDate(day.dateKey)"
            >
              <span>{{ day.day }}</span>
              <span v-if="day.visits" class="day-calendar__marker" :class="`day-calendar__marker--${activityLevel(day.visits)}`"></span>
            </button>
          </div>
          <p class="day-calendar__note">圆点表示有实际领取，颜色深浅表示人次多少。</p>
        </article>

        <article class="admin-panel admin-panel-block day-records-panel">
          <div class="admin-panel__head">
            <div>
              <span class="admin-kicker">领取明细</span>
              <h4 class="admin-panel__title">{{ snapshot.date }}</h4>
            </div>
            <span class="day-records-panel__total">{{ snapshot.summary.visits }} 人次 · {{ snapshot.summary.units }} 件</span>
          </div>
          <ol v-if="snapshot.visits.length" class="day-record-list">
            <li v-for="(visit, index) in snapshot.visits" :key="visit.key" class="day-record">
              <div class="day-record__heading">
                <div>
                  <strong>第 {{ index + 1 }} 次领取</strong>
                  <span>{{ formatDateTime(visit.happenedAt) }}</span>
                </div>
                <b>{{ visit.units }} 件</b>
              </div>
              <p class="day-record__device">{{ visit.deviceName }} · {{ visit.deviceCode }}</p>
              <ul class="day-record__goods">
                <li v-for="goods in visit.goods" :key="goods.goodsId">
                  <span>{{ goods.name }}</span>
                  <span class="day-record__quantity">
                    <strong>{{ goods.quantity }} 件</strong>
                    <small v-if="goods.returnedQuantity">已抵减退回 {{ goods.returnedQuantity }} 件</small>
                  </span>
                </li>
              </ul>
            </li>
          </ol>
          <div v-else class="day-empty">
            <strong>这一天没有领取记录</strong>
            <p>选择月历中带圆点的日期，可查看该人员的实际领取明细。</p>
          </div>
        </article>
      </div>
      <p class="day-note">
        每次实际领取计 1 人次，同次多件商品不重复计次；退回数量已抵减。按业务日归属（UTC{{ snapshot.timezoneOffsetHours >= 0 ? "+" : "" }}{{ snapshot.timezoneOffsetHours }}，每日 {{ String(snapshot.businessDayStartHour).padStart(2, "0") }}:00 起算）。
      </p>
      <p v-if="snapshot.legacyVisitCount" class="day-note">
        当日有 {{ snapshot.legacyVisitCount }} 次历史记录缺少订单或开柜编号，按人员、柜机及完全相同的领取时间归并。
      </p>
    </template>
  </section>
</template>

<style scoped>
.day-panel {
  display: grid;
  gap: 16px;
  scroll-margin-top: 84px;
}
.day-panel__heading {
  display: flex;
  align-items: end;
  justify-content: space-between;
  gap: 16px;
}
.day-panel__heading h3 {
  margin: 5px 0 0;
  font-size: 16px;
  font-weight: 650;
}
.day-panel__summary,
.day-records-panel__total {
  color: var(--admin-accent-strong);
  font-size: 12px;
  font-weight: 600;
  white-space: nowrap;
}
.day-layout {
  display: grid;
  grid-template-columns: minmax(340px, 0.9fr) minmax(0, 1.2fr);
  gap: 16px;
  align-items: start;
}
.day-calendar-panel,
.day-records-panel {
  min-width: 0;
}
.day-calendar-panel .admin-panel__head,
.day-records-panel .admin-panel__head {
  align-items: center;
}
.day-calendar {
  display: grid;
  grid-template-columns: repeat(7, minmax(0, 1fr));
  gap: 6px;
}
.day-calendar__weekday {
  padding: 5px 2px;
  color: var(--admin-muted);
  font-size: 11px;
  text-align: center;
}
.day-calendar__day {
  display: grid;
  place-items: center;
  align-content: center;
  gap: 7px;
  min-width: 0;
  min-height: 56px;
  padding: 5px 2px;
  border: 1px solid var(--admin-line);
  border-radius: 8px;
  background: var(--admin-panel);
  color: var(--admin-text);
  font-size: 12px;
}
.day-calendar__day:hover {
  border-color: var(--admin-line-strong);
  background: var(--admin-panel-muted);
}
.day-calendar__day--muted {
  color: #98a4b3;
  background: var(--admin-panel-muted);
}
.day-calendar__day--selected {
  border-color: var(--admin-accent);
  background: var(--admin-accent-soft);
  color: var(--admin-accent-strong);
  font-weight: 650;
}
.day-calendar__marker {
  width: 8px;
  height: 8px;
  border-radius: 50%;
}
.day-calendar__marker--light {
  background: #9bb3d7;
}
.day-calendar__marker--medium {
  background: #587fc0;
}
.day-calendar__marker--high {
  background: var(--admin-accent-strong);
}
.day-calendar__note,
.day-note,
.day-updating {
  margin: 12px 0 0;
  color: var(--admin-muted);
  font-size: 11px;
  line-height: 1.7;
}
.day-updating {
  margin: 0;
}
.day-record-list {
  display: grid;
  gap: 12px;
  margin: 0;
  padding: 0;
  list-style: none;
}
.day-record {
  padding: 14px;
  border: 1px solid var(--admin-line);
  border-radius: 8px;
  background: var(--admin-panel-strong);
}
.day-record__heading {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 12px;
}
.day-record__heading strong {
  display: block;
  font-size: 13px;
}
.day-record__heading span {
  display: block;
  margin-top: 4px;
  color: var(--admin-muted);
  font-size: 11px;
}
.day-record__heading b {
  color: var(--admin-accent-strong);
  font-size: 14px;
  white-space: nowrap;
}
.day-record__device {
  margin: 10px 0 0;
  color: var(--admin-text-muted);
  font-size: 11px;
}
.day-record__goods {
  display: grid;
  gap: 8px;
  margin: 12px 0 0;
  padding: 10px 0 0;
  border-top: 1px solid var(--admin-line);
  list-style: none;
}
.day-record__goods li,
.day-record__quantity {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  font-size: 12px;
}
.day-record__quantity {
  flex-shrink: 0;
  justify-content: flex-end;
}
.day-record__quantity small {
  color: var(--admin-muted);
  font-size: 10px;
}
.day-empty {
  display: grid;
  place-content: center;
  min-height: 230px;
  padding: 24px;
  border: 1px dashed var(--admin-line-strong);
  border-radius: 8px;
  text-align: center;
}
.day-empty strong {
  font-size: 13px;
}
.day-empty p {
  margin: 7px 0 0;
  color: var(--admin-muted);
  font-size: 11px;
  line-height: 1.7;
}
.day-error {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  padding: 18px;
  border: 1px solid #ead6d0;
  border-radius: 8px;
  background: #fffaf8;
}
.day-error strong {
  color: #8e4337;
  font-size: 13px;
}
.day-error p {
  margin: 5px 0 0;
  color: #875e55;
  font-size: 11px;
}
.day-loading {
  display: grid;
  place-items: center;
  min-height: 180px;
  border: 1px solid var(--admin-line);
  border-radius: 10px;
  background: var(--admin-panel-muted);
  color: var(--admin-muted);
  font-size: 12px;
}
@media (max-width: 1100px) {
  .day-layout {
    grid-template-columns: minmax(0, 1fr);
  }
}
@media (max-width: 800px) {
  .day-panel__heading {
    align-items: flex-start;
    flex-direction: column;
    gap: 8px;
  }
  .day-calendar-panel .admin-panel__head,
  .day-records-panel .admin-panel__head {
    align-items: flex-start;
    flex-wrap: wrap;
  }
  .day-calendar__day {
    min-height: 52px;
  }
  .day-record__quantity {
    align-items: flex-end;
    flex-direction: column;
    gap: 3px;
  }
}
@media (max-width: 480px) {
  .day-layout {
    gap: 12px;
  }
  .day-calendar-panel,
  .day-records-panel {
    padding: 12px;
  }
  .day-calendar {
    gap: 4px;
  }
  .day-calendar__day {
    min-height: 46px;
    border-radius: 6px;
    font-size: 11px;
  }
  .day-calendar__marker {
    width: 6px;
    height: 6px;
  }
  .day-calendar-panel .admin-toolbar {
    width: 100%;
    justify-content: space-between;
  }
  .day-error {
    align-items: flex-start;
    flex-direction: column;
  }
}
</style>
