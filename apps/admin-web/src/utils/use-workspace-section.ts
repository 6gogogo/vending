import { computed, toValue, type MaybeRefOrGetter } from "vue";
import { useRoute } from "vue-router";
import { resolveWorkspaceSection } from "./admin-navigation";

// URL 保留分区，支持刷新、分享、后退；不可用分区回落到第一个有效入口。
export const useWorkspaceSection = (items: MaybeRefOrGetter<Array<{ value: string }>>) => {
  const route = useRoute();
  return computed(() => resolveWorkspaceSection(route.query.section, toValue(items).map(item => item.value)));
};
