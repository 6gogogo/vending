import { computed, ref } from "vue";

import { mobileApi } from "../api/mobile";
import { useSessionStore } from "../stores/session";
import { getErrorMessage } from "../utils/error-message";
import { resolveHomePath } from "../utils/role-routing";

export const useAuthFlow = () => {
  const phone = ref("13800000002");
  const code = ref("123456");
  const busy = ref(false);
  const previewCode = ref<string>();
  const sessionStore = useSessionStore();

  const sendCode = async () => {
    busy.value = true;
    try {
      const response = await mobileApi.requestCode(phone.value);
      previewCode.value = response.previewCode;
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
      const response = await mobileApi.login(phone.value, code.value);
      sessionStore.setSession(response);
      // 登录成功后按角色跳转，避免页面里散落角色判断。
      uni.reLaunch({
        url: resolveHomePath(response.user.role)
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
    busy: computed(() => busy.value),
    previewCode,
    sendCode,
    submit
  };
};
