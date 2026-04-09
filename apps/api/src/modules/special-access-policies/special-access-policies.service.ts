import { Inject, Injectable, NotFoundException } from "@nestjs/common";

import type { SpecialAccessPolicy, UserRole } from "@vm/shared-types";

import { InMemoryStoreService } from "../../common/store/in-memory-store.service";

@Injectable()
export class SpecialAccessPoliciesService {
  constructor(@Inject(InMemoryStoreService) private readonly store: InMemoryStoreService) {}

  list() {
    return this.store.specialAccessPolicies;
  }

  create(
    payload: Omit<SpecialAccessPolicy, "id">,
    actorUserId?: string
  ) {
    const policy: SpecialAccessPolicy = {
      id: this.store.createId("policy"),
      ...payload
    };

    this.store.specialAccessPolicies.unshift(policy);
    this.store.logOperation({
      category: "policy",
      type: "create-special-policy",
      status: "success",
      actor: this.getActor(actorUserId),
      metadata: {
        policyId: policy.id,
        policyName: policy.name
      }
    });

    return policy;
  }

  update(
    id: string,
    payload: Partial<Omit<SpecialAccessPolicy, "id">>,
    actorUserId?: string
  ) {
    const policy = this.findById(id);

    Object.assign(policy, payload);
    this.store.logOperation({
      category: "policy",
      type: "update-special-policy",
      status: "success",
      actor: this.getActor(actorUserId),
      metadata: {
        policyId: policy.id,
        policyName: policy.name
      }
    });

    return policy;
  }

  batchAssign(
    payload: {
      userIds: string[];
      policyIds: string[];
      mode: "bind" | "unbind" | "replace";
    },
    actorUserId?: string
  ) {
    const targetPolicies = this.store.specialAccessPolicies.filter((policy) =>
      payload.policyIds.includes(policy.id)
    );

    if (payload.mode === "replace") {
      for (const policy of this.store.specialAccessPolicies) {
        policy.applicableUserIds = policy.applicableUserIds.filter(
          (userId) => !payload.userIds.includes(userId)
        );
      }
    }

    for (const policy of targetPolicies) {
      if (payload.mode === "unbind") {
        policy.applicableUserIds = policy.applicableUserIds.filter(
          (userId) => !payload.userIds.includes(userId)
        );
        continue;
      }

      policy.applicableUserIds = Array.from(
        new Set([...policy.applicableUserIds, ...payload.userIds])
      );
    }

    this.store.logOperation({
      category: "policy",
      type: "batch-assign-special-policy",
      status: "success",
      actor: this.getActor(actorUserId),
      metadata: {
        userIds: payload.userIds,
        policyIds: payload.policyIds,
        mode: payload.mode
      }
    });

    return this.list();
  }

  private findById(id: string) {
    const policy = this.store.specialAccessPolicies.find((entry) => entry.id === id);

    if (!policy) {
      throw new NotFoundException("未找到对应策略模板。");
    }

    return policy;
  }

  private getActor(actorUserId?: string) {
    const admin =
      this.store.users.find((entry) => entry.id === actorUserId) ??
      this.store.users.find((entry) => entry.role === "admin");

    if (admin) {
      return {
        type: "admin" as const,
        id: admin.id,
        name: admin.name,
        role: admin.role as UserRole
      };
    }

    return {
      type: "system" as const,
      name: "系统"
    };
  }
}
