<script setup lang="ts">
import { RouterLink } from "vue-router";
</script>

<template>
  <main class="login-guide">
    <header class="login-guide__header">
      <div>
        <p class="login-guide__eyebrow">登录前使用向导</p>
        <h1>先选择使用入口</h1>
        <p>
          这里仅说明如何进入系统。详细操作手册会在登录后按当前账号身份显示。
        </p>
      </div>
      <RouterLink class="admin-button login-guide__login" to="/login">进入电脑后台</RouterLink>
    </header>

    <section class="login-guide__entries" aria-label="系统入口">
      <article class="login-guide__card">
        <p class="login-guide__eyebrow">电脑端</p>
        <h2>后台账号登录</h2>
        <p>用于实例管理、商户工作和补货巡检。输入已经开通的后台账号与密码。</p>
        <RouterLink class="admin-link" to="/login">打开后台登录</RouterLink>
      </article>

      <article class="login-guide__card">
        <p class="login-guide__eyebrow">手机端</p>
        <h2>App 登录与预约</h2>
        <p>使用本人手机号和当前有效的一次性验证码登录，再按页面提示预约和领取。</p>
        <a class="admin-link" href="/mobile/">打开移动端</a>
      </article>
    </section>

    <section class="login-guide__checklist">
      <div>
        <p class="login-guide__eyebrow">登录前确认</p>
        <h2>准备好账号信息</h2>
      </div>
      <ol>
        <li>后台账号应由当前实例的管理人员开通；不要借用他人账号。</li>
        <li>App 首次使用前需要完成建档、审核和启用。</li>
        <li>忘记后台密码时，从登录页进入“忘记密码”，按页面要求验证绑定手机号。</li>
        <li>登录成功后，从左侧“操作手册”查看与你当前身份对应的步骤。</li>
      </ol>
    </section>

    <footer class="login-guide__footer">
      <span>账号未开通或验证码无效时，请联系当前实例管理员。</span>
      <RouterLink class="admin-link" to="/login">返回后台登录</RouterLink>
    </footer>
  </main>
</template>

<style scoped>
.login-guide {
  width: min(960px, 100%);
  min-height: 100vh;
  margin: 0 auto;
  padding: 32px 24px 40px;
}

.login-guide__header {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 24px;
  padding: 28px;
  border: 1px solid #c7dac9;
  border-left: 5px solid var(--admin-accent);
  border-radius: 10px;
  background: #ffffff;
}

.login-guide h1,
.login-guide h2,
.login-guide p {
  margin-top: 0;
}

.login-guide h1 {
  margin-bottom: 10px;
  color: var(--admin-text);
  font-size: clamp(1.75rem, 4vw, 2.5rem);
  line-height: 1.2;
}

.login-guide h2 {
  margin-bottom: 10px;
  color: var(--admin-text);
  font-size: 1.1rem;
}

.login-guide p,
.login-guide li,
.login-guide__footer {
  color: var(--admin-muted);
  line-height: 1.7;
}

.login-guide__eyebrow {
  margin-bottom: 8px;
  color: var(--admin-accent-strong) !important;
  font-size: 0.78rem;
  font-weight: 800;
  letter-spacing: 0.04em;
}

.login-guide__login {
  flex: 0 0 auto;
  text-decoration: none;
}

.login-guide__entries {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 16px;
  margin-top: 18px;
}

.login-guide__card,
.login-guide__checklist {
  padding: 22px;
  border: 1px solid var(--admin-line);
  border-radius: 10px;
  background: #ffffff;
}

.login-guide__card p {
  min-height: 58px;
}

.login-guide__checklist {
  display: grid;
  grid-template-columns: minmax(190px, 0.55fr) minmax(0, 1.45fr);
  gap: 24px;
  margin-top: 18px;
}

.login-guide__checklist ol {
  display: grid;
  gap: 10px;
  margin: 0;
  padding-left: 22px;
}

.login-guide__checklist li::marker {
  color: var(--admin-accent-strong);
  font-weight: 800;
}

.login-guide__footer {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  margin-top: 22px;
  padding: 16px 2px;
  border-top: 1px solid var(--admin-line);
  font-size: 0.9rem;
}

@media (max-width: 680px) {
  .login-guide {
    padding: 18px 14px 28px;
  }

  .login-guide__header,
  .login-guide__footer {
    align-items: stretch;
    flex-direction: column;
  }

  .login-guide__entries,
  .login-guide__checklist {
    grid-template-columns: 1fr;
  }

  .login-guide__header,
  .login-guide__card,
  .login-guide__checklist {
    padding: 18px;
  }

  .login-guide__login {
    align-self: flex-start;
  }

  .login-guide__card p {
    min-height: 0;
  }
}
</style>
