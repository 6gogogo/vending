<script setup lang="ts">
import { nextTick, onMounted, onUnmounted, ref, watch } from "vue";

import { loadAmap } from "../utils/amap-loader";

const props = defineProps<{
  initialLongitude?: number;
  initialLatitude?: number;
  initialLocation?: string;
}>();

const emit = defineEmits<{
  close: [];
  confirm: [
    payload: {
      longitude: number;
      latitude: number;
      location: string;
    }
  ];
}>();

const mapElement = ref<HTMLDivElement>();
const loading = ref(true);
const errorMessage = ref("");
const searchKeyword = ref("");
const locationLabel = ref(props.initialLocation ?? "");
const currentPositionText = ref("");
const searchResults = ref<Array<{ name: string; address: string; longitude: number; latitude: number }>>([]);
const selectedLongitude = ref<number | undefined>(props.initialLongitude);
const selectedLatitude = ref<number | undefined>(props.initialLatitude);

let amap: any;
let mapInstance: any;
let markerInstance: any;
let autoCompleteInstance: any;
let searchTimer: ReturnType<typeof setTimeout> | undefined;

const setMarker = (longitude: number, latitude: number) => {
  selectedLongitude.value = longitude;
  selectedLatitude.value = latitude;
  currentPositionText.value = `${longitude.toFixed(6)}, ${latitude.toFixed(6)}`;

  if (!markerInstance) {
    markerInstance = new amap.Marker({
      position: [longitude, latitude]
    });
    mapInstance.add(markerInstance);
  } else {
    markerInstance.setPosition([longitude, latitude]);
  }

  mapInstance.setZoomAndCenter(16, [longitude, latitude]);
};

const initialize = async () => {
  try {
    loading.value = true;
    errorMessage.value = "";
    await nextTick();

    if (!mapElement.value) {
      throw new Error("地图容器未初始化");
    }

    amap = await loadAmap();

    mapInstance = new amap.Map(mapElement.value, {
      zoom: 14,
      center:
        selectedLongitude.value !== undefined && selectedLatitude.value !== undefined
          ? [selectedLongitude.value, selectedLatitude.value]
          : [120.2915, 31.5528]
    });

    mapInstance.on("click", (event: any) => {
      const longitude = event.lnglat.getLng();
      const latitude = event.lnglat.getLat();
      setMarker(longitude, latitude);
      locationLabel.value = `柜机位置 ${longitude.toFixed(6)}, ${latitude.toFixed(6)}`;
    });

    autoCompleteInstance = new amap.AutoComplete({
      city: "全国"
    });

    if (selectedLongitude.value !== undefined && selectedLatitude.value !== undefined) {
      setMarker(selectedLongitude.value, selectedLatitude.value);
    }
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : "地图加载失败";
  } finally {
    loading.value = false;
  }
};

const normalizeResults = (items: any[]) =>
  items
    .map((item: any) => ({
      name: item.name,
      address: item.address || item.district || item.pname || "",
      longitude: item.location?.lng,
      latitude: item.location?.lat
    }))
    .filter((item) => typeof item.longitude === "number" && typeof item.latitude === "number");

const searchPlaces = async () => {
  if (!amap || !searchKeyword.value.trim()) {
    return;
  }

  errorMessage.value = "";
  const placeSearch = new amap.PlaceSearch({
    pageSize: 8,
    pageIndex: 1
  });

  placeSearch.search(searchKeyword.value.trim(), (status: string, result: any) => {
    if (status !== "complete") {
      searchResults.value = [];
      return;
    }

    searchResults.value = normalizeResults(result?.poiList?.pois ?? []);
  });
};

const pickResult = (item: { name: string; address: string; longitude: number; latitude: number }) => {
  locationLabel.value = item.address ? `${item.name} · ${item.address}` : item.name;
  setMarker(item.longitude, item.latitude);
};

const submit = () => {
  if (selectedLongitude.value === undefined || selectedLatitude.value === undefined) {
    errorMessage.value = "请先在地图上选择位置";
    return;
  }

  emit("confirm", {
    longitude: selectedLongitude.value,
    latitude: selectedLatitude.value,
    location: locationLabel.value.trim() || `柜机位置 ${selectedLongitude.value.toFixed(6)}, ${selectedLatitude.value.toFixed(6)}`
  });
};

onMounted(initialize);

onUnmounted(() => {
  if (searchTimer) {
    clearTimeout(searchTimer);
  }
  if (mapInstance?.destroy) {
    mapInstance.destroy();
  }
});

watch(
  () => searchKeyword.value.trim(),
  (value) => {
    if (searchTimer) {
      clearTimeout(searchTimer);
    }

    if (!value || !autoCompleteInstance) {
      if (!value) {
        searchResults.value = [];
      }
      return;
    }

    searchTimer = setTimeout(() => {
      autoCompleteInstance.search(value, (status: string, result: any) => {
        if (status !== "complete") {
          return;
        }

        const tips = normalizeResults(result?.tips ?? []);
        if (tips.length) {
          searchResults.value = tips;
          return;
        }

        void searchPlaces();
      });
    }, 220);
  }
);
</script>

<template>
  <section class="amap-picker">
    <div class="admin-panel__head">
      <div>
        <span class="admin-kicker">地图选点</span>
        <h3 class="admin-panel__title">搜索地点后可点击地图确定柜机位置</h3>
      </div>
      <button class="admin-button admin-button--ghost" @click="emit('close')">关闭</button>
    </div>

    <div class="amap-picker__toolbar">
      <input v-model="searchKeyword" class="admin-input" placeholder="搜索地点，例如 扬名路 18 号" @keyup.enter="searchPlaces" />
      <button class="admin-button admin-button--ghost" @click="searchPlaces">搜索</button>
    </div>

    <label class="admin-field">
      <span class="admin-field__label">位置说明</span>
      <input v-model="locationLabel" class="admin-input" placeholder="例如 扬名路 18 号西侧广场" />
    </label>
    <div class="admin-note">
      当前坐标：{{ currentPositionText || "尚未选择" }}
    </div>

    <div class="amap-picker__map-shell">
      <div ref="mapElement" class="amap-picker__map"></div>
      <div v-if="loading" class="amap-picker__overlay admin-empty">
        <div class="admin-empty__title">正在加载地图</div>
      </div>
      <div v-else-if="errorMessage" class="amap-picker__overlay admin-empty">
        <div class="admin-empty__title">地图不可用</div>
        <div class="admin-empty__body">{{ errorMessage }}</div>
      </div>
    </div>

    <div v-if="searchResults.length" class="amap-picker__results">
      <button v-for="item in searchResults" :key="`${item.longitude}-${item.latitude}`" class="amap-picker__result" @click="pickResult(item)">
        <span class="admin-table__strong">{{ item.name }}</span>
        <span class="admin-table__subtext">{{ item.address || "无详细地址" }}</span>
      </button>
    </div>

    <div class="amap-picker__footer">
      <span class="admin-table__subtext">
        {{ selectedLongitude !== undefined && selectedLatitude !== undefined ? `已选择 ${selectedLongitude.toFixed(6)}, ${selectedLatitude.toFixed(6)}` : "尚未选择坐标" }}
      </span>
      <button class="admin-button" @click="submit">保存位置</button>
    </div>
  </section>
</template>

<style scoped>
.amap-picker,
.amap-picker__results {
  display: grid;
  gap: 10px;
}

.amap-picker__toolbar,
.amap-picker__footer {
  display: flex;
  gap: 8px;
  align-items: center;
  justify-content: space-between;
}

.amap-picker__map-shell {
  position: relative;
}

.amap-picker__map {
  width: 100%;
  height: 360px;
  border: 1px solid var(--admin-line);
  border-radius: 8px;
  overflow: hidden;
}

.amap-picker__overlay {
  position: absolute;
  inset: 0;
  display: grid;
  place-items: center;
  background: rgba(248, 250, 252, 0.92);
  border: 1px solid var(--admin-line);
  border-radius: 8px;
}

.amap-picker__result {
  display: grid;
  gap: 4px;
  padding: 10px 12px;
  border: 1px solid var(--admin-line);
  border-radius: 8px;
  background: var(--admin-panel-muted);
  text-align: left;
  cursor: pointer;
}

@media (max-width: 860px) {
  .amap-picker__toolbar,
  .amap-picker__footer {
    display: grid;
  }
}
</style>
