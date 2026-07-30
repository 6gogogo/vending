import { BadRequestException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import { existsSync, openSync, readFileSync, readSync, closeSync, statSync } from "node:fs";

import type {
  BackofficeRole,
  CallbackLogRecord,
  InventoryMovement,
  OperationLogCategory,
  OperationLogRecord,
  OperationLogStatus,
  OperationLogSubject,
  SystemAuditLogEntry,
  UserRecord
} from "@vm/shared-types";

import { InventoryBatchChangesService } from "../../common/inventory/inventory-batch-changes.service";
import { toSafeSpreadsheetCell } from "../../common/export/html-workbook";
import { sanitizeAuditLogEntry } from "../../common/logging/audit-log-sanitizer";
import {
  InMemoryStoreService,
  RESERVED_BACKOFFICE_USER_TAGS
} from "../../common/store/in-memory-store.service";
import { resolveSystemLogFile } from "../../common/store/persistence";
import { assertTenantsKeepActiveBackofficeAdmin } from "../../common/store/tenant-admin-continuity";
import { getBusinessDayKey } from "../../common/time/business-day";

const MAX_SYSTEM_AUDIT_LIMIT = 200;
const MAX_SYSTEM_AUDIT_SCAN_LINES = 2_000;
const MAX_SYSTEM_AUDIT_READ_BYTES = 2 * 1024 * 1024;
const MAX_SYSTEM_AUDIT_LINE_LENGTH = 256 * 1024;

@Injectable()
export class OperationLogsService {
  constructor(
    @Inject(InMemoryStoreService) private readonly store: InMemoryStoreService,
    @Inject(InventoryBatchChangesService) private readonly inventoryBatchChanges: InventoryBatchChangesService
  ) {}

  list(
    filters?: {
      category?: OperationLogCategory;
      status?: OperationLogStatus;
      subjectType?: OperationLogSubject["type"];
      subjectId?: string;
      dateFrom?: string;
      dateTo?: string;
    },
    viewerBackofficeRole?: BackofficeRole,
    viewerTenantId?: string
  ) {
    return this.store.logs
      .filter((entry) => {
        if (
          viewerTenantId &&
          !this.operationLogBelongsToTenant(entry, viewerTenantId)
        ) {
          return false;
        }

        if (viewerBackofficeRole !== "super_admin" && this.involvesHiddenBackofficeUser(entry)) {
          return false;
        }

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

        const businessDateKey =
          filters?.dateFrom || filters?.dateTo ? getBusinessDayKey(entry.occurredAt) : undefined;

        if (filters?.dateFrom && businessDateKey && businessDateKey < filters.dateFrom) {
          return false;
        }

        if (filters?.dateTo && businessDateKey && businessDateKey > filters.dateTo) {
          return false;
        }

        return true;
      })
      .sort((left, right) => right.occurredAt.localeCompare(left.occurredAt));
  }

  detail(
    id: string,
    viewerBackofficeRole?: BackofficeRole,
    viewerTenantId?: string
  ) {
    const log = this.store.logs.find((entry) => entry.id === id);

    if (
      !log ||
      (viewerTenantId &&
        !this.operationLogBelongsToTenant(log, viewerTenantId)) ||
      (viewerBackofficeRole !== "super_admin" &&
        this.involvesHiddenBackofficeUser(log))
    ) {
      throw new NotFoundException("未找到对应日志。");
    }

    return log;
  }

  buildExport(
    filters?: {
      category?: OperationLogCategory;
      status?: OperationLogStatus;
      subjectType?: OperationLogSubject["type"];
      subjectId?: string;
      dateFrom?: string;
      dateTo?: string;
    },
    viewerBackofficeRole?: BackofficeRole,
    viewerTenantId?: string
  ) {
    const logs = this.list(filters, viewerBackofficeRole, viewerTenantId);
    const rows = logs
      .map(
        (log) => `
          <tr>
            <td>${toSafeSpreadsheetCell(log.occurredAt)}</td>
            <td>${toSafeSpreadsheetCell(log.category)}</td>
            <td>${toSafeSpreadsheetCell(log.status)}</td>
            <td>${toSafeSpreadsheetCell(log.actor.name)}</td>
            <td>${toSafeSpreadsheetCell(log.actor.type)}</td>
            <td>${toSafeSpreadsheetCell(log.primarySubject?.label)}</td>
            <td>${toSafeSpreadsheetCell(log.secondarySubject?.label)}</td>
            <td>${toSafeSpreadsheetCell(log.description)}</td>
            <td>${toSafeSpreadsheetCell(log.detail)}</td>
          </tr>`
      )
      .join("");

    return {
      filename: `operation-logs-${new Date().toISOString().slice(0, 10)}.xls`,
      contentType: "application/vnd.ms-excel; charset=utf-8",
      body: `<!DOCTYPE html>
<html>
<head><meta charset="utf-8" /></head>
<body>
<table border="1">
  <tr>
    <th>时间</th>
    <th>分类</th>
    <th>状态</th>
    <th>动作人</th>
    <th>动作人类型</th>
    <th>主体一</th>
    <th>主体二</th>
    <th>动作句式</th>
    <th>详细说明</th>
  </tr>
  ${rows}
</table>
</body>
</html>`
    };
  }

  buildSystemAuditExport() {
    const filePath = resolveSystemLogFile();
    const body = existsSync(filePath)
      ? readFileSync(filePath, "utf8")
          .split(/\r?\n/)
          .filter(Boolean)
          .flatMap((line) => {
            try {
              return [JSON.stringify(sanitizeAuditLogEntry(JSON.parse(line) as SystemAuditLogEntry))];
            } catch {
              return [];
            }
          })
          .join("\n")
      : "";

    return {
      filename: `system-audit-${new Date().toISOString().slice(0, 10)}.ndjson`,
      contentType: "application/x-ndjson; charset=utf-8",
      body
    };
  }

  listSystemAudit(filters?: {
    pathContains?: string;
    deviceCode?: string;
    limit?: number;
  }) {
    const filePath = resolveSystemLogFile();

    if (!existsSync(filePath)) {
      return [] as SystemAuditLogEntry[];
    }

    const pathContains = filters?.pathContains?.trim();
    const deviceCode = filters?.deviceCode?.trim();
    const limit = Math.min(MAX_SYSTEM_AUDIT_LIMIT, Math.max(1, filters?.limit ?? 50));
    const scanLineCount = Math.min(MAX_SYSTEM_AUDIT_SCAN_LINES, Math.max(limit * 20, 500));
    const lines = this.readTailLines(filePath, scanLineCount);
    const matches: SystemAuditLogEntry[] = [];

    for (let index = lines.length - 1; index >= 0; index -= 1) {
      const line = lines[index]?.trim();

      if (!line) {
        continue;
      }

       if (line.length > MAX_SYSTEM_AUDIT_LINE_LENGTH) {
        continue;
      }

      let entry: SystemAuditLogEntry | undefined;

      try {
        entry = sanitizeAuditLogEntry(JSON.parse(line) as SystemAuditLogEntry);
      } catch {
        entry = undefined;
      }

      if (!entry) {
        continue;
      }

      if (pathContains && !entry.path.includes(pathContains)) {
        continue;
      }

      if (deviceCode && !this.auditContainsDeviceCode(entry, deviceCode)) {
        continue;
      }

      matches.push(entry);

      if (matches.length >= limit) {
        break;
      }
    }

    return matches;
  }

  private readTailLines(filePath: string, maxLines: number) {
    const fileSize = statSync(filePath).size;

    if (fileSize <= 0) {
      return [] as string[];
    }

    const chunkSize = 64 * 1024;
    const handle = openSync(filePath, "r");
    const chunks: string[] = [];
    let position = fileSize;
    let newlineCount = 0;
    let bytesReadTotal = 0;

    try {
      while (position > 0 && bytesReadTotal < MAX_SYSTEM_AUDIT_READ_BYTES && newlineCount <= maxLines + 1) {
        const bytesToRead = Math.min(chunkSize, position);
        position -= bytesToRead;
        const buffer = Buffer.alloc(bytesToRead);
        readSync(handle, buffer, 0, bytesToRead, position);
        const text = buffer.toString("utf8");
        chunks.unshift(text);
        bytesReadTotal += bytesToRead;
        newlineCount += this.countNewlines(text);
      }
    } finally {
      closeSync(handle);
    }

    return chunks.join("").split("\n").filter(Boolean).slice(-maxLines);
  }

  private countNewlines(value: string) {
    let count = 0;

    for (const char of value) {
      if (char === "\n") {
        count += 1;
      }
    }

    return count;
  }

  private auditContainsDeviceCode(entry: SystemAuditLogEntry, deviceCode: string) {
    return [entry.path, entry.body, entry.query, entry.params, entry.response, entry.error, entry.metadata]
      .some((value) => this.stringifyForSearch(value).includes(deviceCode));
  }

  private stringifyForSearch(value: unknown) {
    if (value === undefined || value === null) {
      return "";
    }

    if (typeof value === "string") {
      return value;
    }

    try {
      return JSON.stringify(value);
    } catch {
      return "";
    }
  }

  private operationLogBelongsToTenant(
    log: OperationLogRecord,
    tenantId: string
  ) {
    const explicitTenantIds = new Set<string>();
    const addUserTenant = (userId?: string) => {
      if (!userId) {
        return;
      }

      const user = this.store.users.find((entry) => entry.id === userId);
      if (user) {
        const userTenantId = this.store.getUserTenantId(user);
        if (userTenantId) {
          explicitTenantIds.add(userTenantId);
        }
      }
    };
    const addDeviceTenant = (deviceCode?: string) => {
      if (!deviceCode) {
        return;
      }

      const device = this.store.devices.find(
        (entry) => entry.deviceCode === deviceCode
      );
      if (device) {
        explicitTenantIds.add(this.store.getDeviceTenantId(device));
      }
    };
    const addEventTenant = (eventReference?: string) => {
      if (!eventReference) {
        return;
      }

      const event = this.store.events.find(
        (entry) =>
          entry.eventId === eventReference ||
          entry.orderNo === eventReference
      );
      if (!event) {
        return;
      }

      addUserTenant(event.userId);
      addDeviceTenant(event.deviceCode);
    };
    const addSubjectTenant = (subject?: OperationLogSubject) => {
      if (subject?.type === "user") {
        addUserTenant(subject.id);
      } else if (subject?.type === "device") {
        addDeviceTenant(subject.id);
      } else if (subject?.type === "event") {
        addEventTenant(subject.id);
      }
    };
    const readMetadataString = (key: string) => {
      const value = log.metadata?.[key];
      return typeof value === "string" && value.trim() ? value : undefined;
    };

    const metadataTenantId = readMetadataString("tenantId");
    if (metadataTenantId) {
      explicitTenantIds.add(metadataTenantId);
    }

    const targetTenantId = readMetadataString("targetTenantId");
    if (targetTenantId) {
      explicitTenantIds.add(targetTenantId);
    }

    addSubjectTenant(log.primarySubject);
    addSubjectTenant(log.secondarySubject);
    addEventTenant(log.relatedEventId);

    for (const key of [
      "userId",
      "targetUserId",
      "sourceUserId",
      "ownerUserId",
      "confirmedByUserId",
      "undoneByUserId"
    ]) {
      addUserTenant(readMetadataString(key));
    }

    for (const key of ["deviceCode", "targetDeviceCode"]) {
      addDeviceTenant(readMetadataString(key));
    }

    for (const key of ["eventId", "relatedEventId"]) {
      addEventTenant(readMetadataString(key));
    }

    if (explicitTenantIds.size > 0) {
      return [...explicitTenantIds].every(
        (candidateTenantId) => candidateTenantId === tenantId
      );
    }

    const actorUser = log.actor.id
      ? this.store.users.find((entry) => entry.id === log.actor.id)
      : undefined;

    return actorUser
      ? this.store.getUserTenantId(actorUser) === tenantId
      : false;
  }

  private involvesHiddenBackofficeUser(log: OperationLogRecord) {
    const possibleUserIds = [
      log.actor.id,
      log.primarySubject?.type === "user" ? log.primarySubject.id : undefined,
      log.secondarySubject?.type === "user" ? log.secondarySubject.id : undefined,
      typeof log.metadata?.userId === "string" ? log.metadata.userId : undefined,
      typeof log.metadata?.targetUserId === "string" ? log.metadata.targetUserId : undefined,
      typeof log.metadata?.confirmedByUserId === "string" ? log.metadata.confirmedByUserId : undefined,
      typeof log.metadata?.undoneByUserId === "string" ? log.metadata.undoneByUserId : undefined
    ].filter((value): value is string => Boolean(value));

    return possibleUserIds.some((userId) => {
      const user = this.store.users.find((entry) => entry.id === userId);
      return this.store.isHiddenBackofficeUser(user);
    });
  }

  undo(
    id: string,
    actorUserId?: string,
    actorBackofficeRole?: BackofficeRole,
    actorTenantId?: string
  ) {
    const log = this.detail(id, actorBackofficeRole, actorTenantId);

    if (log.metadata?.undoState !== "undoable") {
      throw new BadRequestException("该日志记录不支持撤销。");
    }

    switch (log.type) {
      case "manual-restock":
        return this.undoManualRestock(log, actorUserId);
      case "manual-deduction":
        return this.undoManualDeduction(log, actorUserId);
      case "update-user":
      case "batch-update-user":
        return this.undoUserUpdate(log, actorUserId);
      case "create-goods-catalog":
      case "update-goods-catalog":
        return this.undoGoodsCatalog(log, actorUserId);
      case "manual-add-batch":
        return this.undoManualAddBatch(log, actorUserId);
      case "manual-remove-batch":
        return this.undoManualRemoveBatch(log, actorUserId);
      default:
        throw new BadRequestException("该日志类型暂不支持撤销。");
    }
  }

  private undoManualRestock(log: OperationLogRecord, actorUserId?: string) {
    const batchId = this.readString(log.metadata?.batchId, "缺少批次编号。");
    const deviceCode = this.readString(log.metadata?.deviceCode, "缺少柜机编号。");
    const goodsId = this.readString(log.metadata?.goodsId, "缺少货品编号。");
    const quantity = this.readNumber(log.metadata?.quantity, "缺少数量信息。");
    const goods = this.store.goodsCatalog.find((entry) => entry.goodsId === goodsId);
    const change = this.inventoryBatchChanges.undoRestockBatchChange({
      batchId,
      quantity,
      movement: this.buildUndoMovement({
        userId: actorUserId,
        deviceCode,
        goodsId,
        goodsName: goods?.name ?? goodsId,
        category: goods?.category ?? "daily",
        quantity,
        unitPrice: goods?.price ?? 0,
        type: "manual-deduction"
      })
    });
    const undoQuantity = change.movements[0]?.quantity ?? quantity;

    const undoLog = this.store.logOperation({
      category: "inventory",
      type: "undo-manual-restock",
      status: "success",
      actor: this.getAdminActor(actorUserId),
      primarySubject: {
        type: "device",
        id: deviceCode,
        label: this.getDeviceLabel(deviceCode)
      },
      secondarySubject: {
        type: "goods",
        id: goodsId,
        label: goods?.name ?? goodsId
      },
      metadata: {
        deviceCode,
        goodsId,
        goodsName: goods?.name ?? goodsId,
        quantity: undoQuantity,
        sourceLogId: log.id,
        undoState: "not_undoable"
      }
    });

    this.inventoryBatchChanges.markConsumptionTracesReverted(log.id, undoLog.id);
    this.markAsUndone(log, actorUserId, undoLog.id);
    return undoLog;
  }

  private undoManualDeduction(log: OperationLogRecord, actorUserId?: string) {
    const deviceCode = this.readString(log.metadata?.deviceCode, "缺少柜机编号。");
    const goodsId = this.readString(log.metadata?.goodsId, "缺少货品编号。");
    const consumedBatches = Array.isArray(log.metadata?.consumedBatches)
      ? (log.metadata?.consumedBatches as Array<{ batchId: string; quantity: number }>)
      : [];
    const goods = this.store.goodsCatalog.find((entry) => entry.goodsId === goodsId);
    const change = this.inventoryBatchChanges.undoConsumptiveBatchChange({
      deviceCode,
      consumedBatches,
      movement: this.buildUndoMovement({
        userId: actorUserId,
        deviceCode,
        goodsId,
        goodsName: goods?.name ?? goodsId,
        category: goods?.category ?? "daily",
        quantity: 0,
        unitPrice: goods?.price ?? 0,
        type: "manual-restock"
      })
    });
    const restoredQuantity = change.movements[0]?.quantity ?? 0;

    const undoLog = this.store.logOperation({
      category: "inventory",
      type: "undo-manual-deduction",
      status: "success",
      actor: this.getAdminActor(actorUserId),
      primarySubject: {
        type: "device",
        id: deviceCode,
        label: this.getDeviceLabel(deviceCode)
      },
      secondarySubject: {
        type: "goods",
        id: goodsId,
        label: goods?.name ?? goodsId
      },
      metadata: {
        deviceCode,
        goodsId,
        goodsName: goods?.name ?? goodsId,
        quantity: restoredQuantity,
        sourceLogId: log.id,
        undoState: "not_undoable"
      }
    });

    this.inventoryBatchChanges.markConsumptionTracesReverted(log.id, undoLog.id);
    this.markAsUndone(log, actorUserId, undoLog.id);
    return undoLog;
  }

  private undoUserUpdate(log: OperationLogRecord, actorUserId?: string) {
    const userId = log.primarySubject?.id;

    if (!userId) {
      throw new BadRequestException("缺少人员主体信息。");
    }

    const user = this.store.users.find((entry) => entry.id === userId);
    const beforeSnapshot = log.metadata?.beforeSnapshot as UserRecord | undefined;

    if (!user || !beforeSnapshot) {
      throw new NotFoundException("未找到可恢复的人员快照。");
    }
    if (this.store.isControlledProviderUser(user)) {
      throw new BadRequestException(
        "服务商根账号不能通过客户实例操作日志修改。"
      );
    }

    assertTenantsKeepActiveBackofficeAdmin(this.store, [
      {
        user,
        nextRole: beforeSnapshot.role,
        nextStatus: beforeSnapshot.status
      }
    ]);
    const accessWillChange =
      user.role !== beforeSnapshot.role || user.status !== beforeSnapshot.status;
    Object.assign(user, beforeSnapshot, {
      tenantId: user.tenantId,
      tags: Array.isArray(beforeSnapshot.tags)
        ? beforeSnapshot.tags.filter(
            (tag) =>
              typeof tag === "string" &&
              !RESERVED_BACKOFFICE_USER_TAGS.has(tag)
          )
        : user.tags
    });
    if (accessWillChange) {
      this.store.revokeSessionsForUser(user.id);
    }

    const undoLog = this.store.logOperation({
      category: "user",
      type: "undo-user-update",
      status: "success",
      actor: this.getAdminActor(actorUserId),
      primarySubject: {
        type: "user",
        id: user.id,
        label: user.name
      },
      metadata: {
        sourceLogId: log.id,
        undoState: "not_undoable"
      }
    });

    this.markAsUndone(log, actorUserId, undoLog.id);
    return undoLog;
  }

  private undoGoodsCatalog(log: OperationLogRecord, actorUserId?: string) {
    const goodsId = log.primarySubject?.id ?? this.readString(log.metadata?.goodsId, "缺少货品编号。");
    const goods = this.store.goodsCatalog.find((entry) => entry.goodsId === goodsId);

    if (!goods) {
      throw new NotFoundException("未找到对应货品。");
    }

    if (log.type === "create-goods-catalog") {
      goods.status = "inactive";
      goods.updatedAt = new Date().toISOString();
    } else {
      const beforeSnapshot = log.metadata?.beforeSnapshot as Partial<typeof goods> | undefined;

      if (!beforeSnapshot) {
        throw new BadRequestException("缺少货品变更前快照。");
      }

      Object.assign(goods, beforeSnapshot, {
        updatedAt: new Date().toISOString()
      });
    }

    const undoLog = this.store.logOperation({
      category: "goods",
      type: "undo-goods-catalog",
      status: "success",
      actor: this.getAdminActor(actorUserId),
      primarySubject: {
        type: "goods",
        id: goods.goodsId,
        label: goods.name
      },
      metadata: {
        sourceLogId: log.id,
        goodsId: goods.goodsId,
        goodsName: goods.name,
        undoState: "not_undoable"
      }
    });

    this.markAsUndone(log, actorUserId, undoLog.id);
    return undoLog;
  }

  private undoManualAddBatch(log: OperationLogRecord, actorUserId?: string) {
    const batchId = this.readString(log.metadata?.batchId, "缺少批次编号。");
    const goodsId = this.readString(log.metadata?.goodsId, "缺少货品编号。");
    const deviceCode = this.readString(log.metadata?.deviceCode, "缺少柜机编号。");
    const quantity = this.readNumber(log.metadata?.quantity, "缺少数量信息。");
    const goods = this.store.goodsCatalog.find((entry) => entry.goodsId === goodsId);
    const change = this.inventoryBatchChanges.undoRestockBatchChange({
      batchId,
      quantity,
      movement: this.buildUndoMovement({
        userId: actorUserId,
        deviceCode,
        goodsId,
        goodsName: goods?.name ?? goodsId,
        category: goods?.category ?? "daily",
        quantity,
        unitPrice: goods?.price ?? 0,
        type: "manual-deduction",
        batchId
      })
    });
    const undoQuantity = change.movements[0]?.quantity ?? quantity;

    const undoLog = this.store.logOperation({
      category: "goods",
      type: "undo-manual-add-batch",
      status: "success",
      actor: this.getAdminActor(actorUserId),
      primarySubject: {
        type: "goods",
        id: goodsId,
        label: goods?.name ?? goodsId
      },
      secondarySubject: {
        type: "device",
        id: deviceCode,
        label: this.getDeviceLabel(deviceCode)
      },
      metadata: {
        sourceLogId: log.id,
        goodsId,
        goodsName: goods?.name ?? goodsId,
        deviceCode,
        quantity: undoQuantity,
        undoState: "not_undoable"
      }
    });

    this.markAsUndone(log, actorUserId, undoLog.id);
    return undoLog;
  }

  private undoManualRemoveBatch(log: OperationLogRecord, actorUserId?: string) {
    const batchId = this.readString(log.metadata?.batchId, "缺少批次编号。");
    const goodsId = this.readString(log.metadata?.goodsId, "缺少货品编号。");
    const deviceCode = this.readString(log.metadata?.deviceCode, "缺少柜机编号。");
    const quantity = this.readNumber(log.metadata?.quantity, "缺少数量信息。");
    const goods = this.store.goodsCatalog.find((entry) => entry.goodsId === goodsId);
    const change = this.inventoryBatchChanges.restoreRemovedBatch({
      batchId,
      quantity,
      movement: this.buildUndoMovement({
        userId: actorUserId,
        deviceCode,
        goodsId,
        goodsName: goods?.name ?? goodsId,
        category: goods?.category ?? "daily",
        quantity,
        unitPrice: goods?.price ?? 0,
        type: "manual-restock",
        batchId
      })
    });
    const undoQuantity = change.movements[0]?.quantity ?? quantity;

    const undoLog = this.store.logOperation({
      category: "goods",
      type: "undo-manual-remove-batch",
      status: "success",
      actor: this.getAdminActor(actorUserId),
      primarySubject: {
        type: "goods",
        id: goodsId,
        label: goods?.name ?? goodsId
      },
      secondarySubject: {
        type: "device",
        id: deviceCode,
        label: this.getDeviceLabel(deviceCode)
      },
      metadata: {
        sourceLogId: log.id,
        goodsId,
        goodsName: goods?.name ?? goodsId,
        deviceCode,
        quantity: undoQuantity,
        undoState: "not_undoable"
      }
    });

    this.inventoryBatchChanges.markConsumptionTracesReverted(log.id, undoLog.id);
    this.markAsUndone(log, actorUserId, undoLog.id);
    return undoLog;
  }

  private markAsUndone(log: OperationLogRecord, actorUserId: string | undefined, undoLogId: string) {
    log.metadata = {
      ...(log.metadata ?? {}),
      undoState: "undone",
      undoneAt: new Date().toISOString(),
      undoneByUserId: actorUserId,
      undoLogId
    };
  }

  private buildUndoMovement(payload: {
    userId?: string;
    deviceCode: string;
    goodsId: string;
    goodsName: string;
    category: InventoryMovement["category"];
    quantity: number;
    unitPrice: number;
    type: InventoryMovement["type"];
    batchId?: string;
  }): InventoryMovement {
    return {
      id: this.store.createId("movement"),
      userId:
        payload.userId ??
        this.store.users.find((entry) => entry.role === "admin")?.id ??
        "system",
      deviceCode: payload.deviceCode,
      batchId: payload.batchId,
      goodsId: payload.goodsId,
      goodsName: payload.goodsName,
      category: payload.category,
      quantity: payload.quantity,
      unitPrice: payload.unitPrice,
      type: payload.type,
      happenedAt: new Date().toISOString()
    };
  }

  private readString(value: unknown, message: string) {
    if (typeof value !== "string" || !value) {
      throw new BadRequestException(message);
    }

    return value;
  }

  private readNumber(value: unknown, message: string) {
    if (typeof value !== "number" || Number.isNaN(value)) {
      throw new BadRequestException(message);
    }

    return value;
  }

  private getDeviceLabel(deviceCode: string) {
    return this.store.devices.find((entry) => entry.deviceCode === deviceCode)?.name ?? deviceCode;
  }

  private getAdminActor(actorUserId?: string) {
    const admin =
      this.store.users.find((entry) => entry.id === actorUserId) ??
      this.store.users.find((entry) => entry.role === "admin");

    if (admin) {
      return {
        type: "admin" as const,
        id: admin.id,
        name: admin.name,
        role: admin.role
      };
    }

    return {
      type: "system" as const,
      name: "系统"
    };
  }
}
