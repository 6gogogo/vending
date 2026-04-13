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
type SearchResultItem = {
  id: string;
  name: string;
  address: string;
  longitude: number;
  latitude: number;
};

const searchKeyword = ref("");
const locationLabel = ref(props.initialLocation ?? "");
const currentPositionText = ref("");
const searchResults = ref<SearchResultItem[]>([]);
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

const setMarker = (longitude: number, latitude: number) => {
  selectedLongitude.value = longitude;
  selectedLatitude.value = latitude;
  currentPositionText.value = formatCoordinates(longitude, latitude);

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

const setSelectedLocation = (longitude: number, latitude: number, fallbackLocation?: string) => {
  setMarker(longitude, latitude);

  if (!geocoderInstance) {
    locationLabel.value = fallbackLocation?.trim() || `柜机位置 ${formatCoordinates(longitude, latitude)}`;
    currentPositionText.value = locationLabel.value;
    return;
  }

  const currentToken = ++geocodeToken;
  geocoderInstance.getAddress([longitude, latitude], (status: string, result: any) => {
    if (currentToken !== geocodeToken) {
      return;
    }

    if (status === "complete" && result?.regeocode) {
      const formattedAddress =
        result.regeocode.formattedAddress ||
        [
          result.regeocode.addressComponent?.district,
          result.regeocode.addressComponent?.township,
          result.regeocode.addressComponent?.streetNumber?.street,
          result.regeocode.addressComponent?.streetNumber?.number
        ]
          .filter(Boolean)
          .join("");

      locationLabel.value = formattedAddress || fallbackLocation?.trim() || `柜机位置 ${formatCoordinates(longitude, latitude)}`;
      currentPositionText.value = `${locationLabel.value} · ${formatCoordinates(longitude, latitude)}`;
      return;
    }

    locationLabel.value = fallbackLocation?.trim() || `柜机位置 ${formatCoordinates(longitude, latitude)}`;
    currentPositionText.value = `${locationLabel.value} · ${formatCoordinates(longitude, latitude)}`;
  });
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

const searchPlaces = async () => {
  const keyword = searchKeyword.value.trim();

  if (!placeSearchInstance || !keyword) {
    searchResults.value = [];
    return;
  }

  errorMessage.value = "";

  await new Promise<void>((resolve) => {
    placeSearchInstance.search(keyword, (status: string, result: any) => {
      if (status !== "complete") {
        searchResults.value = [];
        resolve();
        return;
      }

      searchResults.value = normalizePlaceResults(result?.poiList?.pois ?? []);
      resolve();
    });
  });
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

    if (selectedLongitude.value !== undefined && selectedLatitude.value !== undefined) {
      setSelectedLocation(
        selectedLongitude.value,
        selectedLatitude.value,
        props.initialLocation
      );
    }
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : "地图加载失败";
  } finally {
    loading.value = false;
  }
};

const pickResult = (item: SearchResultItem) => {
  searchKeyword.value = item.name;
  void setSelectedLocation(
    item.longitude,
    item.latitude,
    item.address ? `${item.name} · ${item.address}` : item.name
  );
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

    if (!value) {
      searchResults.value = [];
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
        <span class="admin-kicker">地图选点</span>
        <h3 class="admin-panel__title">搜索地点后选择候选项，或直接点击地图确定柜机位置</h3>
      </div>
      <button class="admin-button admin-button--ghost" @click="emit('close')">关闭</button>
    </div>

    <div class="amap-picker__toolbar">
      <input v-model="searchKeyword" class="admin-input" placeholder="搜索地点，例如 扬名路 18 号或某商场名称" @keyup.enter="searchPlaces" />
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
