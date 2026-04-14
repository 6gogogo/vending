import type { OperationLogActor, OperationLogRecord, OperationLogStatus, OperationLogSubject } from "@vm/shared-types";

type OperationLogDraft = Omit<OperationLogRecord, "description" | "detail"> &
  Partial<Pick<OperationLogRecord, "description" | "detail">>;

const roleLabelMap = {
  admin: "管理员",
  merchant: "商户",
  special: "特殊群体",
  system: "系统"
} as const;

const statusLabelMap: Record<OperationLogStatus, string> = {
  success: "已完成",
  pending: "待处理",
  warning: "需关注",
  failed: "失败"
};

const actorLabel = (actor: OperationLogActor) =>
  actor.type === "system" ? actor.name : `${roleLabelMap[actor.type]}${actor.name}`;

const subjectLabel = (subject?: OperationLogSubject, fallback = "未命名对象") =>
  subject?.label || subject?.id || fallback;

const pickDeviceLabel = (entry: OperationLogDraft) => {
  if (entry.primarySubject?.type === "device") {
    return subjectLabel(entry.primarySubject, "柜机");
  }

  if (entry.secondarySubject?.type === "device") {
    return subjectLabel(entry.secondarySubject, "柜机");
  }

  if (typeof entry.metadata?.deviceCode === "string") {
    return String(entry.metadata.deviceCode);
  }

  return "柜机";
};

const pickGoodsLabel = (entry: OperationLogDraft) => {
  if (entry.primarySubject?.type === "goods") {
    return subjectLabel(entry.primarySubject, "货品");
  }

  if (entry.secondarySubject?.type === "goods") {
    return subjectLabel(entry.secondarySubject, "货品");
  }

  if (typeof entry.metadata?.goodsName === "string") {
    return String(entry.metadata.goodsName);
  }

  if (typeof entry.metadata?.goodsId === "string") {
    return String(entry.metadata.goodsId);
  }

  return "货品";
};

const pickQuantity = (entry: OperationLogDraft) => {
  if (typeof entry.metadata?.quantity === "number") {
    return entry.metadata.quantity;
  }

  return undefined;
};

const baseDetail = (parts: Array<string | undefined>) => parts.filter(Boolean).join("；");

export const formatOperationLog = (entry: OperationLogDraft): Pick<OperationLogRecord, "description" | "detail"> => {
  const actor = actorLabel(entry.actor);
  const device = pickDeviceLabel(entry);
  const goods = pickGoodsLabel(entry);
  const quantity = pickQuantity(entry);
  const primary = subjectLabel(entry.primarySubject);
  const secondary = subjectLabel(entry.secondarySubject);
  const result = statusLabelMap[entry.status];

  switch (entry.type) {
    case "inventory-pickup":
      return {
        description: `${actor}在${device}取走了${goods}${quantity ? ` x${quantity}` : ""}。`,
        detail: baseDetail([`动作人 ${actor}`, `柜机 ${device}`, `货品 ${goods}`, quantity ? `数量 ${quantity}` : undefined, `状态 ${result}`])
      };
    case "inventory-restock":
      return {
        description: `${actor}向${device}补充了${goods}${quantity ? ` x${quantity}` : ""}。`,
        detail: baseDetail([`动作人 ${actor}`, `柜机 ${device}`, `货品 ${goods}`, quantity ? `数量 ${quantity}` : undefined, `状态 ${result}`])
      };
    case "manual-restock":
      return {
        description: `${actor}修改了${device}的${goods}存货量，增加${quantity ?? 0}件。`,
        detail: baseDetail([`关联人员 ${primary}`, `柜机 ${device}`, `货品 ${goods}`, quantity ? `增加 ${quantity} 件` : undefined, `状态 ${result}`])
      };
    case "manual-deduction":
      return {
        description: `${actor}修改了${device}的${goods}存货量，减少${quantity ?? 0}件。`,
        detail: baseDetail([`关联人员 ${primary}`, `柜机 ${device}`, `货品 ${goods}`, quantity ? `减少 ${quantity} 件` : undefined, `状态 ${result}`])
      };
    case "remote-open-device":
      return {
        description: `${actor}向${device}下发了远程开门指令。`,
        detail: baseDetail([`动作人 ${actor}`, `柜机 ${device}`, `关联事件 ${secondary}`, `状态 ${result}`])
      };
    case "manual-refresh-device":
      return {
        description: `${actor}刷新了${device}的状态。`,
        detail: baseDetail([`动作人 ${actor}`, `柜机 ${device}`, `状态 ${result}`])
      };
    case "door-status-callback":
      return {
        description: `系统更新了${device}的门状态，结果为${String(entry.metadata?.status ?? result)}。`,
        detail: baseDetail([`柜机 ${device}`, `关联事件 ${secondary}`, `回调状态 ${String(entry.metadata?.status ?? entry.status)}`, `状态 ${result}`])
      };
    case "open-cabinet":
      return {
        description: `${actor}向${device}发起了开柜请求。`,
        detail: baseDetail([`动作人 ${actor}`, `柜机 ${device}`, `关联人员 ${secondary}`, `状态 ${result}`])
      };
    case "settlement-callback":
      return {
        description: `系统完成了${device}的结算处理，订单${secondary}已入库。`,
        detail: baseDetail([`柜机 ${device}`, `关联事件 ${secondary}`, `金额 ${String(entry.metadata?.amount ?? 0)}`, `状态 ${result}`])
      };
    case "adjustment-callback":
      return {
        description: `系统处理了${device}的补扣结果，当前结果为${result}。`,
        detail: baseDetail([`柜机 ${device}`, `关联事件 ${secondary}`, `补扣金额 ${String(entry.metadata?.amount ?? 0)}`, `状态 ${result}`])
      };
    case "payment-success-callback":
      return {
        description: `系统确认了${device}的支付成功通知。`,
        detail: baseDetail([`柜机 ${device}`, `关联事件 ${secondary}`, typeof entry.metadata?.transactionId === "string" ? `交易号 ${entry.metadata.transactionId}` : undefined, `状态 ${result}`])
      };
    case "auto-payment-success":
      return {
        description: `系统向${device}回写了付款成功结果。`,
        detail: baseDetail([
          `柜机 ${device}`,
          `关联事件 ${secondary}`,
          typeof entry.metadata?.transactionId === "string" ? `交易号 ${entry.metadata.transactionId}` : undefined,
          typeof entry.metadata?.targetUrl === "string" ? `目标 ${entry.metadata.targetUrl}` : undefined,
          `状态 ${result}`
        ])
      };
    case "manual-payment-success":
      return {
        description: `${actor}向${device}回写了付款成功结果。`,
        detail: baseDetail([
          `动作人 ${actor}`,
          `柜机 ${device}`,
          `关联事件 ${secondary}`,
          typeof entry.metadata?.transactionId === "string" ? `交易号 ${entry.metadata.transactionId}` : undefined,
          typeof entry.metadata?.targetUrl === "string" ? `目标 ${entry.metadata.targetUrl}` : undefined,
          `状态 ${result}`
        ])
      };
    case "manual-refund":
      return {
        description: `${actor}对${device}执行了退款操作。`,
        detail: baseDetail([`动作人 ${actor}`, `柜机 ${device}`, `关联事件 ${secondary}`, `退款金额 ${String(entry.metadata?.amount ?? 0)}`, `状态 ${result}`])
      };
    case "refund-callback":
      return {
        description: `系统确认了${device}的退款回调。`,
        detail: baseDetail([
          `柜机 ${device}`,
          `关联事件 ${secondary}`,
          typeof entry.metadata?.refundNo === "string" ? `退款单号 ${entry.metadata.refundNo}` : undefined,
          `退款金额 ${String(entry.metadata?.amount ?? 0)}`,
          `状态 ${result}`
        ])
      };
    case "create-alert":
      return {
        description: `系统为${device}创建了${primary}。`,
        detail: baseDetail([`柜机 ${device}`, `预警 ${primary}`, `状态 ${result}`])
      };
    case "resolve-alert":
      return {
        description:
          entry.metadata?.action === "acknowledge"
            ? `${actor}已知晓${primary}。`
            : `${actor}完成了${primary}的处理。`,
        detail: baseDetail([
          `动作人 ${actor}`,
          entry.secondarySubject ? `柜机 ${secondary}` : undefined,
          `预警 ${primary}`,
          typeof entry.metadata?.note === "string" && entry.metadata.note
            ? `处理说明 ${entry.metadata.note}`
            : undefined,
          `状态 ${result}`
        ])
      };
    case "manual-add-batch":
      return {
        description: `${actor}向${device}新增了${goods}批次${quantity ? ` x${quantity}` : ""}。`,
        detail: baseDetail([
          `动作人 ${actor}`,
          `柜机 ${device}`,
          `货品 ${goods}`,
          quantity ? `数量 ${quantity}` : undefined,
          typeof entry.metadata?.expiresAt === "string" ? `保质期 ${entry.metadata.expiresAt}` : undefined,
          `状态 ${result}`
        ])
      };
    case "manual-remove-batch":
      return {
        description: `${actor}从${device}去除了${goods}批次${quantity ? ` x${quantity}` : ""}。`,
        detail: baseDetail([
          `动作人 ${actor}`,
          `柜机 ${device}`,
          `货品 ${goods}`,
          quantity ? `数量 ${quantity}` : undefined,
          typeof entry.metadata?.note === "string" && entry.metadata.note ? `说明 ${entry.metadata.note}` : undefined,
          `状态 ${result}`
        ])
      };
    case "create-goods-catalog":
      return {
        description: `${actor}新增了货品种类${goods}。`,
        detail: baseDetail([`动作人 ${actor}`, `货品 ${goods}`, `状态 ${result}`])
      };
    case "update-goods-catalog":
      return {
        description: `${actor}修改了货品${goods}的基础信息。`,
        detail: baseDetail([`动作人 ${actor}`, `货品 ${goods}`, `状态 ${result}`])
      };
    case "update-device-goods-threshold":
      return {
        description: `${actor}修改了${device}的${goods}库存阈值。`,
        detail: baseDetail([
          `动作人 ${actor}`,
          `柜机 ${device}`,
          `货品 ${goods}`,
          typeof entry.metadata?.enabled === "boolean"
            ? `阈值${entry.metadata.enabled ? "已开启" : "已关闭"}`
            : undefined,
          typeof entry.metadata?.lowStockThreshold === "number"
            ? `阈值 ${entry.metadata.lowStockThreshold}`
            : undefined,
          `状态 ${result}`
        ])
      };
    case "add-device-goods":
      return {
        description: `${actor}向${device}加入了货品${goods}。`,
        detail: baseDetail([
          `动作人 ${actor}`,
          `柜机 ${device}`,
          `货品 ${goods}`,
          typeof entry.metadata?.doorNum === "string" ? `货门 ${entry.metadata.doorNum}` : undefined,
          `状态 ${result}`
        ])
      };
    case "remove-device-goods":
      return {
        description: `${actor}从${device}移除了货品${goods}。`,
        detail: baseDetail([
          `动作人 ${actor}`,
          `柜机 ${device}`,
          `货品 ${goods}`,
          typeof entry.metadata?.doorNum === "string" ? `货门 ${entry.metadata.doorNum}` : undefined,
          `状态 ${result}`
        ])
      };
    case "undo-manual-restock":
      return {
        description: `${actor}撤销了对${device}的${goods}补货${quantity ? ` x${quantity}` : ""}。`,
        detail: baseDetail([`动作人 ${actor}`, `柜机 ${device}`, `货品 ${goods}`, quantity ? `数量 ${quantity}` : undefined, `状态 ${result}`])
      };
    case "undo-manual-deduction":
      return {
        description: `${actor}撤销了对${device}的${goods}补扣${quantity ? ` x${quantity}` : ""}。`,
        detail: baseDetail([`动作人 ${actor}`, `柜机 ${device}`, `货品 ${goods}`, quantity ? `数量 ${quantity}` : undefined, `状态 ${result}`])
      };
    case "undo-user-update":
      return {
        description: `${actor}撤销了对${primary}的人员信息修改。`,
        detail: baseDetail([`动作人 ${actor}`, `人员 ${primary}`, `状态 ${result}`])
      };
    case "undo-goods-catalog":
      return {
        description: `${actor}撤销了货品${goods}的信息修改。`,
        detail: baseDetail([`动作人 ${actor}`, `货品 ${goods}`, `状态 ${result}`])
      };
    case "undo-manual-add-batch":
      return {
        description: `${actor}撤销了向${device}新增${goods}批次的操作。`,
        detail: baseDetail([`动作人 ${actor}`, `柜机 ${device}`, `货品 ${goods}`, quantity ? `数量 ${quantity}` : undefined, `状态 ${result}`])
      };
    case "undo-manual-remove-batch":
      return {
        description: `${actor}撤销了从${device}去除${goods}批次的操作。`,
        detail: baseDetail([`动作人 ${actor}`, `柜机 ${device}`, `货品 ${goods}`, quantity ? `数量 ${quantity}` : undefined, `状态 ${result}`])
      };
    case "create-user":
      return {
        description: `${actor}新增了人员${primary}。`,
        detail: baseDetail([`动作人 ${actor}`, `人员 ${primary}`, `状态 ${result}`])
      };
    case "update-user":
      return {
        description: `${actor}修改了${primary}的基础信息。`,
        detail: baseDetail([`动作人 ${actor}`, `人员 ${primary}`, `状态 ${result}`])
      };
    case "batch-update-user":
      return {
        description: `${actor}修改了${primary}的人员属性。`,
        detail: baseDetail([
          `动作人 ${actor}`,
          `人员 ${primary}`,
          typeof entry.metadata?.status === "string" ? `状态改为 ${entry.metadata.status === "active" ? "可取货 / 可操作" : "已暂停"}` : undefined,
          Array.isArray(entry.metadata?.tags) ? `标签 ${entry.metadata.tags.join("、") || "无"}` : undefined
        ])
      };
    case "import-users":
      return {
        description: `${actor}导入了${String(entry.metadata?.count ?? 0)}条${String(entry.metadata?.role === "special" ? "特殊群体" : "商户")}数据。`,
        detail: baseDetail([`动作人 ${actor}`, `角色 ${String(entry.metadata?.role ?? "未知")}`, `导入数量 ${String(entry.metadata?.count ?? 0)}`, `状态 ${result}`])
      };
    case "update-access-rule":
      return {
        description: `${actor}修改了${String(entry.metadata?.role === "special" ? "特殊群体" : "商户")}的领取规则。`,
        detail: baseDetail([`动作人 ${actor}`, `每日上限 ${String(entry.metadata?.dailyLimit ?? "-")}`, `状态 ${result}`])
      };
    case "create-mock-device":
      return {
        description: `${actor}新增了${device}。`,
        detail: baseDetail([`动作人 ${actor}`, `柜机 ${device}`, `状态 ${result}`])
      };
    case "upsert-mock-device":
      return {
        description: `${actor}更新了${device}的模拟配置。`,
        detail: baseDetail([`动作人 ${actor}`, `柜机 ${device}`, `状态 ${result}`])
      };
    case "create-special-policy":
      return {
        description: `${actor}新增了策略模板${String(entry.metadata?.policyName ?? "未命名模板")}。`,
        detail: baseDetail([
          `动作人 ${actor}`,
          `策略模板 ${String(entry.metadata?.policyName ?? "-")}`,
          `状态 ${result}`
        ])
      };
    case "update-special-policy":
      return {
        description: `${actor}修改了策略模板${String(entry.metadata?.policyName ?? "未命名模板")}。`,
        detail: baseDetail([
          `动作人 ${actor}`,
          `策略模板 ${String(entry.metadata?.policyName ?? "-")}`,
          `状态 ${result}`
        ])
      };
    case "batch-assign-special-policy":
      return {
        description: `${actor}批量套用了普通用户取货模板。`,
        detail: baseDetail([
          `动作人 ${actor}`,
          `涉及人员 ${Array.isArray(entry.metadata?.userIds) ? entry.metadata.userIds.length : 0} 人`,
          `涉及模板 ${Array.isArray(entry.metadata?.policyIds) ? entry.metadata.policyIds.length : 0} 个`,
          typeof entry.metadata?.mode === "string" ? `操作方式 ${String(entry.metadata.mode)}` : undefined,
          `状态 ${result}`
        ])
      };
    case "create-user-access-policy":
      return {
        description: `${actor}为${primary}新增了个人取货设定${String(entry.metadata?.policyName ? ` ${entry.metadata.policyName}` : "")}。`,
        detail: baseDetail([
          `动作人 ${actor}`,
          `人员 ${primary}`,
          typeof entry.metadata?.policyName === "string" ? `设定 ${entry.metadata.policyName}` : undefined,
          `状态 ${result}`
        ])
      };
    case "update-user-access-policy":
      return {
        description: `${actor}修改了${primary}的个人取货设定${String(entry.metadata?.policyName ? ` ${entry.metadata.policyName}` : "")}。`,
        detail: baseDetail([
          `动作人 ${actor}`,
          `人员 ${primary}`,
          typeof entry.metadata?.policyName === "string" ? `设定 ${entry.metadata.policyName}` : undefined,
          `状态 ${result}`
        ])
      };
    case "delete-user-access-policy":
      return {
        description: `${actor}删除了${primary}的个人取货设定${String(entry.metadata?.policyName ? ` ${entry.metadata.policyName}` : "")}。`,
        detail: baseDetail([
          `动作人 ${actor}`,
          `人员 ${primary}`,
          typeof entry.metadata?.policyName === "string" ? `设定 ${entry.metadata.policyName}` : undefined,
          `状态 ${result}`
        ])
      };
    case "sync-device-goods":
      return {
        description: `${actor}同步了${device}的货品种类。`,
        detail: baseDetail([
          `动作人 ${actor}`,
          `柜机 ${device}`,
          typeof entry.metadata?.count === "number" ? `同步种类 ${entry.metadata.count}` : undefined,
          `状态 ${result}`
        ])
      };
    default:
      return {
        description: entry.description ?? `${actor}执行了${entry.type}操作。`,
        detail: entry.detail ?? baseDetail([`动作人 ${actor}`, entry.primarySubject ? `主体 ${primary}` : undefined, entry.secondarySubject ? `附属 ${secondary}` : undefined, `状态 ${result}`])
      };
  }
};
