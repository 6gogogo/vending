<script setup lang="ts">
import { computed, ref } from "vue";
import { RouterLink } from "vue-router";

type GuideAudienceId = "provider" | "tenant-admin" | "operator" | "app-user";

interface GuideAudience {
  id: GuideAudienceId;
  label: string;
  summary: string;
  steps: string[];
  tips: string[];
}

const audiences: GuideAudience[] = [
  {
    id: "provider",
    label: "服务提供商",
    summary: "开通和维护客户实例，再进入目标实例处理该实例的业务。",
    steps: [
      "平台首次部署时，由平台初始化负责人通过受控初始化流程建立首个服务商账号；实例管理员不能开通或重置服务商账号。",
      "使用服务商账号登录，打开“服务商后台 → 全局工作台”。",
      "在“全局工作台”新建客户实例，并一次性建立该实例的首位管理员。",
      "在实例列表选择“维护实例”，更新实例名称、运行状态、地址、联系人和服务方案；暂停不会删除现有记录。",
      "确认实例名称和首管理员交接信息后，选择“进入实例”。进入后才会出现实例业务菜单；需要处理其他客户时先选择“退出当前实例”。"
    ],
    tips: [
      "服务商账号属于平台范围，不能由任何客户实例中的角色向上授权。",
      "平台账号未进入实例时不能访问柜机、人员、库存等实例业务数据。",
      "进入实例后，只处理当前实例；不要在不同客户之间复用账号或人工码。",
      "密码、会话令牌和人工码请仅通过安全渠道交付。"
    ]
  },
  {
    id: "tenant-admin",
    label: "实例管理员",
    summary: "配置领取方式，管理人员、角色和柜机，并为 App 用户签发登录码。",
    steps: [
      "在“领取与服务设置”确认预约取货和额度规则。预约制不创建支付单，也不需要支付配置。",
      "在“人员管理”完成建档、审核和启用；给商户或补货员分配相应后台角色及可操作柜机。",
      "确认柜机在线且有可预约库存，再为已启用的 App 账号签发“APP / 小程序登录”用途的 6 位一次性验证码。",
      "忘记后台密码时，在登录页选择“忘记密码”，使用绑定手机号和找回验证码自行重置；无法自助时由服务提供商进入本实例代重置。",
      "用户完成登录和预约后，在人员记录、预约和操作日志中查看处理结果。"
    ],
    tips: [
      "每个实例必须至少保留一名启用、已开通后台账号且可登录的实例管理员。",
      "人工码只能用于当前实例、已启用的既有账号，不能创建账号或替代 PC 后台密码。",
      "预约制下支付项保持关闭或不显示；出现支付步骤时请先检查“预约取货”设置。",
      "人员、角色、柜机分配和操作日志都应由当前实例管理员复核。"
    ]
  },
  {
    id: "operator",
    label: "商户与补货员",
    summary: "在管理员授权的柜机范围内完成补货、巡检和记录核对。",
    steps: [
      "使用管理员开通的后台账号登录，先确认当前身份与可操作柜机列表。",
      "商户维护商品与补货记录；补货员只处理被分配柜机的现场补货和巡检任务。",
      "提交操作后在记录或日志中核对柜机、数量、时间和处理结果。",
      "发现未被分配的柜机、人员或数据时，不要尝试绕过权限，应联系当前实例管理员。"
    ],
    tips: [
      "看不到未分配柜机是权限保护的预期结果，不是页面异常。",
      "商户和补货员不应进入人工码、实例设置或其他实例数据。",
      "涉及库存差异、柜机异常时，保留业务记录并交由管理员处理。"
    ]
  },
  {
    id: "app-user",
    label: "App 用户",
    summary: "使用一次性验证码登录，完成预约并在约定时间到柜领取。",
    steps: [
      "未建档时先联系当前实例管理员完成身份资料建档与审核；人工码模式不会发送短信，也不开放自助注册。",
      "从管理员处通过安全渠道获得一条 6 位一次性登录码，在 App 中填写手机号、验证码并勾选免责声明。",
      "登录后选择在线柜机和可预约货品，提交预约取货并核对保留时间。",
      "到达同一柜机后打开当前预约完成领取；预约流程不会要求支付。"
    ],
    tips: [
      "验证码过期、撤销、输错达到上限或已经使用后，应联系管理员重新签发。",
      "不要把验证码、手机号或预约截图发到公开群组。",
      "预约超时或柜机异常时，先在当前预约中核对状态，再提交反馈。"
    ]
  }
];

const selectedAudienceId = ref<GuideAudienceId>("provider");
const selectedAudience = computed(
  () => audiences.find((audience) => audience.id === selectedAudienceId.value) ?? audiences[0]
);
</script>

<template>
  <main class="public-guide">
    <header class="public-guide__header">
      <div>
        <p class="public-guide__eyebrow">使用说明</p>
        <h1>公益智助柜操作指引</h1>
        <p class="public-guide__intro">
          按身份查看从开通、登录到预约取货的操作步骤。后台业务权限由当前会话和实例范围决定。
        </p>
      </div>
      <RouterLink class="admin-button public-guide__login" to="/login">进入后台登录</RouterLink>
    </header>

    <section class="public-guide__section" aria-labelledby="guide-audience-title">
      <div class="public-guide__section-heading">
        <p class="public-guide__eyebrow">选择身份</p>
        <h2 id="guide-audience-title">我现在要做什么？</h2>
      </div>
      <div class="public-guide__tabs" role="tablist" aria-label="使用身份">
        <button
          v-for="audience in audiences"
          :key="audience.id"
          class="public-guide__tab"
          :class="{ 'public-guide__tab--active': selectedAudienceId === audience.id }"
          type="button"
          role="tab"
          :aria-selected="selectedAudienceId === audience.id"
          aria-controls="guide-content"
          @click="selectedAudienceId = audience.id"
        >
          {{ audience.label }}
        </button>
      </div>
    </section>

    <section id="guide-content" class="public-guide__content" role="tabpanel">
      <article class="public-guide__card public-guide__card--primary">
        <p class="public-guide__eyebrow">{{ selectedAudience.label }}</p>
        <h2>{{ selectedAudience.summary }}</h2>
        <ol class="public-guide__steps">
          <li v-for="step in selectedAudience.steps" :key="step">{{ step }}</li>
        </ol>
      </article>

      <aside class="public-guide__card">
        <p class="public-guide__eyebrow">操作提示</p>
        <h2>使用时注意</h2>
        <ul class="public-guide__tips">
          <li v-for="tip in selectedAudience.tips" :key="tip">{{ tip }}</li>
        </ul>
      </aside>
    </section>

    <section class="public-guide__section public-guide__section--two" aria-labelledby="guide-entry-title">
      <article class="public-guide__card">
        <p class="public-guide__eyebrow">入口说明</p>
        <h2 id="guide-entry-title">从公网入口开始</h2>
        <p>
          电脑后台使用 <code>https://vending.5gogogo.top/login</code>，App 使用 <code>https://vending.5gogogo.top/mobile/</code>。
          从带端口入口访问时会自动跳转到 HTTPS 业务站点。
        </p>
      </article>
      <article class="public-guide__card">
        <p class="public-guide__eyebrow">遇到问题</p>
        <h2>先找对应管理员</h2>
        <p>
          App 用户联系当前实例管理员；商户和补货员联系分配其柜机的管理员；服务提供商处理实例开通、状态和跨实例切换。
        </p>
      </article>
    </section>

    <footer class="public-guide__footer">
      <RouterLink class="admin-link" to="/login">返回后台登录</RouterLink>
      <span>遇到问题请联系当前实例管理员或服务管理员。</span>
    </footer>
  </main>
</template>

<style scoped>
.public-guide {
  width: min(1080px, 100%);
  min-height: 100vh;
  margin: 0 auto;
  padding: 32px 24px 40px;
}

.public-guide__header,
.public-guide__section-heading,
.public-guide__footer {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 20px;
}

.public-guide__header {
  padding: 24px;
  border: 1px solid #c7dac9;
  border-left: 5px solid var(--admin-accent);
  background: #fff;
}

.public-guide h1,
.public-guide h2,
.public-guide p {
  margin-top: 0;
}

.public-guide h1 {
  margin-bottom: 10px;
  color: var(--admin-text);
  font-size: clamp(1.65rem, 2.8vw, 2.2rem);
  line-height: 1.25;
}

.public-guide h2 {
  margin-bottom: 12px;
  color: var(--admin-text);
  font-size: 1.05rem;
  line-height: 1.45;
}

.public-guide__eyebrow {
  margin-bottom: 8px;
  color: var(--admin-accent-strong);
  font-size: 0.78rem;
  font-weight: 800;
  letter-spacing: 0.04em;
}

.public-guide__intro,
.public-guide__card p,
.public-guide__footer {
  margin-bottom: 0;
  color: var(--admin-muted);
  line-height: 1.65;
}

.public-guide__login {
  flex: 0 0 auto;
  text-decoration: none;
}

.public-guide__section {
  display: grid;
  gap: 14px;
  margin-top: 20px;
}

.public-guide__tabs {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: 10px;
}

.public-guide__tab {
  min-height: 42px;
  padding: 8px 12px;
  border: 1px solid var(--admin-line-strong);
  border-radius: 6px;
  background: #fff;
  color: var(--admin-text);
  font-weight: 700;
  transition: border-color 160ms ease, background-color 160ms ease, color 160ms ease;
}

.public-guide__tab:hover,
.public-guide__tab--active {
  border-color: var(--admin-accent);
  background: var(--admin-accent-soft);
  color: var(--admin-accent-strong);
}

.public-guide__content,
.public-guide__section--two {
  display: grid;
  grid-template-columns: minmax(0, 1.45fr) minmax(260px, 0.8fr);
  gap: 16px;
  margin-top: 16px;
}

.public-guide__card {
  padding: 20px;
  border: 1px solid var(--admin-line);
  border-radius: 8px;
  background: #fff;
}

.public-guide__card--primary {
  border-color: #c7dac9;
}

.public-guide__steps,
.public-guide__tips {
  display: grid;
  gap: 12px;
  margin: 0;
  padding-left: 22px;
  color: var(--admin-text);
  line-height: 1.65;
}

.public-guide__steps li::marker {
  color: var(--admin-accent-strong);
  font-weight: 800;
}

.public-guide__tips li::marker {
  color: var(--admin-info);
}

.public-guide__section--two {
  grid-template-columns: repeat(2, minmax(0, 1fr));
}

.public-guide__footer {
  align-items: center;
  margin-top: 24px;
  padding: 16px 0;
  border-top: 1px solid var(--admin-line);
  font-size: 0.88rem;
}

@media (max-width: 760px) {
  .public-guide {
    padding: 20px 16px 28px;
  }

  .public-guide__header,
  .public-guide__section-heading,
  .public-guide__footer {
    align-items: stretch;
    flex-direction: column;
  }

  .public-guide__tabs,
  .public-guide__content,
  .public-guide__section--two {
    grid-template-columns: 1fr;
  }

  .public-guide__login {
    align-self: flex-start;
  }
}

@media (prefers-reduced-motion: reduce) {
  .public-guide__tab {
    transition: none;
  }
}
</style>
