import { onMounted, onUnmounted } from "vue";

// 首次加载后再计时，避免慢请求叠加；隐藏时暂停，卸载后不再安排刷新。
export const usePagePolling = (load: () => Promise<unknown>, intervalMs: number) => {
  let active = false;
  let pending = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const clearTimer = () => {
    clearTimeout(timer);
    timer = undefined;
  };
  const refresh = async (initial = false) => {
    if (!active || pending || (!initial && document.hidden)) return;
    pending = true;
    try {
      await load();
    } catch (error) {
      // 业务加载函数负责界面错误提示；保留意外异常以便定位。
      console.error("页面自动刷新失败", error);
    } finally {
      pending = false;
      if (active && !document.hidden) timer = setTimeout(() => void refresh(), intervalMs);
    }
  };
  const onVisibilityChange = () => {
    clearTimer();
    if (!document.hidden) void refresh();
  };
  onMounted(() => {
    active = true;
    document.addEventListener("visibilitychange", onVisibilityChange);
    void refresh(true);
  });
  onUnmounted(() => {
    active = false;
    clearTimer();
    document.removeEventListener("visibilitychange", onVisibilityChange);
  });
};
