import { Inject, Injectable, NotFoundException } from "@nestjs/common";

import type { OperationLogCategory, OperationLogRecord, OperationLogStatus, OperationLogSubject } from "@vm/shared-types";

import { InMemoryStoreService } from "../../common/store/in-memory-store.service";

@Injectable()
export class OperationLogsService {
  constructor(@Inject(InMemoryStoreService) private readonly store: InMemoryStoreService) {}

  list(filters?: {
    category?: OperationLogCategory;
    status?: OperationLogStatus;
    subjectType?: OperationLogSubject["type"];
    subjectId?: string;
  }) {
    return this.store.logs
      .filter((entry) => {
        if (filters?.category && entry.category !== filters.category) {
          return false;
        }

        if (filters?.status && entry.status !== filters.status) {
          return false;
        }

        if (filters?.subjectType) {
          const matchesPrimary = entry.primarySubject?.type === filters.subjectType;
          const matchesSecondary = entry.secondarySubject?.type === filters.subjectType;

          if (!matchesPrimary && !matchesSecondary) {
            return false;
          }
        }

        if (filters?.subjectId) {
          const matchesPrimary = entry.primarySubject?.id === filters.subjectId;
          const matchesSecondary = entry.secondarySubject?.id === filters.subjectId;

          if (!matchesPrimary && !matchesSecondary) {
            return false;
          }
        }

        return true;
      })
      .sort((left, right) => right.occurredAt.localeCompare(left.occurredAt));
  }

  detail(id: string) {
    const log = this.store.logs.find((entry) => entry.id === id);

    if (!log) {
      throw new NotFoundException("未找到对应日志。");
    }

    return log;
  }
}
