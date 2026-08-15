<script setup lang="ts">
import { onShow } from "@dcloudio/uni-app";

import { useSessionStore } from "../../stores/session";
import { createAppLoginContinuation } from "../../utils/app-login-continuation";
import { resolveHomePath, syncRoleTabBar } from "../../utils/role-routing";

const sessionStore = useSessionStore();
const { continueApprovedLogin } = createAppLoginContinuation({
  getPickupTarget: () => sessionStore.pickupTarget,
  consumePickupTarget: () => sessionStore.consumePickupTarget(),
  bootstrapSession: () => sessionStore.bootstrap().then(() => undefined),
  getSessionRole: () => sessionStore.user?.role,
  setSession: (session) => sessionStore.setSession(session),
  redirectTo: (url) => uni.redirectTo({ url }),
  routeRoleHome: (role) => {
    syncRoleTabBar(role);
    uni.switchTab({ url: resolveHomePath(role) });
  }
});

const route = async () => {
  await sessionStore.bootstrap();
  if (sessionStore.user) {
    continueApprovedLogin({
      state: "approved",
      token: sessionStore.token!,
      user: sessionStore.user,
      quota: sessionStore.quota
    });
    return;
  }
  if (sessionStore.application && sessionStore.draft) {
    uni.reLaunch({ url: "/pages/common/review-status" });
    return;
  }
  if (sessionStore.draft) {
    uni.reLaunch({ url: "/pages/common/profile" });
    return;
  }
  uni.reLaunch({ url: "/pages/common/app-login" });
};

onShow(() => { void route(); });
</script>

<template><view class="entry-blank" /></template>

<style scoped>
.entry-blank { min-height: 100vh; background: #fffaf3; }
</style>
