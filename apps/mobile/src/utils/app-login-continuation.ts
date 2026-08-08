import type { AppLoginResult, UserRole } from "@vm/shared-types";

import {
  resolvePickupPostLoginUrl,
  type PickupLoginTarget
} from "./cabinet-entry";

type ApprovedAppLoginResult = Extract<AppLoginResult, { state: "approved" }>;

export interface AppLoginContinuationDependencies {
  getPickupTarget: () => PickupLoginTarget | undefined;
  bootstrapSession: () => Promise<void>;
  getSessionRole: () => UserRole | undefined;
  setSession: (session: ApprovedAppLoginResult) => void;
  redirectTo: (url: string) => void;
  routeRoleHome: (role: UserRole) => void;
}

export const createAppLoginContinuation = (
  dependencies: AppLoginContinuationDependencies
) => {
  const routeApprovedUser = (role: UserRole) => {
    const pickupUrl = resolvePickupPostLoginUrl(
      role,
      dependencies.getPickupTarget()
    );

    if (pickupUrl) {
      dependencies.redirectTo(pickupUrl);
      return;
    }

    dependencies.routeRoleHome(role);
  };

  const restoreExistingSession = async () => {
    await dependencies.bootstrapSession();
    const role = dependencies.getSessionRole();
    if (role) {
      routeApprovedUser(role);
    }
  };

  const continueApprovedLogin = (session: ApprovedAppLoginResult) => {
    dependencies.setSession(session);
    routeApprovedUser(session.user.role);
  };

  return {
    continueApprovedLogin,
    restoreExistingSession
  };
};
