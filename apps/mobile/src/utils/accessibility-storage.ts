export const MOBILE_SPECIAL_ACCESSIBILITY_KEY = "vm-mobile-special-accessibility";

export const readSpecialAccessibilityMode = (): boolean => {
  try {
    return uni.getStorageSync(MOBILE_SPECIAL_ACCESSIBILITY_KEY) === "1";
  } catch {
    return false;
  }
};

export const writeSpecialAccessibilityMode = (enabled: boolean) => {
  if (enabled) {
    uni.setStorageSync(MOBILE_SPECIAL_ACCESSIBILITY_KEY, "1");
    return;
  }

  uni.removeStorageSync(MOBILE_SPECIAL_ACCESSIBILITY_KEY);
};
