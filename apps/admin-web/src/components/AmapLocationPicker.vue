<script setup lang="ts">
import { nextTick, onMounted, onUnmounted, ref, watch } from "vue";

import { loadAmap } from "../utils/amap-loader";

const props = defineProps<{
  initialLongitude?: number;
  initialLatitude?: number;
  initialLocation?: string;
  initialAddress?: string;
  subjectLabel?: string;
  title?: string;
  description?: string;
  locationPlaceholder?: string;
}>();

const emit = defineEmits<{
  close: [];
  confirm: [
    payload: {
      longitude: number;
      latitude: number;
      location: string;
      address: string;
    }
  ];
}>();

const mapElement = ref<HTMLDivElement>();
const loading = ref(true);
const mapErrorMessage = ref("");
type SearchResultItem = {
  id: string;
  name: string;
  address: string;
  longitude: number;
  latitude: number;
};
type SearchFeedbackTone = "neutral" | "warning" | "danger";

const searchKeyword = ref("");
const locationLabel = ref(props.initialLocation ?? props.initialAddress ?? "");
const resolvedAddress = ref(props.initialAddress ?? "");
const currentPositionText = ref("");
const searchResults = ref<SearchResultItem[]>([]);
const searchFeedbackMessage = ref("");
const searchFeedbackTone = ref<SearchFeedbackTone>("neutral");
const searching = ref(false);
const selectedLongitude = ref<number | undefined>(props.initialLongitude);
const selectedLatitude = ref<number | undefined>(props.initialLatitude);

let amap: any;
let mapInstance: any;
let markerInstance: any;
let searchTimer: ReturnType<typeof setTimeout> | undefined;
let geocoderInstance: any;
let placeSearchInstance: any;
let geocodeToken = 0;

const formatCoordinates = (longitude: number, latitude: number) =>
  `${longitude.toFixed(6)}, ${latitude.toFixed(6)}`;

const resolvedSubjectLabel = props.subjectLabel?.trim() || "柜机";
const resolvedTitle = props.title?.trim() || `搜索地点后选择候选项，或直接点击地图确定${resolvedSubjectLabel}位置`;
const resolvedDescription = props.description?.trim() || "地图选点";
const resolvedLocationPlaceholder =
  props.locationPlaceholder?.trim() || `例如 ${resolvedSubjectLabel}所在位置说明`;

const updateCurrentPositionText = (longitude: number, latitude: number, label?: string) => {
  const coordinates = formatCoordinates(longitude, latitude);
  currentPositionText.value = label?.trim() ? `${label.trim()} · ${coordinates}` : coordinates;
};

const setMarker = (longitude: number, latitude: number) => {
  selectedLongitude.value = longitude;
  selectedLatitude.value = latitude;

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

const buildFallbackAddress = (longitude: number, latitude: number) =>
  `${resolvedSubjectLabel}位置 ${formatCoordinates(longitude, latitude)}`;

const buildGeocoderAddress = (regeocode: any) =>
  regeocode?.formattedAddress ||
  [
    regeocode?.addressComponent?.district,
    regeocode?.addressComponent?.township,
    regeocode?.addressComponent?.streetNumber?.street,
    regeocode?.addressComponent?.streetNumber?.number
  ]
    .filter(Boolean)
    .join("");

const applySelection = (
  longitude: number,
  latitude: number,
  payload: {
    location?: string;
    address?: string;
  }
) => {
  setMarker(longitude, latitude);
  const address = payload.address?.trim() || buildFallbackAddress(longitude, latitude);
  const location = payload.location?.trim() || address;
  locationLabel.value = location;
  resolvedAddress.value = address;
  updateCurrentPositionText(longitude, latitude, location);
};

const setSelectedLocation = (
  longitude: number,
  latitude: number,
  fallback?: {
    location?: string;
    address?: string;
  }
) => {
  searchFeedbackMessage.value = "";
  if (!geocoderInstance) {
    const fallbackAddress =
      fallback?.address?.trim() ||
      fallback?.location?.trim() ||
      buildFallbackAddress(longitude, latitude);
    applySelection(longitude, latitude, {
      location: fallback?.location?.trim() || fallbackAddress,
      address: fallbackAddress
    });
    return;
  }

  const currentToken = ++geocodeToken;
  geocoderInstance.getAddress([longitude, latitude], (status: string, result: any) => {
    if (currentToken !== geocodeToken) {
      return;
    }

    if (status === "complete" && result?.regeocode) {
      const formattedAddress =
        buildGeocoderAddress(result.regeocode) ||
        fallback?.address?.trim() ||
        fallback?.location?.trim() ||
        buildFallbackAddress(longitude, latitude);
      applySelection(longitude, latitude, {
        location: formattedAddress,
        address: formattedAddress
      });
      return;
    }

    const fallbackAddress =
      fallback?.address?.trim() ||
      fallback?.location?.trim() ||
      buildFallbackAddress(longitude, latitude);
    applySelection(longitude, latitude, {
      location: fallback?.location?.trim() || fallbackAddress,
      address: fallbackAddress
    });
  });
};

const applyInitialSelection = () => {
  if (selectedLongitude.value === undefined || selectedLatitude.value === undefined) {
    return;
  }

  setMarker(selectedLongitude.value, selectedLatitude.value);
  resolvedAddress.value = props.initialAddress?.trim() || "";
  updateCurrentPositionText(
    selectedLongitude.value,
    selectedLatitude.value,
    props.initialLocation?.trim() || props.initialAddress?.trim()
  );
};

const normalizePlaceResults = (items: any[]) =>
  items
    .map(
      (item: any, index: number): SearchResultItem | null => {
        const longitude = item.location?.lng;
        const latitude = item.location?.lat;

        if (typeof longitude !== "number" || typeof latitude !== "number") {
          return null;
        }

        const address = [
          item.pname,
          item.cityname,
          item.adname,
          item.address
        ]
          .filter(Boolean)
          .join(" ");

        return {
          id: `${item.id ?? item.name ?? "poi"}-${index}`,
          name: item.name || "未命名地点",
          address,
          longitude,
          latitude
        };
      }
    )
    .filter((item): item is SearchResultItem => item !== null);

const buildPlaceSearchErrorMessage = (result: any) => {
  const info =
    (typeof result === "string" ? result : result?.info || result?.message || "").trim();

  if (/USERKEY_PLAT_NOMATCH|INVALID_USER_KEY|INVALID_USER_SCODE/i.test(info)) {
    return `高德搜索失败（${info}），请检查 AMAP_WEB_KEY、AMAP_SECURITY_JS_CODE 与当前域名白名单。`;
  }

  if (info) {
    return `高德搜索失败（${info}），请检查 AMAP_WEB_KEY、AMAP_SECURITY_JS_CODE、域名白名单或控制台配额。`;
  }

  return "高德搜索失败，请检查 AMAP_WEB_KEY、AMAP_SECURITY_JS_CODE、域名白名单或控制台配额。";
};

const searchPlaces = async () => {
  const keyword = searchKeyword.value.trim();

  if (!keyword) {
    searchResults.value = [];
    searchFeedbackMessage.value = "";
    searching.value = false;
    return;
  }

  if (!placeSearchInstance) {
    searchResults.value = [];
    searching.value = false;
    searchFeedbackTone.value = "danger";
    searchFeedbackMessage.value =
      mapErrorMessage.value || "地图尚未初始化，无法搜索地点。请检查 AMAP_WEB_KEY、AMAP_SECURITY_JS_CODE 与域名白名单。";
    return;
  }

  searchResults.value = [];
  searchFeedbackTone.value = "neutral";
  searchFeedbackMessage.value = `正在搜索“${keyword}”...`;
  searching.value = true;

  await new Promise<void>((resolve) => {
    placeSearchInstance.search(keyword, (status: string, result: any) => {
      searching.value = false;

      if (status === "complete") {
        const normalized = normalizePlaceResults(result?.poiList?.pois ?? []);
        searchResults.value = normalized;
        if (!normalized.length) {
          searchFeedbackTone.value = "warning";
          searchFeedbackMessage.value = "未找到地点，请尝试更具体的关键词。";
        } else {
          searchFeedbackMessage.value = "";
        }
        resolve();
        return;
      }

      searchResults.value = [];
      if (status === "no_data") {
        searchFeedbackTone.value = "warning";
        searchFeedbackMessage.value = "未找到地点，请尝试更具体的关键词。";
      } else {
        searchFeedbackTone.value = "danger";
        searchFeedbackMessage.value = buildPlaceSearchErrorMessage(result);
      }
      resolve();
    });
  });
};

const normalizeMapErrorMessage = (error: unknown) => {
  const message = error instanceof Error ? error.message : "地图加载失败";

  if (message.includes("AMAP_WEB_KEY")) {
    return message;
  }

  if (message.includes("高德地图脚本加载失败")) {
    if (message.includes("域名白名单")) {
      return message;
    }
    return `${message}，请检查 AMAP_WEB_KEY、AMAP_SECURITY_JS_CODE 与当前管理端域名白名单。`;
  }

  return message;
};

const initialize = async () => {
  try {
    loading.value = true;
    mapErrorMessage.value = "";
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
      void setSelectedLocation(longitude, latitude);
    });

    geocoderInstance = new amap.Geocoder({
      city: "全国"
    });

    placeSearchInstance = new amap.PlaceSearch({
      pageSize: 8,
      pageIndex: 1,
      city: "全国",
      citylimit: false
    });

    applyInitialSelection();
  } catch (error) {
    mapErrorMessage.value = normalizeMapErrorMessage(error);
  } finally {
    loading.value = false;
  }
};

const pickResult = (item: SearchResultItem) => {
  searchFeedbackMessage.value = "";
  searchResults.value = [];
  void setSelectedLocation(item.longitude, item.latitude, {
    location: item.address || item.name,
    address: item.address || item.name
  });
};

const submit = () => {
  if (selectedLongitude.value === undefined || selectedLatitude.value === undefined) {
    searchFeedbackTone.value = "danger";
    searchFeedbackMessage.value = "请先在地图上选择位置。";
    return;
  }

  emit("confirm", {
    longitude: selectedLongitude.value,
    latitude: selectedLatitude.value,
    location:
      locationLabel.value.trim() ||
      buildFallbackAddress(selectedLongitude.value, selectedLatitude.value),
    address:
      resolvedAddress.value.trim() ||
      locationLabel.value.trim() ||
      buildFallbackAddress(selectedLongitude.value, selectedLatitude.value)
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

    if (!value) {
      searchResults.value = [];
      searchFeedbackMessage.value = "";
      searching.value = false;
      return;
    }

    searchTimer = setTimeout(() => {
      void searchPlaces();
    }, 220);
  }
);
</script>

<template>
  <section class="amap-picker">
    <div class="admin-panel__head">
      <div>
        <span class="admin-kicker">{{ resolvedDescription }}</span>
        <h3 class="admin-panel__title">{{ resolvedTitle }}</h3>
      </div>
      <button class="admin-button admin-button--ghost" @click="emit('close')">关闭</button>
    </div>

    <div class="amap-picker__toolbar">
      <input v-model="searchKeyword" class="admin-input" placeholder="搜索地点，例如 扬名路 18 号或某商场名称" @keyup.enter="searchPlaces" />
      <button class="admin-button admin-button--ghost" @click="searchPlaces">{{ searching ? "搜索中" : "搜索" }}</button>
    </div>

    <div
      v-if="searchFeedbackMessage"
      class="amap-picker__search-feedback"
      :class="`amap-picker__search-feedback--${searchFeedbackTone}`"
    >
      {{ searchFeedbackMessage }}
    </div>

    <label class="admin-field">
      <span class="admin-field__label">位置说明</span>
      <input v-model="locationLabel" class="admin-input" :placeholder="resolvedLocationPlaceholder" />
    </label>
    <div class="admin-note">
      当前坐标：{{ currentPositionText || "尚未选择" }}
    </div>

    <div class="amap-picker__map-shell">
      <div ref="mapElement" class="amap-picker__map"></div>
      <div v-if="loading" class="amap-picker__overlay admin-empty">
        <div class="admin-empty__title">正在加载地图</div>
      </div>
      <div v-else-if="mapErrorMessage" class="amap-picker__overlay admin-empty">
        <div class="admin-empty__title">地图不可用</div>
        <div class="admin-empty__body">{{ mapErrorMessage }}</div>
      </div>
    </div>

    <div v-if="searchResults.length" class="amap-picker__results">
      <button v-for="item in searchResults" :key="item.id" class="amap-picker__result" @click="pickResult(item)">
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

.amap-picker__search-feedback {
  padding: 10px 12px;
  border: 1px solid var(--admin-line);
  border-radius: 8px;
  background: var(--admin-panel-muted);
  color: var(--admin-text);
}

.amap-picker__search-feedback--warning {
  border-color: rgba(217, 119, 6, 0.28);
  background: rgba(254, 243, 199, 0.6);
  color: #92400e;
}

.amap-picker__search-feedback--danger {
  border-color: rgba(220, 38, 38, 0.24);
  background: rgba(254, 226, 226, 0.7);
  color: #991b1b;
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

.amap-picker__results {
  max-height: 220px;
  overflow: auto;
}

@media (max-width: 860px) {
  .amap-picker__toolbar,
  .amap-picker__footer {
    display: grid;
  }
}
</style>
