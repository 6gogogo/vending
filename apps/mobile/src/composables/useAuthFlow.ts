import { computed, ref } from "vue";

import type { UserRole } from "@vm/shared-types";

import { mobileApi } from "../api/mobile";
import { useSessionStore } from "../stores/session";
import { getErrorMessage } from "../utils/error-message";
import { resolveHomePath } from "../utils/role-routing";

export const useAuthFlow = () => {
  const phone = ref("13800000002");
  const code = ref("");
  const requestedRole = ref<UserRole>("special");
  const busy = ref(false);
  const previewCode = ref<string>();
  const sessionStore = useSessionStore();

  const sendCode = async () => {
    busy.value = true;
    try {
      const response = await mobileApi.requestCode(phone.value);
      previewCode.value = response.previewCode ?? "";
      uni.showToast({
        title: "验证码已生成",
        icon: "none"
      });
    } catch (error) {
      uni.showToast({
        title: getErrorMessage(error),
        icon: "none"
      });
    } finally {
      busy.value = false;
    }
  };

  const submit = async () => {
    busy.value = true;
    try {
      const response = await mobileApi.mobileLogin(phone.value, code.value, requestedRole.value);

      if (response.state === "approved") {
        sessionStore.setSession(response);
        uni.reLaunch({
          url: resolveHomePath(response.user.role)
        });
        return;
      }

      if (response.state === "needs_profile") {
        sessionStore.setDraft({
          draft: response.draft,
          profileDraft: response.profile
        });
        uni.reLaunch({
          url: "/pages/common/profile"
        });
        return;
      }

      sessionStore.setDraft({
        draft: response.draft,
        application: response.application
      });
      uni.reLaunch({
        url: "/pages/common/review-status"
      });
    } catch (error) {
      uni.showToast({
        title: getErrorMessage(error),
        icon: "none"
      });
    } finally {
      busy.value = false;
    }
  };

  return {
    phone,
    code,
    requestedRole,
    busy: computed(() => busy.value),
    previewCode,
    sendCode,
    submit
  };
};
