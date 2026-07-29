<script setup lang="ts">
import { computed, ref } from "vue";
import { RouterLink } from "vue-router";

type GuideAudienceId = "provider" | "tenant-admin" | "operator" | "app-user";

interface GuideAudience {
  id: GuideAudienceId;
  label: string;
  summary: string;
  steps: string[];
  checks: string[];
}

const audiences: GuideAudience[] = [
  {
    id: "provider",
    label: "服务提供商",
    summary: "开通客户实例、进入目标实例，并在平台与实例之间保持清晰的权限边界。",
    steps: [
      "使用服务商平台账号登录；首次使用时，先按受控维护流程完成密码设置或更新。",
      "在“全局工作台”新建客户实例，并一次性建立该实例的首位管理员。",
      "确认实例名称和首管理员交接信息后，选择“进入实例”。进入后才会出现实例业务菜单。",
      "需要处理另一个客户或返回平台总览时，先选择“退出实例”；旧实例会话将失效。"
    ],
    checks: [
      "平台账号未进入实例时不能访问柜机、人员、库存等实例业务数据。",
      "进入实例后，只处理当前实例；不要在不同客户之间复用账号或人工码。",
      "首次密码、会话令牌和人工码均不得通过聊天、截图或工单传递。"
    ]
  },
  {
    id: "tenant-admin",
    label: "实例管理员",
    summary: "配置预约取货，管理人员与角色，并为 App 已启用账号签发一次性登录码。",
    steps: [
      "在“领取与服务设置”确认预约取货和额度规则。预约制不创建支付单，也不需要支付配置。",
      "在“人员管理”完成建档、审核和启用；给商户或补货员分配相应后台角色及可操作柜机。",
      "确认柜机在线且有可预约库存，再为已启用的 App 账号签发“APP / 小程序登录”用途的 6 位一次性验证码。",
      "让用户完成登录和预约后，核对验证码记录已使用、预约已生成；同一验证码再次提交必须被拒绝。"
    ],
    checks: [
      "人工码只能用于当前实例、已启用的既有账号，不能创建账号或替代 PC 后台密码。",
      "预约制的支付项保持关闭或不显示；出现支付步骤时应先停止验收并核对实例设置。",
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
    checks: [
      "看不到未分配柜机是权限保护的预期结果，不是页面异常。",
      "商户和补货员不应进入人工码、实例设置或其他实例数据。",
      "涉及库存差异、柜机异常时，保留业务记录并交由管理员处理。"
    ]
  },
  {
    id: "app-user",
    label: "App 用户",
    summary: "在人工验证码与预约取货模式下完成登录、预约和到柜领取。",
    steps: [
      "未建档时先联系当前实例管理员完成身份资料建档与审核；人工码模式不会发送短信，也不开放自助注册。",
      "从管理员处通过安全渠道获得一条 6 位一次性登录码，在 App 中填写手机号、验证码并勾选免责声明。",
      "登录后选择在线柜机和可预约货品，提交预约取货并核对保留时间。",
      "到达同一柜机后打开当前预约完成领取；预约流程不会要求支付。"
    ],
    checks: [
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
        <p class="public-guide__eyebrow">验收要点</p>
        <h2>完成前确认</h2>
        <ul class="public-guide__checks">
          <li v-for="check in selectedAudience.checks" :key="check">{{ check }}</li>
        </ul>
      </aside>
    </section>

    <section class="public-guide__section public-guide__section--two" aria-labelledby="guide-entry-title">
      <article class="public-guide__card">
        <p class="public-guide__eyebrow">入口说明</p>
        <h2 id="guide-entry-title">从公网入口开始</h2>
        <p>
          公网入口会跳转到 HTTPS 业务站点。若浏览器提示连接失败，先确认地址栏已完成跳转，再联系服务管理员核对当前发布状态。
        </p>
      </article>
      <article class="public-guide__card">
        <p class="public-guide__eyebrow">截图与留档</p>
        <h2>按流程保留证据</h2>
        <p>
          截图应覆盖登录页、实例进入、角色受限、人工码签发（遮住隐私内容）、App 登录、预约确认和验证码重放拒绝；不要截取密码、验证码或用户联系方式。
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
.public-guide__checks {
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

.public-guide__checks li::marker {
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
