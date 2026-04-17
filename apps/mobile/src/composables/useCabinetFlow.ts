import { ref } from "vue";

import type { GoodsCategory } from "@vm/shared-types";

import { mobileApi } from "../api/mobile";
import { useSessionStore } from "../stores/session";
import { getErrorMessage } from "../utils/error-message";

export const useCabinetFlow = () => {
  const loading = ref(false);
  const latestOrder = ref<string>();
  const latestEventId = ref<string>();
  const sessionStore = useSessionStore();

  const openCabinet = async (deviceCode: string, category?: GoodsCategory) => {
    if (!sessionStore.user) {
      return;
    }

    loading.value = true;
    try {
      const response = await mobileApi.openCabinet({
        phone: sessionStore.user.phone,
        deviceCode,
        doorNum: "1",
        category
      });

      latestOrder.value = response.orderNo;
      latestEventId.value = response.eventId;
      if (response.remainingQuota) {
        // 立即刷新剩余额度，减少用户反复确认“今天还能不能领”的不确定感。
        const normalizedQuota = Object.fromEntries(
          Object.entries(response.remainingQuota).filter(([, value]) => value !== undefined)
        ) as Record<string, number>;

        sessionStore.setQuota({
          ...(sessionStore.quota ?? { remainingToday: {} }),
          remainingToday: normalizedQuota
        });
      }

      uni.showToast({
        title: "柜门已开启",
        icon: "none"
      });
    } catch (error) {
      uni.showToast({
        title: getErrorMessage(error),
        icon: "none"
      });
    } finally {
      loading.value = false;
    }
  };

  return {
    loading,
    latestOrder,
    latestEventId,
    openCabinet
  };
};
