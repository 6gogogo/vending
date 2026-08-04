<script setup lang="ts">
import { computed, ref, watch } from "vue";

import appLoginImage from "../../../../docs/assets/app-public-manual-login-390x844-20260729.png";
import backofficeLoginImage from "../../../../docs/assets/backoffice-login-public-1280x720-20260729.png";
import instanceSettingsImage from "../../../../docs/assets/backoffice-instance-settings-live-1440x900-20260730.jpg";
import { useAdminSessionStore } from "../stores/session";
import {
  resolveVisibleRoleManualIds,
  roleManuals,
  type RoleManualId
} from "../utils/role-manual";

const sessionStore = useAdminSessionStore();
const visibleManualIds = computed(() =>
  resolveVisibleRoleManualIds(sessionStore.user?.backofficeRole)
);
const selectedManualId = ref<RoleManualId>("provider");

watch(
  () => sessionStore.user?.backofficeRole,
  () => {
    selectedManualId.value = visibleManualIds.value[0] ?? "admin";
  },
  { immediate: true }
);

const selectedManual = computed(() => roleManuals[selectedManualId.value]);
const showRoleTabs = computed(() => visibleManualIds.value.length > 1);
const manualIntroCopy = computed(() => {
  if (sessionStore.user?.backofficeRole === "super_admin") {
    return "服务商账号可查阅本身份及全部下级角色手册；进入实例后仍可核对各角色的操作边界。";
  }

  return showRoleTabs.value
    ? "本页只显示当前身份及下级角色手册，不会显示任何上级角色内容。"
    : "本页只显示与你当前后台身份相符的内容。";
});
const manualImageById: Record<RoleManualId, { src: string; alt: string; caption: string }> = {
  provider: {
    src: backofficeLoginImage,
    alt: "电脑后台登录页面",
    caption: "服务商和实例角色使用同一个后台入口，系统会在登录后按账号身份显示功能。"
  },
  admin: {
    src: instanceSettingsImage,
    alt: "实例领取与服务设置页面",
    caption: "实例管理员在系统设置中维护预约、额度和 App 登录方式。"
  },
  merchant: {
    src: backofficeLoginImage,
    alt: "电脑后台登录页面",
    caption: "使用实例管理员开通的商户账号登录，进入后只显示商户可用功能。"
  },
  restocker: {
    src: backofficeLoginImage,
    alt: "电脑后台登录页面",
    caption: "使用实例管理员开通的补货员账号登录，柜机列表只显示已分配范围。"
  },
  app: {
    src: appLoginImage,
    alt: "App 人工验证码登录页面",
    caption: "App 用户输入本人手机号和当前有效的一次性验证码。"
  }
};
const selectedImage = computed(() => manualImageById[selectedManualId.value]);
</script>

<template>
  <section class="role-manual admin-page">
    <div class="role-manual__intro admin-panel">
      <div>
        <p class="admin-kicker">当前账号使用手册</p>
        <h2>{{ showRoleTabs ? "按身份查找操作步骤" : selectedManual.label + "使用手册" }}</h2>
        <p class="admin-copy">{{ manualIntroCopy }}</p>
      </div>
      <span class="admin-pill admin-pill--success">{{ selectedManual.label }}</span>
    </div>

    <div
      v-if="showRoleTabs"
      class="role-manual__tabs"
      role="tablist"
      aria-label="选择手册身份"
    >
      <button
        v-for="manualId in visibleManualIds"
        :key="manualId"
        class="role-manual__tab"
        :class="{ 'role-manual__tab--active': selectedManualId === manualId }"
        type="button"
        role="tab"
        :aria-selected="selectedManualId === manualId"
        aria-controls="role-manual-content"
        @click="selectedManualId = manualId"
      >
        {{ roleManuals[manualId].label }}
      </button>
    </div>

    <article id="role-manual-content" class="role-manual__content" role="tabpanel">
      <header class="role-manual__heading">
        <p class="admin-kicker">{{ selectedManual.label }}</p>
        <h2>{{ selectedManual.summary }}</h2>
      </header>

      <div class="role-manual__body">
        <div class="role-manual__sections">
          <section
            v-for="section in selectedManual.sections"
            :key="section.title"
            class="admin-panel role-manual__section"
          >
            <h3>{{ section.title }}</h3>
            <ol>
              <li v-for="step in section.steps" :key="step">{{ step }}</li>
            </ol>
            <p v-if="section.note" class="admin-note">{{ section.note }}</p>
          </section>
        </div>

        <figure class="admin-panel role-manual__figure">
          <img :src="selectedImage.src" :alt="selectedImage.alt" />
          <figcaption>{{ selectedImage.caption }}</figcaption>
        </figure>
      </div>
    </article>
  </section>
</template>

<style scoped>
.role-manual {
  display: grid;
  gap: 18px;
}

.role-manual__intro {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 20px;
  padding: 22px;
}

.role-manual h2,
.role-manual h3,
.role-manual p {
  margin-top: 0;
}

.role-manual__intro h2,
.role-manual__heading h2 {
  margin-bottom: 8px;
  color: var(--admin-text);
  line-height: 1.35;
}

.role-manual__tabs {
  display: flex;
  gap: 8px;
  overflow-x: auto;
  padding-bottom: 2px;
}

.role-manual__tab {
  flex: 0 0 auto;
  min-height: 42px;
  padding: 9px 16px;
  border: 1px solid var(--admin-line-strong);
  border-radius: 8px;
  background: #ffffff;
  color: var(--admin-text);
  font: inherit;
  font-weight: 750;
  cursor: pointer;
}

.role-manual__tab:hover,
.role-manual__tab:focus-visible,
.role-manual__tab--active {
  border-color: var(--admin-accent);
  background: var(--admin-accent-soft);
  color: var(--admin-accent-strong);
}

.role-manual__content {
  display: grid;
  gap: 16px;
}

.role-manual__heading {
  padding: 4px 2px;
}

.role-manual__body {
  display: grid;
  grid-template-columns: minmax(0, 1.3fr) minmax(280px, 0.8fr);
  gap: 18px;
  align-items: start;
}

.role-manual__sections {
  display: grid;
  gap: 14px;
}

.role-manual__section,
.role-manual__figure {
  padding: 20px;
}

.role-manual__section h3 {
  margin-bottom: 12px;
  color: var(--admin-text);
  font-size: 1.05rem;
}

.role-manual__section ol {
  display: grid;
  gap: 10px;
  margin: 0;
  padding-left: 22px;
  color: var(--admin-text);
  line-height: 1.65;
}

.role-manual__section li::marker {
  color: var(--admin-accent-strong);
  font-weight: 800;
}

.role-manual__section .admin-note {
  margin: 16px 0 0;
}

.role-manual__figure {
  position: sticky;
  top: 16px;
  margin: 0;
}

.role-manual__figure img {
  display: block;
  width: 100%;
  max-height: 520px;
  border: 1px solid var(--admin-line);
  border-radius: 8px;
  object-fit: contain;
  background: #f7faf7;
}

.role-manual__figure figcaption {
  margin-top: 12px;
  color: var(--admin-muted);
  font-size: 0.9rem;
  line-height: 1.6;
}

@media (max-width: 900px) {
  .role-manual__body {
    grid-template-columns: 1fr;
  }

  .role-manual__figure {
    position: static;
  }
}

@media (max-width: 560px) {
  .role-manual__intro {
    flex-direction: column;
    padding: 18px;
  }

  .role-manual__section,
  .role-manual__figure {
    padding: 16px;
  }
}
</style>
