<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, reactive, ref } from "vue";
import { onBeforeRouteLeave } from "vue-router";
import type { SystemSettingEntry, SystemSettingsSnapshot, SystemSettingsUpdateResult } from "@vm/shared-types";

import { adminApi } from "../api/admin";
import { formatDateTime } from "../utils/datetime";

type LeaveDecision = "save" | "discard" | "stay";

const settingsSnapshot = ref<SystemSettingsSnapshot>();
const formValues = reactive<Record<string, string>>({});
const originalValues = ref<Record<string, string>>({});
const activeGroup = ref("");
const searchText = ref("");
const loading = ref(false);
const saving = ref(false);
const loadError = ref("");
const saveMessage = ref<{ type: "success" | "error"; text: string } | null>(null);
const lastSaveResult = ref<SystemSettingsUpdateResult>();
const revealedKeys = ref<Set<string>>(new Set());
const leaveDialogOpen = ref(false);
let resolveLeaveDecision: ((decision: LeaveDecision) => void) | undefined;

const settings = computed(() => settingsSnapshot.value?.settings ?? []);
const settingsByKey = computed(() => new Map(settings.value.map((entry) => [entry.key, entry])));
const groups = computed(() => [...new Set(settings.value.map((entry) => entry.group))]);
const dirtyKeys = computed(() =>
  Object.keys(formValues).filter((key) => formValues[key] !== originalValues.value[key])
);
const hasDirtyChanges = computed(() => dirtyKeys.value.length > 0);
const restartDirtyKeys = computed(() =>
  dirtyKeys.value.filter((key) => settingsByKey.value.get(key)?.restartRequired)
);
const runtimeDirtyKeys = computed(() =>
  dirtyKeys.value.filter((key) => !settingsByKey.value.get(key)?.restartRequired)
);
const activeGroupSettings = computed(() =>
  settings.value.filter((entry) => !activeGroup.value || entry.group === activeGroup.value)
);
const visibleSettings = computed(() => {
  const query = searchText.value.trim().toLowerCase();

  if (!query) {
    return activeGroupSettings.value;
  }

  return activeGroupSettings.value.filter((entry) =>
    [entry.key, entry.label, entry.description, entry.group]
      .join(" ")
      .toLowerCase()
      .includes(query)
  );
});
const groupCounts = computed(() =>
  groups.value.map((group) => ({
    group,
    count: settings.value.filter((entry) => entry.group === group).length,
    dirtyCount: dirtyKeys.value.filter((key) => settingsByKey.value.get(key)?.group === group).length
  }))
);
const sourceSummary = computed(() => {
  const envCount = settings.value.filter((entry) => entry.source === "env").length;
  const exampleCount = settings.value.filter((entry) => entry.source === "example").length;
  const runtimeCount = settings.value.filter((entry) => entry.source === "runtime").length;

  return { envCount, exampleCount, runtimeCount };
});

const applySnapshot = (snapshot: SystemSettingsSnapshot) => {
  settingsSnapshot.value = snapshot;
  const nextValues = Object.fromEntries(snapshot.settings.map((entry) => [entry.key, entry.value]));

  for (const key of Object.keys(formValues)) {
    delete formValues[key];
  }

  for (const [key, value] of Object.entries(nextValues)) {
    formValues[key] = value;
  }

  originalValues.value = nextValues;

  if (!activeGroup.value || !snapshot.settings.some((entry) => entry.group === activeGroup.value)) {
    activeGroup.value = snapshot.settings[0]?.group ?? "";
  }
};

const readErrorMessage = (error: unknown, fallback: string) =>
  error instanceof Error ? error.message : fallback;

const loadSettings = async () => {
  loading.value = true;
  loadError.value = "";
  saveMessage.value = null;

  try {
    applySnapshot(await adminApi.systemSettings());
    lastSaveResult.value = undefined;
  } catch (error) {
    loadError.value = readErrorMessage(error, "加载系统设置失败。");
  } finally {
    loading.value = false;
  }
};

const saveSettings = async () => {
  saving.value = true;
  saveMessage.value = null;

  try {
    const response = await adminApi.saveSystemSettings({
      values: { ...formValues }
    });
    lastSaveResult.value = response;
    applySnapshot(response);
    saveMessage.value = {
      type: "success",
      text: response.changedKeys.length
        ? `已保存 ${response.changedKeys.length} 项配置。`
        : "设置已保存，当前没有配置变更。"
    };
    return true;
  } catch (error) {
    saveMessage.value = {
      type: "error",
      text: readErrorMessage(error, "保存系统设置失败。")
    };
    return false;
  } finally {
    saving.value = false;
  }
};

const resetChanges = () => {
  for (const [key, value] of Object.entries(originalValues.value)) {
    formValues[key] = value;
  }

  saveMessage.value = null;
};

const setActiveGroup = (group: string) => {
  activeGroup.value = group;
};

const isBooleanEnabled = (key: string) => ["1", "true", "yes", "on"].includes((formValues[key] ?? "").toLowerCase());

const setBooleanValue = (key: string, checked: boolean) => {
  formValues[key] = checked ? "true" : "false";
};

const isKeyRevealed = (key: string) => revealedKeys.value.has(key);

const toggleReveal = (key: string) => {
  const next = new Set(revealedKeys.value);

  if (next.has(key)) {
    next.delete(key);
  } else {
    next.add(key);
  }

  revealedKeys.value = next;
};

const inputTypeFor = (entry: SystemSettingEntry) => {
  if (entry.inputType === "number") {
    return "number";
  }

  if (entry.inputType === "password" && !isKeyRevealed(entry.key)) {
    return "password";
  }

  return "text";
};

const sourceLabel = (source: SystemSettingEntry["source"]) => {
  if (source === "env") {
    return ".env";
  }

  if (source === "runtime") {
    return "运行时";
  }

  return "示例默认";
};

const fieldPillClass = (entry: SystemSettingEntry) => {
  if (dirtyKeys.value.includes(entry.key)) {
    return "admin-pill--warning";
  }

  if (entry.restartRequired) {
    return "admin-pill--neutral";
  }

  return "admin-pill--success";
};

const fieldPillText = (entry: SystemSettingEntry) => {
  if (dirtyKeys.value.includes(entry.key)) {
    return "未保存";
  }

  if (entry.restartRequired) {
    return "重启后生效";
  }

  return "保存即生效";
};

const shouldHideSensitiveTextarea = (entry: SystemSettingEntry) =>
  entry.inputType === "textarea" &&
  entry.sensitive &&
  Boolean(formValues[entry.key]) &&
  !isKeyRevealed(entry.key);

const requestLeaveDecision = () =>
  new Promise<LeaveDecision>((resolve) => {
    resolveLeaveDecision = resolve;
    leaveDialogOpen.value = true;
  });

const resolveLeave = (decision: LeaveDecision) => {
  leaveDialogOpen.value = false;
  resolveLeaveDecision?.(decision);
  resolveLeaveDecision = undefined;
};

const handleBeforeUnload = (event: BeforeUnloadEvent) => {
  if (!hasDirtyChanges.value) {
    return;
  }

  event.preventDefault();
  event.returnValue = "";
};

onBeforeRouteLeave(async () => {
  if (!hasDirtyChanges.value) {
    return true;
  }

  const decision = await requestLeaveDecision();

  if (decision === "stay") {
    return false;
  }

  if (decision === "discard") {
    resetChanges();
    return true;
  }

  return saveSettings();
});

onMounted(() => {
  void loadSettings();
  window.addEventListener("beforeunload", handleBeforeUnload);
});

onBeforeUnmount(() => {
  window.removeEventListener("beforeunload", handleBeforeUnload);
});
</script>

<template>
  <section class="admin-page settings-page">
    <section class="admin-page__section">
      <div class="admin-page__section-head settings-page__topbar">
        <div class="settings-page__heading-copy">
          <p class="admin-copy">
            当前配置文件：
            <span class="admin-code">{{ settingsSnapshot?.envFilePath ?? "apps/api/.env" }}</span>
          </p>
          <p class="admin-copy">
            已加载 {{ settings.length }} 项；.env {{ sourceSummary.envCount }} 项，示例默认 {{ sourceSummary.exampleCount }} 项，运行时 {{ sourceSummary.runtimeCount }} 项。
          </p>
        </div>

        <div class="admin-toolbar settings-page__actions">
          <button class="admin-button admin-button--ghost" type="button" :disabled="loading || saving" @click="loadSettings">
            {{ loading ? "刷新中" : "刷新" }}
          </button>
          <button
            class="admin-button admin-button--ghost"
            type="button"
            :disabled="saving || !hasDirtyChanges"
            @click="resetChanges"
          >
            放弃更改
          </button>
          <button class="admin-button" type="button" :disabled="saving || !hasDirtyChanges" @click="saveSettings">
            {{ saving ? "保存中" : "保存设置" }}
          </button>
        </div>
      </div>

      <div v-if="loadError" class="admin-note settings-page__note settings-page__note--danger">
        {{ loadError }}
      </div>
      <div
        v-if="saveMessage"
        class="admin-note settings-page__note"
        :class="{ 'settings-page__note--danger': saveMessage.type === 'error', 'settings-page__note--success': saveMessage.type === 'success' }"
      >
        {{ saveMessage.text }}
        <span v-if="lastSaveResult?.restartRequiredKeys.length">
          其中 {{ lastSaveResult.restartRequiredKeys.join("、") }} 需要重启后完全生效。
        </span>
      </div>
      <div v-if="hasDirtyChanges" class="admin-note settings-page__note settings-page__note--warning">
        当前有 {{ dirtyKeys.length }} 项未保存；{{ runtimeDirtyKeys.length }} 项保存后立即写入运行时，{{ restartDirtyKeys.length }} 项需要重启后完全生效。
      </div>
    </section>

    <section class="settings-page__workspace">
      <aside class="admin-panel admin-panel-block settings-page__sidebar">
        <label class="admin-field">
          <span class="admin-field__label">搜索配置</span>
          <input v-model.trim="searchText" class="admin-input" placeholder="变量名、说明或分组" />
        </label>

        <div class="settings-page__group-list">
          <button
            v-for="item in groupCounts"
            :key="item.group"
            class="settings-page__group-button"
            :class="{ 'settings-page__group-button--active': activeGroup === item.group }"
            type="button"
            @click="setActiveGroup(item.group)"
          >
            <span>{{ item.group }}</span>
            <span class="settings-page__group-count">
              {{ item.count }}<template v-if="item.dirtyCount"> / {{ item.dirtyCount }}</template>
            </span>
          </button>
        </div>

        <div class="admin-note settings-page__note">
          保存会写回 <span class="admin-code">apps/api/.env</span> 并同步当前 API 进程配置；标记为重启后生效的项会保留提示。
        </div>
      </aside>

      <article class="admin-panel admin-panel-block settings-page__form-panel">
        <div class="admin-panel__head settings-page__panel-head">
          <div>
            <span class="admin-kicker">统一配置</span>
            <h3 class="admin-panel__title">{{ activeGroup || "系统设置" }}</h3>
          </div>
          <div class="settings-page__state-pills">
            <span class="admin-pill" :class="hasDirtyChanges ? 'admin-pill--warning' : 'admin-pill--success'">
              {{ hasDirtyChanges ? `${dirtyKeys.length} 项未保存` : "已同步" }}
            </span>
            <span class="admin-pill admin-pill--neutral">
              {{ settingsSnapshot ? formatDateTime(settingsSnapshot.loadedAt) : "未加载" }}
            </span>
          </div>
        </div>

        <div v-if="loading && !settings.length" class="admin-empty">
          <div class="admin-empty__title">正在加载系统设置</div>
          <div class="admin-empty__body">请稍候。</div>
        </div>

        <div v-else-if="!visibleSettings.length" class="admin-empty">
          <div class="admin-empty__title">没有匹配的配置项</div>
          <div class="admin-empty__body">请调整搜索关键词或切换左侧分组。</div>
        </div>

        <div v-else class="settings-page__field-list">
          <section
            v-for="entry in visibleSettings"
            :key="entry.key"
            class="settings-page__field-row"
            :class="{ 'settings-page__field-row--dirty': dirtyKeys.includes(entry.key) }"
          >
            <div class="settings-page__field-meta">
              <div class="settings-page__field-title-line">
                <span class="settings-page__field-title">{{ entry.label }}</span>
                <span class="admin-code settings-page__field-key">{{ entry.key }}</span>
              </div>
              <p class="admin-copy settings-page__field-description">{{ entry.description }}</p>
              <div class="settings-page__field-pills">
                <span class="admin-pill" :class="fieldPillClass(entry)">{{ fieldPillText(entry) }}</span>
                <span v-if="entry.sensitive" class="admin-pill admin-pill--neutral">敏感项</span>
                <span class="admin-pill admin-pill--neutral">来源 {{ sourceLabel(entry.source) }}</span>
              </div>
            </div>

            <div class="settings-page__field-control">
              <label v-if="entry.inputType === 'boolean'" class="settings-page__switch">
                <input
                  type="checkbox"
                  :checked="isBooleanEnabled(entry.key)"
                  @change="setBooleanValue(entry.key, ($event.target as HTMLInputElement).checked)"
                />
                <span>{{ isBooleanEnabled(entry.key) ? "启用" : "停用" }}</span>
              </label>

              <select v-else-if="entry.inputType === 'select'" v-model="formValues[entry.key]" class="admin-select">
                <option v-for="option in entry.options" :key="option.value" :value="option.value">
                  {{ option.label }}
                </option>
              </select>

              <template v-else-if="entry.inputType === 'textarea'">
                <div v-if="shouldHideSensitiveTextarea(entry)" class="settings-page__secret-box">
                  <span class="admin-copy">内容已隐藏。</span>
                  <button class="admin-button admin-button--ghost" type="button" @click="toggleReveal(entry.key)">
                    显示并编辑
                  </button>
                </div>
                <textarea
                  v-else
                  v-model="formValues[entry.key]"
                  class="admin-input settings-page__textarea admin-code"
                  :placeholder="entry.exampleValue || entry.key"
                />
              </template>

              <div v-else class="settings-page__input-wrap">
                <input
                  v-model="formValues[entry.key]"
                  class="admin-input admin-code"
                  :type="inputTypeFor(entry)"
                  :placeholder="entry.exampleValue || entry.key"
                />
                <button
                  v-if="entry.inputType === 'password'"
                  class="admin-button admin-button--ghost settings-page__reveal-button"
                  type="button"
                  @click="toggleReveal(entry.key)"
                >
                  {{ isKeyRevealed(entry.key) ? "隐藏" : "显示" }}
                </button>
              </div>

              <p v-if="entry.exampleValue && entry.exampleValue !== formValues[entry.key]" class="admin-copy settings-page__example">
                示例：<span class="admin-code">{{ entry.exampleValue }}</span>
              </p>
            </div>
          </section>
        </div>
      </article>
    </section>

    <div v-if="leaveDialogOpen" class="settings-page__modal-backdrop">
      <section class="admin-panel settings-page__modal">
        <div class="admin-panel__head">
          <div>
            <span class="admin-kicker">未保存更改</span>
            <h3 class="admin-panel__title">离开前是否保存设置</h3>
          </div>
        </div>
        <p class="admin-copy">
          当前有 {{ dirtyKeys.length }} 项配置尚未保存。保存后会写入 .env，选择不保存会丢弃本次更改。
        </p>
        <div class="admin-toolbar settings-page__modal-actions">
          <button class="admin-button admin-button--ghost" type="button" @click="resolveLeave('stay')">继续编辑</button>
          <button class="admin-button admin-button--ghost" type="button" @click="resolveLeave('discard')">不保存</button>
          <button class="admin-button" type="button" @click="resolveLeave('save')">保存并离开</button>
        </div>
      </section>
    </div>
  </section>
</template>

<style scoped>
.settings-page__topbar,
.settings-page__panel-head {
  align-items: flex-start;
}

.settings-page__heading-copy {
  display: grid;
  gap: 6px;
  min-width: 0;
}

.settings-page__actions {
  justify-content: flex-end;
}

.settings-page__note {
  white-space: normal;
}

.settings-page__note--warning {
  border-left-color: #efcf8d;
  background: #fff8ea;
  color: #7a520b;
}

.settings-page__note--danger {
  border-left-color: #d9a6a1;
  background: #fff3f1;
  color: #8d342e;
}

.settings-page__note--success {
  border-left-color: #a9d2b5;
  background: #effaf2;
  color: #1d6b3d;
}

.settings-page__workspace {
  display: grid;
  grid-template-columns: 280px minmax(0, 1fr);
  gap: 12px;
  align-items: start;
}

.settings-page__sidebar {
  position: sticky;
  top: 12px;
  display: grid;
  gap: 12px;
}

.settings-page__group-list {
  display: grid;
  gap: 6px;
}

.settings-page__group-button {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  min-height: 36px;
  padding: 0 10px;
  border: 1px solid var(--admin-line);
  border-radius: 6px;
  background: var(--admin-panel);
  color: var(--admin-text);
  font-weight: 700;
  text-align: left;
  cursor: pointer;
}

.settings-page__group-button:hover,
.settings-page__group-button--active {
  border-color: #aebfe1;
  background: var(--admin-accent-soft);
  color: var(--admin-accent-strong);
}

.settings-page__group-count {
  flex: 0 0 auto;
  color: var(--admin-muted);
  font-size: 0.78rem;
}

.settings-page__form-panel {
  min-width: 0;
}

.settings-page__state-pills,
.settings-page__field-pills {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}

.settings-page__field-list {
  display: grid;
  gap: 10px;
}

.settings-page__field-row {
  display: grid;
  grid-template-columns: minmax(260px, 0.82fr) minmax(360px, 1fr);
  gap: 16px;
  padding: 14px;
  border: 1px solid var(--admin-line);
  border-radius: 8px;
  background: var(--admin-panel);
}

.settings-page__field-row--dirty {
  border-color: #efcf8d;
  background: #fffdf8;
}

.settings-page__field-meta,
.settings-page__field-control {
  display: grid;
  gap: 8px;
  min-width: 0;
  align-content: start;
}

.settings-page__field-title-line {
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  gap: 8px;
}

.settings-page__field-title {
  font-weight: 700;
  line-height: 1.35;
}

.settings-page__field-key {
  color: var(--admin-muted);
  font-size: 0.78rem;
  word-break: break-all;
}

.settings-page__field-description {
  line-height: 1.55;
}

.settings-page__input-wrap {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  gap: 8px;
}

.settings-page__reveal-button {
  min-width: 62px;
}

.settings-page__textarea {
  min-height: 116px;
  padding: 10px;
  resize: vertical;
  line-height: 1.55;
}

.settings-page__switch {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  min-height: 36px;
  color: var(--admin-text);
  font-weight: 700;
}

.settings-page__secret-box {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  min-height: 46px;
  padding: 8px 10px;
  border: 1px solid var(--admin-line);
  border-radius: 6px;
  background: var(--admin-panel-muted);
}

.settings-page__example {
  word-break: break-all;
}

.settings-page__modal-backdrop {
  position: fixed;
  inset: 0;
  z-index: 40;
  display: grid;
  place-items: center;
  padding: 24px;
  background: rgba(15, 23, 42, 0.32);
}

.settings-page__modal {
  display: grid;
  gap: 12px;
  width: min(520px, 100%);
  padding: 16px;
}

.settings-page__modal-actions {
  justify-content: flex-end;
}

@media (max-width: 1120px) {
  .settings-page__workspace,
  .settings-page__field-row {
    grid-template-columns: 1fr;
  }

  .settings-page__sidebar {
    position: static;
  }
}

@media (max-width: 680px) {
  .settings-page__input-wrap,
  .settings-page__secret-box {
    grid-template-columns: 1fr;
    display: grid;
  }
}
</style>
