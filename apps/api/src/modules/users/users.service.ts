import { Inject, Injectable, NotFoundException } from "@nestjs/common";

import type { UserRecord, UserRole } from "@vm/shared-types";

import { InMemoryStoreService } from "../../common/store/in-memory-store.service";

interface ImportUsersPayload {
  role: Extract<UserRole, "special" | "merchant">;
  entries: Array<Partial<UserRecord> & Pick<UserRecord, "phone" | "name">>;
}

@Injectable()
export class UsersService {
  constructor(@Inject(InMemoryStoreService) private readonly store: InMemoryStoreService) {}

  list(role?: UserRole) {
    if (!role) {
      return this.store.users;
    }

    return this.store.users.filter((user) => user.role === role);
  }

  findByPhone(phone: string) {
    return this.store.users.find((user) => user.phone === phone && user.status === "active");
  }

  findById(userId: string) {
    const user = this.store.users.find((entry) => entry.id === userId);

    if (!user) {
      throw new NotFoundException("未找到对应用户。");
    }

    return user;
  }

  importUsers(payload: ImportUsersPayload) {
    const imported = payload.entries.map((entry) => {
      const existing = this.store.users.find((user) => user.phone === entry.phone);

      if (existing) {
        Object.assign(existing, entry, {
          role: payload.role,
          status: "active"
        });
        return existing;
      }

      const created: UserRecord = {
        id: this.store.createId(payload.role),
        role: payload.role,
        phone: entry.phone,
        name: entry.name,
        status: "active",
        tags: entry.tags ?? [],
        neighborhood: entry.neighborhood,
        quota: entry.quota,
        merchantProfile: entry.merchantProfile
      };

      this.store.users.push(created);
      return created;
    });

    return {
      count: imported.length,
      imported
    };
  }
}
