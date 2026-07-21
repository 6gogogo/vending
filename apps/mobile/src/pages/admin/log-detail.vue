<script setup lang="ts">
import { ref } from "vue";
import { onLoad } from "@dcloudio/uni-app";

import type { OperationLogRecord } from "@vm/shared-types";

import { mobileApi } from "../../api/mobile";
import GlassCard from "../../components/ui/GlassCard.vue";
import MobileShell from "../../layouts/MobileShell.vue";
import { operationLogStatusLabelMap } from "../../constants/labels";
import { formatBeijingDateTime } from "../../utils/datetime";
import { getErrorMessage } from "../../utils/error-message";
import { useSessionStore } from "../../stores/session";

const sessionStore = useSessionStore();
const loading = ref(false);
const undoing = ref(false);
const logId = ref("");
const detail = ref<OperationLogRecord>();

const load = async () => {
  await sessionStore.bootstrap();

  if (!sessionStore.user || sessionStore.user.role !== "admin" || !logId.value) {
    uni.reLaunch({ url: "/pages/common/login" });
    return;
  }

  loading.value = true;
  try {
    detail.value = await mobileApi.logDetail(logId.value);
  } catch (error) {
    uni.showToast({
      title: getErrorMessage(error),
      icon: "none"
    });
  } finally {
    loading.value = false;
  }
};

const undo = async () => {
  if (!detail.value || undoing.value) {
    return;
  }

  const confirmed = await new Promise<boolean>((resolve) => {
    uni.showModal({
      title: "确认撤销操作",
      content: `将撤销“${detail.value?.description ?? "本次操作"}”。撤销可能影响库存、人员记录或关联柜机状态，请确认已经核对日志详情。`,
      confirmText: "确认撤销",
      cancelText: "再核对",
      success: ({ confirm }) => resolve(confirm),
      fail: () => resolve(false)
    });
  });

  if (!confirmed) {
    return;
  }

  undoing.value = true;
  try {
    detail.value = await mobileApi.undoLog(detail.value.id);
    uni.showToast({
      title: "撤销已完成",
      icon: "none"
    });
  } catch (error) {
    uni.showToast({
      title: getErrorMessage(error),
      icon: "none"
    });
  } finally {
    undoing.value = false;
  }
};

const openSubject = (type?: string, id?: string) => {
  if (!type || !id) {
    return;
  }

  if (type === "user") {
    uni.navigateTo({ url: `/pages/admin/user-detail?userId=${id}` });
    return;
  }

  if (type === "device") {
    uni.navigateTo({ url: `/pages/admin/device-detail?deviceCode=${id}` });
    return;
  }

  uni.navigateTo({ url: `/pages/admin/logs` });
};

onLoad((query) => {
  logId.value = typeof query.id === "string" ? query.id : "";
  load();
});
</script>

<template>
  <MobileShell eyebrow="日志详情" :title="detail?.description ?? '日志详情'" :subtitle="detail?.detail ?? '正在加载日志内容'">
    <GlassCard tone="accent">
      <view class="vm-stack">
        <text class="meta-line">时间：{{ formatBeijingDateTime(detail?.occurredAt, "暂无") }}</text>
        <text class="meta-line">状态：{{ detail ? operationLogStatusLabelMap[detail.status] : "暂无" }}</text>
        <text class="meta-line">类型：{{ detail?.type ?? "暂无" }}</text>
        <button
          v-if="detail?.metadata?.undoState === 'undoable'"
          class="vm-button"
          :loading="undoing"
          :disabled="undoing"
          @tap="undo"
        >
          撤销本次操作
        </button>
      </view>
    </GlassCard>

    <GlassCard tone="quiet">
      <view class="vm-stack">
        <text class="section-title">关联主体</text>
        <button
          v-if="detail?.primarySubject"
          class="subject-link"
          @tap="openSubject(detail?.primarySubject?.type, detail?.primarySubject?.id)"
        >
          主体：{{ detail?.primarySubject?.label }}
        </button>
        <button
          v-if="detail?.secondarySubject"
          class="subject-link"
          @tap="openSubject(detail?.secondarySubject?.type, detail?.secondarySubject?.id)"
        >
          关联：{{ detail?.secondarySubject?.label }}
        </button>
      </view>
    </GlassCard>

    <GlassCard tone="quiet">
      <view class="vm-stack">
        <text class="section-title">详细说明</text>
        <text class="detail-body">{{ detail?.detail }}</text>
      </view>
    </GlassCard>
  </MobileShell>
</template>

<style scoped>
.meta-line,
.detail-body {
  font-size: 24rpx;
  color: var(--vm-text-soft);
}

.section-title {
  font-size: 30rpx;
  font-weight: 700;
  color: var(--vm-text);
}

.subject-link {
  min-height: 88rpx;
  padding: 0 24rpx;
  border-radius: 24rpx;
  border: 1rpx solid var(--vm-line);
  background: var(--vm-surface-soft);
  text-align: left;
  font-size: 26rpx;
  color: var(--vm-text);
}
</style>

