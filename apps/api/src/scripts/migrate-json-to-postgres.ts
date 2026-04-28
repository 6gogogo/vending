import { existsSync, readFileSync } from "node:fs";

import {
  readPersistedState,
  resolveSystemLogFile
} from "../common/store/persistence";

const prismaPackageName = "@prisma/client";

const readAuditLines = () => {
  const filePath = resolveSystemLogFile();

  if (!existsSync(filePath)) {
    return [];
  }

  return readFileSync(filePath, "utf8")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line, index) => {
      try {
        return JSON.parse(line) as Record<string, unknown>;
      } catch {
        return {
          id: `audit-invalid-${index}`,
          occurredAt: new Date().toISOString(),
          method: "UNKNOWN",
          path: "invalid-json",
          statusCode: 500,
          raw: line
        };
      }
    });
};

const upsertJsonRows = async <T extends object>(
  model: {
    upsert: (payload: {
      where: Record<string, unknown>;
      create: Record<string, unknown>;
      update: Record<string, unknown>;
    }) => Promise<unknown>;
  },
  rows: T[],
  key: keyof T,
  mapRow: (row: T) => Record<string, unknown>
) => {
  for (const row of rows) {
    const id = row[key];

    if (typeof id !== "string" || !id) {
      continue;
    }

    const data = mapRow(row);
    await model.upsert({
      where: { [String(key)]: id },
      create: data,
      update: data
    });
  }
};

const main = async () => {
  const state = readPersistedState();

  if (!state) {
    throw new Error("未找到 API_DATA_FILE 指向的 store.json，无法迁移。");
  }

  const { PrismaClient } = await import(prismaPackageName);
  const prisma = new PrismaClient();

  await upsertJsonRows(prisma.user, state.users, "id", (row) => ({
    id: row.id,
    role: row.role,
    phone: row.phone,
    name: row.name,
    status: row.status,
    neighborhood: row.neighborhood,
    regionId: row.regionId,
    regionName: row.regionName,
    ledgerStatus: row.ledgerStatus,
    tags: row.tags,
    quota: row.quota,
    profile: row.profile,
    merchantProfile: row.merchantProfile,
    accessPolicies: row.accessPolicies,
    reservationTimeoutCount: row.reservationTimeoutCount,
    reservationDisabledAt: row.reservationDisabledAt,
    reservationDisabledReason: row.reservationDisabledReason,
    mobileProfileCompleted: row.mobileProfileCompleted ?? false,
    createdAt: undefined,
    updatedAt: undefined
  }));

  await upsertJsonRows(prisma.adminCredential, state.adminCredentials, "userId", (row) => ({
    ...row
  }));

  const backofficeCredentials = state.backofficeCredentials.length
    ? state.backofficeCredentials
    : state.adminCredentials.map((entry) => ({
        ...entry,
        role: "super_admin"
      }));

  for (const credential of backofficeCredentials) {
    const id = `${credential.role}:${credential.userId}`;
    await prisma.backofficeCredential.upsert({
      where: { id },
      create: {
        id,
        ...credential
      },
      update: {
        ...credential
      }
    });
  }

  for (const [token, session] of state.sessions) {
    await prisma.session.upsert({
      where: { token },
      create: session,
      update: session
    });
  }

  for (const [token, draft] of state.draftSessions) {
    await prisma.draftSession.upsert({
      where: { token },
      create: draft,
      update: draft
    });
  }

  for (const [phone, record] of state.verificationCodes) {
    await prisma.verificationCode.upsert({
      where: { phone },
      create: { phone, ...record },
      update: record
    });
  }

  await upsertJsonRows(prisma.device, state.devices, "deviceCode", (row) => ({
    deviceCode: row.deviceCode,
    name: row.name,
    status: row.status,
    data: row
  }));

  for (const [deviceCode, runtime] of state.deviceRuntime) {
    await prisma.deviceRuntime.upsert({
      where: { deviceCode },
      create: { deviceCode, data: runtime },
      update: { data: runtime }
    });
  }

  await upsertJsonRows(prisma.goodsCatalogItem, state.goodsCatalog, "goodsId", (row) => ({
    goodsId: row.goodsId,
    name: row.name,
    status: row.status,
    data: row
  }));
  await upsertJsonRows(prisma.goodsCategory, state.goodsCategories, "id", (row) => ({
    id: row.id,
    name: row.name,
    status: row.status,
    data: row
  }));
  await upsertJsonRows(prisma.region, state.regions, "id", (row) => ({
    id: row.id,
    name: row.name,
    status: row.status,
    data: row
  }));
  await upsertJsonRows(prisma.warehouse, state.warehouses, "code", (row) => ({
    code: row.code,
    name: row.name,
    status: row.status,
    data: row
  }));
  await upsertJsonRows(prisma.registrationApplication, state.registrationApplications, "id", (row) => ({
    id: row.id,
    phone: row.phone,
    requestedRole: row.requestedRole,
    status: row.status,
    data: row
  }));
  await upsertJsonRows(prisma.merchantGoodsTemplate, state.merchantGoodsTemplates, "id", (row) => ({
    id: row.id,
    ownerUserId: row.ownerUserId,
    goodsName: row.goodsName,
    status: row.status,
    data: row
  }));
  await upsertJsonRows(prisma.goodsBatch, state.goodsBatches, "batchId", (row) => ({
    batchId: row.batchId,
    goodsId: row.goodsId,
    deviceCode: row.deviceCode,
    remainingQuantity: row.remainingQuantity,
    data: row
  }));
  await upsertJsonRows(prisma.batchConsumptionTrace, state.batchConsumptionTraces, "id", (row) => ({
    id: row.id,
    batchId: row.batchId,
    goodsId: row.goodsId,
    deviceCode: row.deviceCode,
    sourceUserId: row.sourceUserId,
    consumerUserId: row.consumerUserId,
    happenedAt: row.happenedAt,
    data: row
  }));
  await upsertJsonRows(prisma.inventoryMovement, state.inventory, "id", (row) => ({
    id: row.id,
    orderNo: row.orderNo,
    userId: row.userId,
    deviceCode: row.deviceCode,
    goodsId: row.goodsId,
    type: row.type,
    happenedAt: row.happenedAt,
    data: row
  }));
  await upsertJsonRows(prisma.cabinetEvent, state.events, "eventId", (row) => ({
    eventId: row.eventId,
    orderNo: row.orderNo,
    userId: row.userId,
    role: row.role,
    deviceCode: row.deviceCode,
    status: row.status,
    amount: row.amount,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    data: row
  }));
  await upsertJsonRows(prisma.paymentOrder, state.paymentOrders, "id", (row) => row as unknown as Record<string, unknown>);
  await upsertJsonRows(prisma.paymentRefund, state.paymentRefunds, "id", (row) => row as unknown as Record<string, unknown>);
  await upsertJsonRows(prisma.reservation, state.reservations, "id", (row) => ({
    id: row.id,
    userId: row.userId,
    phone: row.phone,
    deviceCode: row.deviceCode,
    doorNum: row.doorNum,
    status: row.status,
    reservedAt: row.reservedAt,
    expiresAt: row.expiresAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    data: row
  }));
  await prisma.reservationSetting.upsert({
    where: { id: "default" },
    create: {
      id: "default",
      enabled: state.reservationSettings.enabled,
      data: state.reservationSettings,
      updatedAt: state.reservationSettings.updatedAt
    },
    update: {
      enabled: state.reservationSettings.enabled,
      data: state.reservationSettings,
      updatedAt: state.reservationSettings.updatedAt
    }
  });
  await upsertJsonRows(prisma.alert, state.alerts, "id", (row) => ({
    id: row.id,
    type: row.type,
    grade: row.grade,
    status: row.status,
    dueAt: row.dueAt,
    targetUserId: row.targetUserId,
    data: row
  }));
  await upsertJsonRows(prisma.operationLog, state.logs, "id", (row) => ({
    id: row.id,
    category: row.category,
    type: row.type,
    status: row.status,
    occurredAt: row.occurredAt,
    actorId: typeof row.actor === "object" && row.actor ? (row.actor as { id?: unknown }).id : undefined,
    data: row
  }));
  await upsertJsonRows(prisma.callbackLog, state.callbackLog, "id", (row) => ({
    id: row.id,
    type: row.type,
    receivedAt: row.receivedAt,
    payload: row.payload
  }));

  for (const [index, entry] of readAuditLines().entries()) {
    const id = typeof entry.id === "string" ? entry.id : `audit-${index}`;
    await prisma.systemAuditLog.upsert({
      where: { id },
      create: {
        id,
        occurredAt: typeof entry.occurredAt === "string" ? entry.occurredAt : new Date().toISOString(),
        method: typeof entry.method === "string" ? entry.method : "UNKNOWN",
        path: typeof entry.path === "string" ? entry.path : "",
        statusCode: typeof entry.statusCode === "number" ? entry.statusCode : 0,
        actorUserId: typeof entry.actorUserId === "string" ? entry.actorUserId : undefined,
        actorRole: typeof entry.actorRole === "string" ? entry.actorRole : undefined,
        data: entry
      },
      update: {
        data: entry
      }
    });
  }

  const policyRows = [
    ["access-rule", state.rules],
    ["special-access-policy", state.specialAccessPolicies],
    ["goods-alert-policy", state.goodsAlertPolicies],
    ["device-goods-setting", state.deviceGoodsSettings],
    ["inventory-transfer", state.inventoryTransfers],
    ["stocktake", state.stocktakes]
  ] as const;

  for (const [kind, rows] of policyRows) {
    for (const row of rows) {
      const record = row as unknown as Record<string, unknown>;
      const id = String(record.id ?? record.code ?? record.batchId ?? `${kind}-${JSON.stringify(record).length}`);
      await prisma.policyBlob.upsert({
        where: { id: `${kind}:${id}` },
        create: {
          id: `${kind}:${id}`,
          kind,
          status: typeof record.status === "string" ? record.status : undefined,
          data: record
        },
        update: {
          status: typeof record.status === "string" ? record.status : undefined,
          data: record
        }
      });
    }
  }

  await prisma.$disconnect();
  console.log("JSON 数据已迁移到 PostgreSQL。");
};

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
