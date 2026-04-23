<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { onShow } from "@dcloudio/uni-app";

import type { AiProviderStatus, AiSupportAssistantReply } from "@vm/shared-types";

import { mobileApi } from "../../api/mobile";
import EmptyState from "../../components/ui/EmptyState.vue";
import GlassCard from "../../components/ui/GlassCard.vue";
import MobileShell from "../../layouts/MobileShell.vue";
import { useSessionStore } from "../../stores/session";
import { getSupportGuideTopics } from "../../utils/support-guides";
import { getErrorMessage } from "../../utils/error-message";

const sessionStore = useSessionStore();
const loading = ref(false);
const asking = ref(false);
const selectedTopicId = ref("");
const question = ref("");
const aiStatus = ref<AiProviderStatus | null>(null);
const latestReply = ref<AiSupportAssistantReply | null>(null);
const conversation = ref<Array<{ role: "user" | "assistant"; content: string }>>([]);

const guideTopics = computed(() => getSupportGuideTopics(sessionStore.user?.role ?? "special"));
const selectedTopic = computed(
  () => guideTopics.value.find((item) => item.id === selectedTopicId.value) ?? guideTopics.value[0]
);

watch(
  guideTopics,
  (topics) => {
    if (!topics.length) {
      selectedTopicId.value = "";
      return;
    }

    if (!topics.some((item) => item.id === selectedTopicId.value)) {
      selectedTopicId.value = topics[0].id;
    }
  },
  { immediate: true }
);

const load = async () => {
  await sessionStore.bootstrap();

  if (!sessionStore.user) {
    uni.reLaunch({ url: "/pages/common/login" });
    return;
  }

  loading.value = true;

  try {
    aiStatus.value = await mobileApi.aiStatus();
  } catch (error) {
    aiStatus.value = {
      enabled: false,
      provider: "openai-compatible",
      baseUrl: "",
      model: "",
      missingConfig: [],
      apiKeyConfigured: false,
      usingDefaultBaseUrl: true,
      usingDefaultModel: true
    };
  } finally {
    loading.value = false;
  }
};

const submitQuestion = async () => {
  const trimmed = question.value.trim();

  if (!trimmed) {
    uni.showToast({
      title: "请先输入问题",
      icon: "none"
    });
    return;
  }

  if (!aiStatus.value?.enabled) {
    uni.showToast({
      title: "AI 助手暂未启用",
      icon: "none"
    });
    return;
  }

  asking.value = true;
  conversation.value.push({
    role: "user",
    content: trimmed
  });
  question.value = "";

  try {
    latestReply.value = await mobileApi.aiSupportAssistant({
      question: trimmed,
      scene: selectedTopic.value?.title,
      history: conversation.value.slice(-6)
    });
    conversation.value.push({
      role: "assistant",
      content: latestReply.value.answer
    });
  } catch (error) {
    showAskFailure(error);
  } finally {
    asking.value = false;
  }
};

const useFollowUp = (nextQuestion: string) => {
  question.value = nextQuestion;
};

const navigate = (url: string) => {
  uni.navigateTo({ url });
};

const showAskFailure = (error: unknown) => {
  uni.showToast({
    title: getErrorMessage(error),
    icon: "none"
  });
};

onShow(() => {
  load();
});
</script>

<template>
  <MobileShell
    eyebrow="遇到问题"
    title="流程指引与 AI 助手"
    subtitle="先按流程排查，再让 AI 帮你判断下一步。"
  >
    <GlassCard tone="accent">
      <view class="vm-stack">
        <view class="section-heading">
          <text class="section-heading__title">常见流程</text>
          <text class="vm-subtitle">先选择你当前遇到的问题场景，再看步骤和常见情况。</text>
        </view>
        <view class="topic-grid">
          <button
            v-for="topic in guideTopics"
            :key="topic.id"
            class="topic-chip"
            :class="{ 'topic-chip--active': selectedTopic?.id === topic.id }"
            @tap="selectedTopicId = topic.id"
          >
            <text class="topic-chip__title">{{ topic.title }}</text>
            <text class="topic-chip__summary">{{ topic.summary }}</text>
          </button>
        </view>
      </view>
    </GlassCard>

    <GlassCard tone="quiet">
      <view v-if="selectedTopic" class="vm-stack">
        <view class="section-heading">
          <text class="section-heading__title">{{ selectedTopic.title }}</text>
          <text class="vm-subtitle">{{ selectedTopic.summary }}</text>
        </view>
        <view class="step-list">
          <view v-for="(step, index) in selectedTopic.steps" :key="`${selectedTopic.id}-${index}`" class="step-card">
            <text class="step-card__index">步骤 {{ index + 1 }}</text>
            <text class="step-card__body">{{ step }}</text>
          </view>
        </view>
        <view class="faq-list">
          <view v-for="item in selectedTopic.faqs" :key="item.question" class="faq-card">
            <text class="faq-card__question">{{ item.question }}</text>
            <text class="faq-card__answer">{{ item.answer }}</text>
          </view>
        </view>
      </view>
      <EmptyState v-else :title="loading ? '正在加载帮助内容' : '暂时没有可展示的帮助内容'" description="请稍后再试。" />
    </GlassCard>

    <GlassCard tone="quiet">
      <view class="vm-stack">
        <view class="section-heading">
          <text class="section-heading__title">AI 助手</text>
          <text class="vm-subtitle">
            {{ aiStatus?.enabled ? `当前模型：${aiStatus.model || "已接入"}` : "后台暂未配置 AI，可先查看上方流程或提交反馈。" }}
          </text>
        </view>

        <textarea
          v-model="question"
          class="question-box"
          maxlength="240"
          auto-height
          :placeholder="selectedTopic ? `例如：${selectedTopic.title}里出现提示后，我下一步该怎么处理？` : '请描述你遇到的问题'"
        />

        <view class="action-grid">
          <button class="vm-button" :disabled="asking || !aiStatus?.enabled" @tap="submitQuestion">
            {{ asking ? "AI 正在整理建议" : "让 AI 帮我排查" }}
          </button>
          <button class="vm-button vm-button--ghost" @tap="navigate('/pages/common/feedback')">提交反馈</button>
        </view>

        <view v-if="latestReply" class="reply-card">
          <text class="reply-card__title">AI 建议</text>
          <text class="reply-card__body">{{ latestReply.answer }}</text>
          <view class="reply-points">
            <text v-for="item in latestReply.suggestedSteps" :key="item" class="reply-points__item">{{ item }}</text>
          </view>
          <view v-if="latestReply.followUpQuestions.length" class="follow-up-grid">
            <button v-for="item in latestReply.followUpQuestions" :key="item" class="vm-button vm-button--ghost follow-up-button" @tap="useFollowUp(item)">
              {{ item }}
            </button>
          </view>
          <text class="reply-card__tip">人工建议：{{ latestReply.escalationTip }}</text>
        </view>

        <view v-if="conversation.length" class="chat-list">
          <view
            v-for="(item, index) in conversation.slice(-4)"
            :key="`${item.role}-${index}-${item.content}`"
            class="chat-item"
            :class="{ 'chat-item--assistant': item.role === 'assistant' }"
          >
            <text class="chat-item__role">{{ item.role === "assistant" ? "AI 助手" : "我的问题" }}</text>
            <text class="chat-item__body">{{ item.content }}</text>
          </view>
        </view>
      </view>
    </GlassCard>
  </MobileShell>
</template>

<style scoped>
.section-heading,
.step-list,
.faq-list,
.reply-points,
.chat-list,
.topic-grid {
  display: grid;
  gap: 16rpx;
}

.section-heading__title {
  font-size: 30rpx;
  font-weight: 700;
  color: var(--vm-text);
}

.topic-grid {
  grid-template-columns: repeat(2, minmax(0, 1fr));
}

.topic-chip {
  display: grid;
  gap: 10rpx;
  min-height: 180rpx;
  padding: 24rpx;
  border-radius: 28rpx;
  border: 1rpx solid rgba(159, 127, 94, 0.14);
  background: rgba(255, 255, 255, 0.72);
  text-align: left;
}

.topic-chip--active {
  border-color: rgba(29, 111, 220, 0.26);
  background: rgba(239, 246, 255, 0.98);
  box-shadow: 0 16rpx 36rpx rgba(29, 111, 220, 0.1);
}

.topic-chip__title,
.reply-card__title,
.faq-card__question {
  font-size: 28rpx;
  font-weight: 700;
  color: var(--vm-text);
}

.topic-chip__summary,
.step-card__body,
.faq-card__answer,
.reply-card__body,
.reply-card__tip,
.chat-item__body {
  font-size: 24rpx;
  line-height: 1.7;
  color: var(--vm-text-soft);
}

.step-card,
.faq-card,
.reply-card,
.chat-item {
  display: grid;
  gap: 10rpx;
  padding: 22rpx 24rpx;
  border-radius: 24rpx;
  background: rgba(255, 255, 255, 0.7);
  border: 1rpx solid rgba(159, 127, 94, 0.12);
}

.step-card__index,
.chat-item__role {
  font-size: 22rpx;
  color: var(--vm-accent-strong);
}

.question-box {
  min-height: 168rpx;
  padding: 24rpx;
  border-radius: 24rpx;
  background: rgba(255, 255, 255, 0.86);
  border: 1rpx solid rgba(159, 127, 94, 0.18);
  font-size: 26rpx;
  line-height: 1.7;
  color: var(--vm-text);
  box-sizing: border-box;
}

.action-grid,
.follow-up-grid {
  display: grid;
  gap: 16rpx;
}

.reply-points__item {
  font-size: 24rpx;
  line-height: 1.6;
  color: var(--vm-text);
}

.follow-up-button {
  text-align: left;
}

.chat-item--assistant {
  background: rgba(239, 246, 255, 0.9);
}
</style>
