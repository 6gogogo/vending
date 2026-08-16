import type { EntitlementLimit } from "@vm/shared-types";

export const cloneEntitlementLimits = (
  limits: readonly EntitlementLimit[] | undefined
): EntitlementLimit[] => (limits ?? []).map((limit) => ({ ...limit }));

export const createUserEntitlementLimit = (
  targetId = "",
  idFactory: () => string = () => globalThis.crypto.randomUUID()
): EntitlementLimit => ({
  id: idFactory(),
  targetType: "taxonomy_node",
  targetId,
  quantity: 1
});
