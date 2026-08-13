import { BadRequestException, Inject, Injectable, NotFoundException } from "@nestjs/common";

import type {
  EntitlementLimit,
  GoodsCatalogItem,
  GoodsTaxonomyNode,
  UserRole
} from "@vm/shared-types";

import { InMemoryStoreService } from "../../common/store/in-memory-store.service";

const MAX_TAXONOMY_DEPTH = 8;
const AUTO_CANCELLATION_REASON = "货品分类或领取规则调整，系统已自动取消预约。";

type NodePatch = Partial<Pick<GoodsTaxonomyNode, "name" | "parentId" | "status" | "sortOrder">>;

export interface GoodsTaxonomyChangePreview {
  allowed: boolean;
  blockReason?: string;
  expectedRevision: number;
  affectedNodeIds: string[];
  affectedGoodsIds: string[];
  affectedPolicyIds: string[];
  affectedUserIds: string[];
  affectedReservationIds: string[];
}

export interface GoodsTaxonomyAssignmentPreview {
  expectedRevision: number;
  taxonomyNodeId: string;
  affectedGoodsIds: string[];
  affectedPolicyIds: string[];
  affectedUserIds: string[];
  affectedReservationIds: string[];
}

@Injectable()
export class GoodsTaxonomyService {
  constructor(@Inject(InMemoryStoreService) private readonly store: InMemoryStoreService) {}

  getTree() {
    const nodes = this.store.goodsTaxonomyNodes
      .slice()
      .sort((left, right) => left.sortOrder - right.sortOrder || left.name.localeCompare(right.name));

    return {
      revision: this.getTreeRevision(),
      nodes,
      goods: this.store.goodsCatalog.map((goods) => this.decorateGoods(goods)),
      unassignedGoodsIds: this.store.goodsCatalog
        .filter((goods) => !goods.taxonomyNodeId)
        .map((goods) => goods.goodsId)
    };
  }

  createNode(
    payload: { name: string; parentId: string | null; sortOrder?: number },
    actorUserId?: string
  ) {
    return this.store.runAtomicMutation(() => {
      const name = this.normalizeName(payload.name);
      const parentId = payload.parentId ?? null;
      if (parentId === null && name !== "任意") {
        throw new BadRequestException("货品分类根节点名称必须为“任意”。");
      }
      this.assertParentAvailable(parentId);
      this.assertSiblingNameAvailable(name, parentId);
      this.assertDepth(parentId);

      if (parentId === null && this.store.goodsTaxonomyNodes.some((node) => node.parentId === null)) {
        throw new BadRequestException("分类树只能有一个根节点。");
      }

      const now = new Date().toISOString();
      const created: GoodsTaxonomyNode = {
        id: this.store.createId("goods-taxonomy"),
        name,
        parentId,
        status: "active",
        sortOrder:
          payload.sortOrder ??
          Math.max(
            0,
            ...this.store.goodsTaxonomyNodes
              .filter((node) => node.parentId === parentId)
              .map((node) => node.sortOrder)
          ) + 1,
        revision: this.getTreeRevision() + 1,
        createdAt: now,
        updatedAt: now
      };
      this.store.goodsTaxonomyNodes.push(created);
      this.log("create-goods-taxonomy-node", created, actorUserId);
      return created;
    });
  }

  previewChange(nodeId: string, patch: NodePatch): GoodsTaxonomyChangePreview {
    const node = this.findNode(nodeId);
    const nextParentId = patch.parentId === undefined ? node.parentId : patch.parentId;
    const affectedNodeIds = this.collectDescendantIds(nodeId);
    let blockReason: string | undefined;

    try {
      if (node.parentId === null && nextParentId !== null) {
        throw new BadRequestException("根节点不能移动。");
      }
      if (nextParentId === nodeId || (nextParentId !== null && affectedNodeIds.includes(nextParentId))) {
        throw new BadRequestException("分类移动会形成循环引用。");
      }
      this.assertParentAvailable(nextParentId);
      this.assertDepth(nextParentId, this.getSubtreeHeight(nodeId));
      if (patch.name !== undefined) {
        const nextName = this.normalizeName(patch.name);
        if (node.parentId === null && nextName !== "任意") {
          throw new BadRequestException("货品分类根节点名称必须为“任意”。");
        }
        this.assertSiblingNameAvailable(nextName, nextParentId, nodeId);
      }
      if (patch.status === "inactive" && node.parentId === null) {
        throw new BadRequestException("根节点不能停用。");
      }
    } catch (error) {
      blockReason = error instanceof Error ? error.message : "分类变更不可执行。";
    }

    const affectedGoodsIds = this.store.goodsCatalog
      .filter((goods) => goods.taxonomyNodeId && affectedNodeIds.includes(goods.taxonomyNodeId))
      .map((goods) => goods.goodsId);
    const affectedPolicyIds = new Set<string>();
    const affectedUserIds = new Set<string>();

    for (const policy of this.store.specialAccessPolicies) {
      if (this.limitsTouchTargets(policy.entitlementLimits, affectedNodeIds, affectedGoodsIds)) {
        affectedPolicyIds.add(policy.id);
        for (const userId of policy.applicableUserIds) affectedUserIds.add(userId);
      }
    }
    for (const user of this.store.users) {
      if (
        (user.accessPolicies ?? []).some((policy) =>
          this.limitsTouchTargets(policy.entitlementLimits, affectedNodeIds, affectedGoodsIds)
        )
      ) {
        affectedUserIds.add(user.id);
      }
    }

    const affectedReservationIds = this.store.reservations
      .filter(
        (reservation) =>
          reservation.status === "active" &&
          (reservation.items.some((item) => affectedGoodsIds.includes(item.goodsId)) ||
            reservation.entitlementAllocations?.some(
              (line) =>
                affectedGoodsIds.includes(line.goodsId) ||
                (line.targetType === "taxonomy_node" && affectedNodeIds.includes(line.targetId))
            ))
      )
      .map((reservation) => reservation.id);

    return {
      allowed: !blockReason,
      blockReason,
      expectedRevision: this.getTreeRevision(),
      affectedNodeIds,
      affectedGoodsIds,
      affectedPolicyIds: [...affectedPolicyIds].sort(),
      affectedUserIds: [...affectedUserIds].sort(),
      affectedReservationIds
    };
  }

  applyChange(
    nodeId: string,
    payload: NodePatch & { expectedRevision: number },
    actorUserId?: string
  ) {
    if (payload.expectedRevision !== this.getTreeRevision()) {
      throw new BadRequestException("分类树已发生变化，请重新预览后再提交。");
    }

    const preview = this.previewChange(nodeId, payload);
    if (!preview.allowed) {
      throw new BadRequestException(preview.blockReason ?? "分类变更不可执行。");
    }

    return this.store.runAtomicMutation(() => {
      if (payload.expectedRevision !== this.getTreeRevision()) {
        throw new BadRequestException("分类树已发生变化，请重新预览后再提交。");
      }

      const node = this.findNode(nodeId);
      const before = structuredClone(node);
      const now = new Date().toISOString();
      if (payload.name !== undefined) node.name = this.normalizeName(payload.name);
      if (payload.parentId !== undefined) node.parentId = payload.parentId;
      if (payload.status !== undefined) node.status = payload.status;
      if (payload.sortOrder !== undefined) node.sortOrder = this.normalizeSortOrder(payload.sortOrder);
      node.revision = this.getTreeRevision() + 1;
      node.updatedAt = now;

      const cancelledReservationIds: string[] = [];
      for (const reservation of this.store.reservations) {
        if (!preview.affectedReservationIds.includes(reservation.id) || reservation.status !== "active") continue;
        reservation.status = "cancelled";
        reservation.cancelledAt = now;
        reservation.cancelledByUserId = actorUserId ?? "system";
        reservation.cancellationReason = AUTO_CANCELLATION_REASON;
        reservation.updatedAt = now;
        cancelledReservationIds.push(reservation.id);
      }

      this.log("update-goods-taxonomy-node", node, actorUserId, {
        beforeSnapshot: before,
        afterSnapshot: structuredClone(node),
        cancelledReservationIds
      });

      return { node, cancelledReservationIds, preview };
    });
  }

  assignGoods(
    payload: { taxonomyNodeId: string; goodsIds: string[]; expectedRevision: number },
    actorUserId?: string
  ) {
    if (payload.expectedRevision !== this.getTreeRevision()) {
      throw new BadRequestException("分类树已发生变化，请重新预览后再提交。");
    }
    const preview = this.previewGoodsAssignment(payload);
    return this.store.runAtomicMutation(() => {
      if (payload.expectedRevision !== this.getTreeRevision()) {
        throw new BadRequestException("分类树已发生变化，请重新预览后再提交。");
      }
      const node = this.findNode(payload.taxonomyNodeId);
      if (node.status !== "active") throw new BadRequestException("不能把货品归入已停用分类。");
      const goodsIds = preview.affectedGoodsIds;
      const updated: GoodsCatalogItem[] = [];
      const now = new Date().toISOString();

      for (const goodsId of goodsIds) {
        const goods = this.store.goodsCatalog.find((entry) => entry.goodsId === goodsId)!;
        goods.taxonomyNodeId = node.id;
        delete goods.taxonomyPath;
        goods.updatedAt = now;
        updated.push(this.decorateGoods(goods));
      }
      const cancelledReservationIds: string[] = [];
      for (const reservation of this.store.reservations) {
        if (!preview.affectedReservationIds.includes(reservation.id) || reservation.status !== "active") continue;
        reservation.status = "cancelled";
        reservation.cancelledAt = now;
        reservation.cancelledByUserId = actorUserId ?? "system";
        reservation.cancellationReason = AUTO_CANCELLATION_REASON;
        reservation.updatedAt = now;
        cancelledReservationIds.push(reservation.id);
      }
      if (updated.length) {
        node.revision = this.getTreeRevision() + 1;
        node.updatedAt = now;
      }

      this.store.logOperation({
        category: "goods",
        type: "assign-goods-taxonomy",
        status: "success",
        actor: this.getActor(actorUserId),
        metadata: {
          taxonomyNodeId: node.id,
          goodsIds,
          cancelledReservationIds,
          undoState: "not_undoable"
        }
      });
      return { updated, cancelledReservationIds, preview };
    });
  }

  previewGoodsAssignment(payload: { taxonomyNodeId: string; goodsIds: string[] }): GoodsTaxonomyAssignmentPreview {
    const node = this.findNode(payload.taxonomyNodeId);
    if (node.status !== "active") throw new BadRequestException("不能把货品归入已停用分类。");
    const goodsIds = [...new Set(payload.goodsIds.map((value) => value.trim()).filter(Boolean))];
    if (!goodsIds.length) throw new BadRequestException("请选择要归类的货品。");
    const missing = goodsIds.filter(
      (goodsId) => !this.store.goodsCatalog.some((entry) => entry.goodsId === goodsId)
    );
    if (missing.length) throw new NotFoundException(`未找到货品：${missing.join("、")}。`);
    const affectedGoodsIds = goodsIds.filter(
      (goodsId) => this.store.goodsCatalog.find((entry) => entry.goodsId === goodsId)?.taxonomyNodeId !== node.id
    );
    const affectedTaxonomyNodeIds = new Set<string>();
    for (const goodsId of affectedGoodsIds) {
      const goods = this.store.goodsCatalog.find((entry) => entry.goodsId === goodsId)!;
      const previousLineage = new Set(
        goods.taxonomyNodeId ? this.buildPath(goods.taxonomyNodeId).map((entry) => entry.id) : []
      );
      const nextLineage = new Set(this.buildPath(node.id).map((entry) => entry.id));
      for (const nodeId of previousLineage) {
        if (!nextLineage.has(nodeId)) affectedTaxonomyNodeIds.add(nodeId);
      }
      for (const nodeId of nextLineage) {
        if (!previousLineage.has(nodeId)) affectedTaxonomyNodeIds.add(nodeId);
      }
    }
    const affectedPolicyIds = this.store.specialAccessPolicies
      .filter((policy) =>
        policy.entitlementLimits?.some(
          (limit) =>
            limit.targetType === "taxonomy_node" && affectedTaxonomyNodeIds.has(limit.targetId)
        )
      )
      .map((policy) => policy.id)
      .sort();
    const affectedUserIds = this.store.users
      .filter((user) =>
        (user.accessPolicies ?? []).some((policy) =>
          policy.entitlementLimits?.some(
            (limit) =>
              limit.targetType === "taxonomy_node" && affectedTaxonomyNodeIds.has(limit.targetId)
          )
        ) || this.store.specialAccessPolicies.some(
          (policy) => affectedPolicyIds.includes(policy.id) && policy.applicableUserIds.includes(user.id)
        )
      )
      .map((user) => user.id)
      .sort();
    const affectedReservationIds = this.store.reservations
      .filter(
        (reservation) =>
          reservation.status === "active" &&
          (reservation.items.some((item) => affectedGoodsIds.includes(item.goodsId)) ||
            reservation.entitlementAllocations?.some((line) => affectedGoodsIds.includes(line.goodsId)))
      )
      .map((reservation) => reservation.id);
    return {
      expectedRevision: this.getTreeRevision(),
      taxonomyNodeId: node.id,
      affectedGoodsIds,
      affectedPolicyIds,
      affectedUserIds,
      affectedReservationIds
    };
  }

  decorateGoods(goods: GoodsCatalogItem): GoodsCatalogItem {
    const clone = { ...goods };
    clone.taxonomyPath = goods.taxonomyNodeId ? this.buildPath(goods.taxonomyNodeId) : [];
    return clone;
  }

  getTreeRevision() {
    return this.store.goodsTaxonomyNodes.reduce((maximum, node) => Math.max(maximum, node.revision), 0);
  }

  private findNode(nodeId: string) {
    const node = this.store.goodsTaxonomyNodes.find((entry) => entry.id === nodeId);
    if (!node) throw new NotFoundException("未找到对应货品分类节点。");
    return node;
  }

  private normalizeName(raw: string) {
    const name = raw?.trim();
    if (!name) throw new BadRequestException("分类名称不能为空。");
    if (name.length > 40) throw new BadRequestException("分类名称不能超过 40 个字符。");
    return name;
  }

  private normalizeSortOrder(raw: number) {
    const value = Number(raw);
    if (!Number.isSafeInteger(value) || value < 0) throw new BadRequestException("分类排序必须是非负整数。");
    return value;
  }

  private assertParentAvailable(parentId: string | null) {
    if (parentId === null) return;
    const parent = this.store.goodsTaxonomyNodes.find((node) => node.id === parentId);
    if (!parent || parent.status !== "active") throw new BadRequestException("上级分类不存在或已停用。");
  }

  private assertSiblingNameAvailable(name: string, parentId: string | null, exceptId?: string) {
    if (
      this.store.goodsTaxonomyNodes.some(
        (node) =>
          node.id !== exceptId &&
          node.parentId === parentId &&
          node.status !== "inactive" &&
          node.name.trim() === name
      )
    ) {
      throw new BadRequestException("同一上级分类下已存在同名节点。");
    }
  }

  private assertDepth(parentId: string | null, subtreeHeight = 1) {
    let depth = 1;
    let currentId = parentId;
    const visited = new Set<string>();
    while (currentId !== null) {
      if (visited.has(currentId)) throw new BadRequestException("分类树存在循环引用。");
      visited.add(currentId);
      const current = this.findNode(currentId);
      depth += 1;
      currentId = current.parentId;
    }
    if (depth + subtreeHeight - 1 > MAX_TAXONOMY_DEPTH) {
      throw new BadRequestException(`货品分类最多支持 ${MAX_TAXONOMY_DEPTH} 层。`);
    }
  }

  private getSubtreeHeight(nodeId: string): number {
    const children = this.store.goodsTaxonomyNodes.filter((node) => node.parentId === nodeId);
    return children.length ? 1 + Math.max(...children.map((node) => this.getSubtreeHeight(node.id))) : 1;
  }

  private collectDescendantIds(nodeId: string) {
    const result: string[] = [];
    const visit = (id: string) => {
      result.push(id);
      for (const child of this.store.goodsTaxonomyNodes.filter((node) => node.parentId === id)) visit(child.id);
    };
    visit(nodeId);
    return result;
  }

  private buildPath(nodeId: string) {
    const path: Array<Pick<GoodsTaxonomyNode, "id" | "name" | "sortOrder">> = [];
    let current: GoodsTaxonomyNode | undefined = this.findNode(nodeId);
    const visited = new Set<string>();
    while (current) {
      if (visited.has(current.id)) throw new BadRequestException("分类树存在循环引用。");
      visited.add(current.id);
      path.unshift({ id: current.id, name: current.name, sortOrder: current.sortOrder });
      current = current.parentId ? this.findNode(current.parentId) : undefined;
    }
    return path;
  }

  private limitsTouchTargets(
    limits: EntitlementLimit[] | undefined,
    nodeIds: string[],
    goodsIds: string[]
  ) {
    return (limits ?? []).some(
      (limit) =>
        (limit.targetType === "taxonomy_node" && nodeIds.includes(limit.targetId)) ||
        (limit.targetType === "goods" && goodsIds.includes(limit.targetId))
    );
  }

  private getActor(actorUserId?: string) {
    const actor = actorUserId ? this.store.users.find((user) => user.id === actorUserId) : undefined;
    return actor
      ? { type: "admin" as const, id: actor.id, name: actor.name, role: actor.role as UserRole }
      : { type: "system" as const, name: "系统" };
  }

  private log(
    type: string,
    node: GoodsTaxonomyNode,
    actorUserId?: string,
    metadata: Record<string, unknown> = {}
  ) {
    this.store.logOperation({
      category: "goods",
      type,
      status: "success",
      actor: this.getActor(actorUserId),
      primarySubject: { type: "goods", id: node.id, label: node.name },
      metadata: { taxonomyNodeId: node.id, ...metadata, undoState: "not_undoable" }
    });
  }
}
