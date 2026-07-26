<script setup lang="ts">
import { computed, onMounted, ref } from "vue";
import { useRouter } from "vue-router";

import AmapLocationPicker from "../components/AmapLocationPicker.vue";
import { loadPublicRuntimeConfig } from "../utils/public-config";

type RuntimeDataPlane = "simulation" | "live" | "unknown";
type AmapRuntimeMode = "mock" | "real" | "unknown";
type AcceptanceStage = "loading" | "ready" | "confirmed" | "rejected" | "failed";

type AcceptanceDraft = {
  longitude: number;
  latitude: number;
  location: string;
  address: string;
};

type MapAcceptanceResult = {
  ok: boolean;
  stage: AcceptanceStage;
  runtimeDataPlane: RuntimeDataPlane;
  amapRuntimeMode: AmapRuntimeMode;
  selected: AcceptanceDraft | null;
  saveRequestIssued: false;
};

declare global {
  interface Window {
    __vmMapAcceptanceResult?: MapAcceptanceResult;
  }
}

const router = useRouter();
const runtimeDataPlane = ref<RuntimeDataPlane>("unknown");
const amapRuntimeMode = ref<AmapRuntimeMode>("unknown");
const stage = ref<AcceptanceStage>("loading");
const statusMessage = ref("正在读取运行配置…");
const selectedDraft = ref<AcceptanceDraft | null>(null);

const isSimulationMapReady = computed(
  () => runtimeDataPlane.value === "simulation" && amapRuntimeMode.value === "real"
);

const refusalMessage = computed(() => {
  if (stage.value === "failed") {
    return statusMessage.value;
  }

  return "此页面仅在模拟实例且真实地图模式已启用时开放，不会在实机数据平面加载地图。";
});

const publishResult = () => {
  window.__vmMapAcceptanceResult = {
    ok: isSimulationMapReady.value,
    stage: stage.value,
    runtimeDataPlane: runtimeDataPlane.value,
    amapRuntimeMode: amapRuntimeMode.value,
    selected: selectedDraft.value,
    saveRequestIssued: false
  };
};

const loadRuntime = async () => {
  try {
    const config = await loadPublicRuntimeConfig();
    runtimeDataPlane.value = config.runtimeDataPlane ?? "unknown";
    amapRuntimeMode.value = config.amapRuntimeMode ?? "unknown";

    if (!isSimulationMapReady.value) {
      stage.value = "rejected";
      statusMessage.value = "当前运行环境不允许执行只读地图验收。";
      publishResult();
      return;
    }

    stage.value = "ready";
    statusMessage.value = "模拟实例已启用真实地图，可搜索地点并回填验收草稿。";
    publishResult();
  } catch (error) {
    stage.value = "failed";
    statusMessage.value = error instanceof Error ? error.message : "读取公开运行配置失败。";
    publishResult();
  }
};

const handleConfirm = (payload: AcceptanceDraft) => {
  selectedDraft.value = payload;
  stage.value = "confirmed";
  statusMessage.value = "已回填验收草稿，仅保留在当前页面，未保存柜机位置。";
  publishResult();
};

const close = async () => {
  await router.replace("/login");
};

onMounted(() => {
  document.title = "公益智助柜地图链路验收";
  void loadRuntime();
});
</script>

<template>
  <main class="map-acceptance">
    <header class="map-acceptance__header">
      <span class="map-acceptance__badge">模拟实例 · 只读地图验收</span>
      <h1>公益智助柜地图链路验收</h1>
      <p class="map-acceptance__status" role="status" aria-live="polite" aria-atomic="true">
        {{ statusMessage }}
      </p>
    </header>

    <section v-if="isSimulationMapReady" class="map-acceptance__panel" aria-label="地图验收草稿">
      <AmapLocationPicker
        subject-label="验收草稿"
        title="搜索地点后回填验收草稿"
        description="模拟实例 · 只读地图验收"
        location-placeholder="例如 无锡站"
        confirm-label="回填验收草稿"
        @close="close"
        @confirm="handleConfirm"
      />

      <section v-if="selectedDraft" class="map-acceptance__draft" aria-label="已回填的验收草稿">
        <h2>已回填的验收草稿</h2>
        <p>{{ selectedDraft.location }}</p>
        <p>{{ selectedDraft.longitude.toFixed(6) }}, {{ selectedDraft.latitude.toFixed(6) }}</p>
        <p>本页未保存柜机位置，也未发起任何写入请求。</p>
      </section>
    </section>

    <section v-else class="map-acceptance__panel map-acceptance__refusal" role="alert" aria-live="assertive">
      <h2>当前环境不可执行地图验收</h2>
      <p>{{ refusalMessage }}</p>
      <button class="admin-button" @click="close">返回登录</button>
    </section>
  </main>
</template>

<style scoped>
.map-acceptance {
  width: min(100%, 960px);
  margin: 0 auto;
  padding: 24px 16px 40px;
}

.map-acceptance__header,
.map-acceptance__panel,
.map-acceptance__draft {
  display: grid;
  gap: 12px;
}

.map-acceptance__header {
  margin-bottom: 16px;
}

.map-acceptance__header h1,
.map-acceptance__draft h2 {
  margin: 0;
}

.map-acceptance__badge {
  width: fit-content;
  padding: 6px 10px;
  border: 1px solid rgba(146, 64, 14, 0.36);
  border-radius: 999px;
  color: #78350f;
  background: rgba(255, 247, 237, 0.96);
  font-size: 13px;
  font-weight: 700;
}

.map-acceptance__status,
.map-acceptance__draft p,
.map-acceptance__refusal p {
  margin: 0;
  line-height: 1.6;
}

.map-acceptance__panel,
.map-acceptance__draft {
  padding: 16px;
  border: 1px solid var(--admin-line);
  border-radius: 12px;
  background: var(--admin-panel);
}

.map-acceptance__refusal {
  color: #991b1b;
}

@media (max-width: 390px) {
  .map-acceptance {
    padding: 16px 12px 28px;
  }

  .map-acceptance__panel,
  .map-acceptance__draft {
    padding: 12px;
  }
}
</style>
