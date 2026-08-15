import type {
  EntitlementPoolSnapshot,
  GoodsCategory,
  GoodsTaxonomyNode
} from "@vm/shared-types";

type SelectionGoods = {
  goodsId: string;
  name: string;
  category: GoodsCategory;
  stock?: number;
  taxonomyNodeId?: string;
  taxonomyPath?: Array<Pick<GoodsTaxonomyNode, "id" | "name" | "sortOrder">>;
};

type Progress = {
  selected: number;
  available: number;
};

type TaxonomyPathNode = Pick<GoodsTaxonomyNode, "id" | "name" | "sortOrder">;

type TaxonomyDisplayNode = {
  id: string;
  name: string;
  depth: number;
  goods: SelectionGoods[];
  directProgress: Progress;
  children: TaxonomyDisplayNode[];
};

type AllocationLine = {
  goodsId: string;
  poolId: string;
  quantity: number;
};

type SelectionInput = {
  goods: SelectionGoods[];
  pools: EntitlementPoolSnapshot[];
  selectedByGoods: Record<string, number>;
};

type AllocationResult = {
  fulfilled: boolean;
  allocations: AllocationLine[];
};

const normalizeQuantity = (value: number | undefined) =>
  Number.isSafeInteger(value) && (value ?? 0) > 0 ? value! : 0;

const categoryFallbackName: Record<GoodsCategory, string> = {
  food: "食品",
  drink: "饮料",
  daily: "日用品"
};

const getActiveGoodsSelection = (
  goods: SelectionGoods[],
  selectedByGoods: Record<string, number>
) =>
  goods
    .map((entry) => ({
      goodsId: entry.goodsId,
      quantity: normalizeQuantity(selectedByGoods[entry.goodsId])
    }))
    .filter((entry) => entry.quantity > 0);

const getGoodsLineage = (goods: SelectionGoods) =>
  goods.taxonomyPath?.map((entry) => entry.id) ??
  (goods.taxonomyNodeId ? [goods.taxonomyNodeId] : []);

const compareTaxonomyPaths = (left: SelectionGoods, right: SelectionGoods) => {
  const leftPath = left.taxonomyPath ?? [];
  const rightPath = right.taxonomyPath ?? [];
  const sharedDepth = Math.min(leftPath.length, rightPath.length);

  for (let index = 0; index < sharedDepth; index += 1) {
    const leftNode = leftPath[index];
    const rightNode = rightPath[index];
    if (leftNode?.id !== rightNode?.id) {
      return (leftNode?.sortOrder ?? 0) - (rightNode?.sortOrder ?? 0) ||
        (leftNode?.name ?? "").localeCompare(rightNode?.name ?? "") ||
        (leftNode?.id ?? "").localeCompare(rightNode?.id ?? "");
    }
  }

  return leftPath.length - rightPath.length;
};

/**
 * 移动端只负责即时展示与按钮禁用；预约提交后仍由服务端以同一额度池合同重新核算。
 * 这里使用确定性的增广路径，避免“任意”额度被某一分类先占用后造成虚假不足。
 */
export const allocateGoodsSelection = ({ goods, pools, selectedByGoods }: SelectionInput): AllocationResult => {
  const goodsById = new Map(goods.map((entry) => [entry.goodsId, entry]));
  const requests = getActiveGoodsSelection(goods, selectedByGoods).sort((left, right) =>
    left.goodsId.localeCompare(right.goodsId)
  );
  const activePools = pools
    .filter((pool) => normalizeQuantity(pool.remaining) > 0)
    .slice()
    .sort((left, right) => left.poolId.localeCompare(right.poolId));

  const matchingPools = (goodsEntry: SelectionGoods) => {
    const lineage = getGoodsLineage(goodsEntry);
    return activePools
      .filter(
        (pool) =>
          (pool.targetType === "goods" && pool.targetId === goodsEntry.goodsId) ||
          (pool.targetType === "taxonomy_node" && lineage.includes(pool.targetId))
      )
      .sort((left, right) => {
        const leftSpecificity =
          left.targetType === "goods" ? lineage.length + 1 : lineage.indexOf(left.targetId) + 1;
        const rightSpecificity =
          right.targetType === "goods" ? lineage.length + 1 : lineage.indexOf(right.targetId) + 1;
        return rightSpecificity - leftSpecificity || left.poolId.localeCompare(right.poolId);
      });
  };

  const assignedByPool = new Map<string, Array<{ goodsId: string; quantity: number }>>();
  const allocatedByGoods = new Map<string, number>();

  const reassign = (goodsId: string, visitedPools: Set<string>): boolean => {
    const goodsEntry = goodsById.get(goodsId);
    if (!goodsEntry) return false;

    for (const pool of matchingPools(goodsEntry)) {
      if (visitedPools.has(pool.poolId)) continue;
      visitedPools.add(pool.poolId);
      const assignments = assignedByPool.get(pool.poolId) ?? [];
      const used = assignments.reduce((sum, entry) => sum + entry.quantity, 0);
      if (used < normalizeQuantity(pool.remaining)) {
        assignments.push({ goodsId, quantity: 1 });
        assignedByPool.set(pool.poolId, assignments);
        return true;
      }

      for (let index = 0; index < assignments.length; index += 1) {
        const existing = assignments[index]!;
        if (!reassign(existing.goodsId, visitedPools)) continue;
        assignments.splice(index, 1, { goodsId, quantity: 1 });
        assignedByPool.set(pool.poolId, assignments);
        return true;
      }
    }

    return false;
  };

  for (const request of requests) {
    for (let index = 0; index < request.quantity; index += 1) {
      if (!reassign(request.goodsId, new Set())) {
        return { fulfilled: false, allocations: [] };
      }
      allocatedByGoods.set(request.goodsId, (allocatedByGoods.get(request.goodsId) ?? 0) + 1);
    }
  }

  const allocations = [...assignedByPool.entries()].flatMap(([poolId, entries]) => {
    const byGoods = new Map<string, number>();
    for (const entry of entries) {
      byGoods.set(entry.goodsId, (byGoods.get(entry.goodsId) ?? 0) + entry.quantity);
    }
    return [...byGoods.entries()].map(([goodsId, quantity]) => ({ goodsId, poolId, quantity }));
  });

  return { fulfilled: true, allocations };
};

const getDirectGroup = (goods: SelectionGoods) => {
  const path = goods.taxonomyPath ?? [];
  const direct = path.at(-1);
  return {
    id: direct?.id ?? goods.taxonomyNodeId ?? goods.category,
    name: direct?.name ?? categoryFallbackName[goods.category],
    path
  };
};

const getOrderedTaxonomyRows = (goods: SelectionGoods[]) => {
  const nodes = new Map<string, TaxonomyDisplayNode & { sortOrder: number; parentId?: string }>();

  for (const goodsEntry of goods) {
    const path = goodsEntry.taxonomyPath ?? [];
    const visiblePath = path.length > 1
      ? path.slice(1)
      : [{
          id: goodsEntry.taxonomyNodeId ?? goodsEntry.category,
          name: categoryFallbackName[goodsEntry.category],
          sortOrder: 0
        } satisfies TaxonomyPathNode];

    visiblePath.forEach((node, depth) => {
      const existing = nodes.get(node.id) ?? {
        id: node.id,
        name: node.name,
        sortOrder: node.sortOrder,
        parentId: visiblePath[depth - 1]?.id,
        depth,
        goods: [],
        directProgress: { selected: 0, available: 0 },
        children: []
      };
      if (depth === visiblePath.length - 1 && !existing.goods.some((entry) => entry.goodsId === goodsEntry.goodsId)) {
        existing.goods.push(goodsEntry);
      }
      nodes.set(node.id, existing);
    });
  }

  const roots: Array<TaxonomyDisplayNode & { sortOrder: number; parentId?: string }> = [];
  for (const node of nodes.values()) {
    const parent = node.parentId ? nodes.get(node.parentId) : undefined;
    if (parent) parent.children.push(node);
    else roots.push(node);
  }
  const orderNodes = (entries: typeof roots) => {
    entries.sort((left, right) =>
      left.sortOrder - right.sortOrder ||
      left.name.localeCompare(right.name) ||
      left.id.localeCompare(right.id)
    );
    entries.forEach((entry) => orderNodes(entry.children as typeof roots));
  };
  orderNodes(roots);

  const ordered: TaxonomyDisplayNode[] = [];
  const visit = (node: TaxonomyDisplayNode) => {
    ordered.push(node);
    node.children.forEach(visit);
  };
  roots.forEach(visit);
  return ordered;
};

export const buildGoodsSelectionPresentation = (input: SelectionInput) => {
  const orderedGoods = input.goods.slice().sort(compareTaxonomyPaths);
  const root = orderedGoods.flatMap((entry) => entry.taxonomyPath ?? []).at(0);
  const rootId = root?.id;
  const allocation = allocateGoodsSelection(input);
  const poolById = new Map(input.pools.map((pool) => [pool.poolId, pool]));
  const selectedByPoolId = new Map<string, number>();

  for (const line of allocation.allocations) {
    const pool = poolById.get(line.poolId);
    if (!pool) continue;
    selectedByPoolId.set(
      pool.poolId,
      (selectedByPoolId.get(pool.poolId) ?? 0) + line.quantity
    );
  }

  const sharedPools = input.pools.filter(
    (pool) => pool.targetType === "taxonomy_node" && pool.targetId === rootId
  );
  const sharedProgress: Progress = {
    selected: sharedPools.reduce(
      (sum, pool) => sum + (selectedByPoolId.get(pool.poolId) ?? 0),
      0
    ),
    available: sharedPools.reduce((sum, pool) => sum + normalizeQuantity(pool.remaining), 0)
  };

  const rowList = getOrderedTaxonomyRows(orderedGoods);

  for (const row of rowList) {
    const directPools = input.pools.filter(
      (pool) =>
        (pool.targetType === "taxonomy_node" && pool.targetId === row.id) ||
        (pool.targetType === "goods" && row.goods.some((goodsEntry) => goodsEntry.goodsId === pool.targetId))
    );
    row.directProgress = {
      selected: directPools.reduce(
        (sum, pool) => sum + (selectedByPoolId.get(pool.poolId) ?? 0),
        0
      ),
      available: directPools.reduce((sum, pool) => sum + normalizeQuantity(pool.remaining), 0)
    };
  }

  const groups = rowList
    .filter((row) => row.goods.length > 0)
    .map((row) => ({ ...row, dedicatedProgress: row.directProgress }));

  return {
    root: root ? { ...root, name: root.name === "任意" ? "任意物资" : root.name } : undefined,
    rows: rowList,
    groups,
    sharedProgress,
    fulfilled: allocation.fulfilled
  };
};

export const canIncrementGoodsSelection = (input: SelectionInput, goodsId: string) => {
  const goods = input.goods.find((entry) => entry.goodsId === goodsId);
  if (!goods) return false;
  const current = normalizeQuantity(input.selectedByGoods[goodsId]);
  if (current >= normalizeQuantity(goods.stock)) return false;
  return allocateGoodsSelection({
    ...input,
    selectedByGoods: { ...input.selectedByGoods, [goodsId]: current + 1 }
  }).fulfilled;
};
