import { appCopy } from "../constants/copy";

export const callSupportPhone = () => {
  uni.makePhoneCall({
    phoneNumber: appCopy.supportPhone,
    fail: () => {
      uni.showModal({
        title: "客服电话",
        content: appCopy.supportPhone,
        confirmText: "我知道了",
        showCancel: false
      });
    }
  });
};
