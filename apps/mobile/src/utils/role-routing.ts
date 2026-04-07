import type { UserRole } from "@vm/shared-types";

export const resolveHomePath = (role: UserRole) => {
  if (role === "merchant") {
    return "/pages/merchant/home";
  }

  if (role === "special") {
    return "/pages/special/home";
  }

  return "/pages/common/login";
};
