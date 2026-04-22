import type { AlertTask, OperationLogCategory, OperationLogRecord, OperationLogSubject } from "@vm/shared-types";

const joinParts = (parts: Array<string | undefined>) => parts.filter(Boolean).join(" · ");

const readString = (value: unknown) => {
  if (typeof value !== "string") {
    return undefined;
  }

  const trimmed = value.trim();
  return trimmed || undefined;
};

const pickSubjectByType = (
  subjects: Array<OperationLogSubject | undefined>,
  type: OperationLogSubject["type"]
) =>
  subjects.find(
    (subject): subject is OperationLogSubject => subject !== undefined && subject.type === type
  );

const readMetadataString = (log: OperationLogRecord, key: string) => readString(log.metadata?.[key]);

export const formatActorTypeLabel = (type: OperationLogRecord["actor"]["type"]) => {
  if (type === "admin") {
    return "管理员";
  }

  if (type === "merchant") {
    return "商户";
  }

  if (type === "special") {
    return "用户";
  }

  return "系统";
};

export const formatLogCategoryLabel = (category: OperationLogCategory) => {
  if (category === "pickup") {
    return "取货";
  }

  if (category === "restock") {
    return "补货";
  }

  if (category === "device") {
    return "柜机";
  }

  if (category === "admin") {
    return "管理";
  }

  if (category === "alert") {
    return "预警";
  }

  if (category === "inventory") {
    return "库存";
  }

  if (category === "user") {
    return "人员";
  }

  if (category === "policy") {
    return "策略";
  }

  return "货品";
};

export const formatSubjectTypeLabel = (type: OperationLogSubject["type"]) => {
  if (type === "user") {
    return "人员";
  }

  if (type === "device") {
    return "柜机";
  }

  if (type === "event") {
    return "事件";
  }

  if (type === "alert") {
    return "预警";
  }

  if (type === "goods") {
    return "货品";
  }

  if (type === "warehouse") {
    return "仓库";
  }

  return "盘点";
};

export const pickAlertGoodsLabel = (task: AlertTask) => readString(task.goodsSummary) ?? readString(task.goodsName);

export const pickAlertUserLabel = (task: AlertTask) =>
  readString(task.targetUserName) ?? readString(task.targetUserId);

export const pickAlertDeviceLabel = (task: AlertTask) =>
  readString(task.deviceName) ?? readString(task.deviceCode);

export const buildAlertContextSummary = (task: AlertTask) =>
  joinParts([
    pickAlertGoodsLabel(task) ? `商品 ${pickAlertGoodsLabel(task)}` : undefined,
    pickAlertUserLabel(task) ? `人员 ${pickAlertUserLabel(task)}` : undefined,
    pickAlertDeviceLabel(task) ? `柜机 ${pickAlertDeviceLabel(task)}` : undefined
  ]);

export const buildAlertReferenceSummary = (task: AlertTask) =>
  joinParts([
    task.relatedEventId ? `事件 ${task.relatedEventId}` : undefined,
    task.sourceLogId ? `日志 ${task.sourceLogId}` : undefined
  ]);

export const buildAlertIdentitySummary = (task: AlertTask) =>
  joinParts([
    task.goodsId && task.goodsName ? `货品编号 ${task.goodsId}` : undefined,
    task.targetUserId && task.targetUserName && task.targetUserId !== task.targetUserName
      ? `人员编号 ${task.targetUserId}`
      : undefined,
    task.deviceCode && task.deviceName && task.deviceCode !== task.deviceName
      ? `柜机编号 ${task.deviceCode}`
      : undefined
  ]);

const pickLogSubjectLabel = (log: OperationLogRecord, type: OperationLogSubject["type"]) => {
  const subject = pickSubjectByType([log.primarySubject, log.secondarySubject], type);

  if (!subject) {
    return undefined;
  }

  return readString(subject.label) ?? readString(subject.id);
};

export const pickLogGoodsLabel = (log: OperationLogRecord) =>
  readMetadataString(log, "goodsSummary") ??
  readMetadataString(log, "goodsName") ??
  pickLogSubjectLabel(log, "goods");

export const pickLogUserLabel = (log: OperationLogRecord) =>
  readMetadataString(log, "targetUserName") ??
  readMetadataString(log, "targetUserId") ??
  pickLogSubjectLabel(log, "user");

export const pickLogDeviceLabel = (log: OperationLogRecord) =>
  readMetadataString(log, "deviceName") ??
  readMetadataString(log, "deviceCode") ??
  pickLogSubjectLabel(log, "device");

export const buildLogContextSummary = (log: OperationLogRecord) =>
  joinParts([
    pickLogGoodsLabel(log) ? `商品 ${pickLogGoodsLabel(log)}` : undefined,
    pickLogUserLabel(log) ? `人员 ${pickLogUserLabel(log)}` : undefined,
    pickLogDeviceLabel(log) ? `柜机 ${pickLogDeviceLabel(log)}` : undefined
  ]);

export const buildLogReferenceSummary = (log: OperationLogRecord) =>
  joinParts([
    log.relatedOrderNo ? `订单 ${log.relatedOrderNo}` : undefined,
    log.relatedEventId ? `事件 ${log.relatedEventId}` : undefined
  ]);

export const buildLogSubjectSummary = (log: OperationLogRecord) => {
  const subjects = [log.primarySubject, log.secondarySubject]
    .filter((subject): subject is OperationLogSubject => Boolean(subject))
    .map((subject) => `${formatSubjectTypeLabel(subject.type)} ${subject.label || subject.id}`);

  return joinParts(Array.from(new Set(subjects)));
};
