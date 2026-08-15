export type EntitlementTargetType = "taxonomy_node" | "goods";

export interface EntitlementAllocationNode {
  id: string;
  parentId: string | null;
  status?: "active" | "inactive";
}

export interface EntitlementAllocationGoods {
  goodsId: string;
  taxonomyNodeId?: string;
}

export interface EntitlementAllocationPool {
  poolId: string;
  policyId: string;
  limitId: string;
  targetType: EntitlementTargetType;
  targetId: string;
  remaining: number;
}

export interface EntitlementAllocationRequest {
  goodsId: string;
  quantity: number;
}

export interface EntitlementAllocationInput {
  nodes: EntitlementAllocationNode[];
  goods: EntitlementAllocationGoods[];
  pools: EntitlementAllocationPool[];
  requests: EntitlementAllocationRequest[];
}

export interface EntitlementAllocationLine {
  poolId: string;
  policyId: string;
  limitId: string;
  targetType: EntitlementTargetType;
  targetId: string;
  goodsId: string;
  quantity: number;
}

export interface EntitlementAllocationResult {
  fulfilled: boolean;
  allocations: EntitlementAllocationLine[];
  shortages: Array<{ goodsId: string; quantity: number }>;
}

const normalizeQuantity = (value: number, label: string) => {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${label}必须是非负整数。`);
  }

  return value;
};

const buildNodeDepths = (nodes: EntitlementAllocationNode[]) => {
  const nodeById = new Map(nodes.map((node) => [node.id, node]));
  const depths = new Map<string, number>();
  const visiting = new Set<string>();

  const visit = (nodeId: string): number | undefined => {
    const cached = depths.get(nodeId);
    if (cached !== undefined) {
      return cached;
    }

    const node = nodeById.get(nodeId);
    if (!node) throw new Error(`额度分类节点 ${nodeId} 不存在。`);
    if (node.status === "inactive") return undefined;

    if (visiting.has(nodeId)) {
      throw new Error("额度分类树存在循环引用。");
    }

    visiting.add(nodeId);
    const parentDepth = node.parentId === null ? -1 : visit(node.parentId);
    // 上级停用时，整棵子树在分配时视为不可用；保留子节点自身状态，便于上级恢复后复用。
    if (parentDepth === undefined) {
      visiting.delete(nodeId);
      return undefined;
    }
    const depth = parentDepth + 1;
    visiting.delete(nodeId);
    depths.set(nodeId, depth);
    return depth;
  };

  for (const node of nodes) {
    if (node.status !== "inactive") visit(node.id);
  }

  return { nodeById, depths };
};

const buildLineage = (
  nodeId: string,
  nodeById: Map<string, EntitlementAllocationNode>
) => {
  const lineage: string[] = [];
  const visited = new Set<string>();
  let currentId: string | null = nodeId;

  while (currentId !== null) {
    if (visited.has(currentId)) {
      throw new Error("额度分类树存在循环引用。");
    }

    visited.add(currentId);
    const node = nodeById.get(currentId);
    if (!node) throw new Error(`货品所属分类节点 ${currentId} 不存在。`);
    if (node.status === "inactive") return [];

    lineage.push(currentId);
    currentId = node.parentId;
  }

  return lineage;
};

/**
 * 在一棵层级树上分配可领取额度。调用方只需要提供树、额度池和具体货品需求；
 * 本模块统一处理后代匹配、最具体额度优先、稳定排序与不足摘要。
 */
export const allocateEntitlements = (
  input: EntitlementAllocationInput
): EntitlementAllocationResult => {
  const { nodeById, depths } = buildNodeDepths(input.nodes);
  const goodsById = new Map(input.goods.map((entry) => [entry.goodsId, entry]));
  const poolRemaining = new Map<string, number>();
  const poolById = new Map<string, EntitlementAllocationPool>();

  for (const pool of input.pools) {
    if (poolById.has(pool.poolId)) {
      throw new Error(`额度池 ${pool.poolId} 重复。`);
    }

    if (
      pool.targetType === "taxonomy_node" &&
      !nodeById.has(pool.targetId)
    ) {
      throw new Error(`额度池 ${pool.poolId} 指向不存在的分类节点。`);
    }

    if (pool.targetType === "goods" && !goodsById.has(pool.targetId)) {
      throw new Error(`额度池 ${pool.poolId} 指向无效货品。`);
    }

    poolById.set(pool.poolId, pool);
    poolRemaining.set(pool.poolId, normalizeQuantity(pool.remaining, "额度池剩余数量"));
  }

  const requests = new Map<string, number>();
  for (const request of input.requests) {
    if (!goodsById.has(request.goodsId)) {
      throw new Error(`请求货品 ${request.goodsId} 不存在。`);
    }

    const quantity = normalizeQuantity(request.quantity, "请求数量");
    requests.set(request.goodsId, (requests.get(request.goodsId) ?? 0) + quantity);
  }

  interface Edge {
    to: number;
    reverse: number;
    capacity: number;
    cost: number;
    initialCapacity: number;
    goodsId?: string;
    poolId?: string;
  }

  const sortedGoods = [...requests.entries()]
    .filter(([, quantity]) => quantity > 0)
    .sort(([left], [right]) => left.localeCompare(right));
  const sortedPools = [...input.pools].sort((left, right) => left.poolId.localeCompare(right.poolId));
  const source = 0;
  const goodsOffset = 1;
  const poolOffset = goodsOffset + sortedGoods.length;
  const sink = poolOffset + sortedPools.length;
  const graph: Edge[][] = Array.from({ length: sink + 1 }, () => []);
  const addEdge = (
    from: number,
    to: number,
    capacity: number,
    cost: number,
    metadata: Pick<Edge, "goodsId" | "poolId"> = {}
  ) => {
    const forward: Edge = {
      to,
      reverse: graph[to]!.length,
      capacity,
      initialCapacity: capacity,
      cost,
      ...metadata
    };
    const backward: Edge = {
      to: from,
      reverse: graph[from]!.length,
      capacity: 0,
      initialCapacity: 0,
      cost: -cost
    };
    graph[from]!.push(forward);
    graph[to]!.push(backward);
  };

  sortedGoods.forEach(([goodsId, quantity], goodsIndex) => {
    addEdge(source, goodsOffset + goodsIndex, quantity, 0);
    const goods = goodsById.get(goodsId)!;
    if (goods.taxonomyNodeId && !depths.has(goods.taxonomyNodeId)) return;
    const lineage = goods.taxonomyNodeId ? buildLineage(goods.taxonomyNodeId, nodeById) : [];

    sortedPools.forEach((pool, poolIndex) => {
      const eligible =
        (pool.targetType === "goods" && pool.targetId === goodsId) ||
        (pool.targetType === "taxonomy_node" && lineage.includes(pool.targetId));
      if (!eligible) return;
      const specificity =
        pool.targetType === "goods"
          ? (goods.taxonomyNodeId ? depths.get(goods.taxonomyNodeId) ?? 0 : 0) + 1
          : depths.get(pool.targetId) ?? 0;
      // 先最大化分配总量；在总量相同时优先使用最具体的额度池。
      addEdge(
        goodsOffset + goodsIndex,
        poolOffset + poolIndex,
        quantity,
        -specificity * (sortedPools.length + 1) + poolIndex,
        { goodsId, poolId: pool.poolId }
      );
    });
  });
  sortedPools.forEach((pool, poolIndex) => {
    addEdge(poolOffset + poolIndex, sink, poolRemaining.get(pool.poolId) ?? 0, 0);
  });

  // 使用带反向边的最小费用增广，能够在宽额度被占用时重新安排已有分配。
  while (true) {
    const distance = Array<number>(graph.length).fill(Number.POSITIVE_INFINITY);
    const previousNode = Array<number>(graph.length).fill(-1);
    const previousEdge = Array<number>(graph.length).fill(-1);
    distance[source] = 0;

    for (let iteration = 0; iteration < graph.length - 1; iteration += 1) {
      let changed = false;
      for (let from = 0; from < graph.length; from += 1) {
        if (!Number.isFinite(distance[from])) continue;
        graph[from]!.forEach((edge, edgeIndex) => {
          if (edge.capacity <= 0) return;
          const nextDistance = distance[from]! + edge.cost;
          if (nextDistance < distance[edge.to]!) {
            distance[edge.to] = nextDistance;
            previousNode[edge.to] = from;
            previousEdge[edge.to] = edgeIndex;
            changed = true;
          }
        });
      }
      if (!changed) break;
    }

    if (previousNode[sink] < 0) break;
    let quantity = Number.POSITIVE_INFINITY;
    for (let node = sink; node !== source; node = previousNode[node]!) {
      quantity = Math.min(quantity, graph[previousNode[node]!]![previousEdge[node]!]!.capacity);
    }
    for (let node = sink; node !== source; node = previousNode[node]!) {
      const edge = graph[previousNode[node]!]![previousEdge[node]!]!;
      edge.capacity -= quantity;
      graph[node]![edge.reverse]!.capacity += quantity;
    }
  }

  const allocations: EntitlementAllocationLine[] = [];
  for (let goodsIndex = 0; goodsIndex < sortedGoods.length; goodsIndex += 1) {
    for (const edge of graph[goodsOffset + goodsIndex]!) {
      if (!edge.poolId || !edge.goodsId) continue;
      const quantity = edge.initialCapacity - edge.capacity;
      if (quantity <= 0) continue;
      const pool = poolById.get(edge.poolId)!;
      allocations.push({
        poolId: pool.poolId,
        policyId: pool.policyId,
        limitId: pool.limitId,
        targetType: pool.targetType,
        targetId: pool.targetId,
        goodsId: edge.goodsId,
        quantity
      });
    }
  }
  allocations.sort(
    (left, right) => left.goodsId.localeCompare(right.goodsId) || left.poolId.localeCompare(right.poolId)
  );
  const allocatedByGoods = new Map<string, number>();
  for (const line of allocations) {
    allocatedByGoods.set(line.goodsId, (allocatedByGoods.get(line.goodsId) ?? 0) + line.quantity);
  }
  const shortages = sortedGoods.flatMap(([goodsId, requestedQuantity]) => {
    const quantity = requestedQuantity - (allocatedByGoods.get(goodsId) ?? 0);
    return quantity > 0 ? [{ goodsId, quantity }] : [];
  });

  return {
    fulfilled: shortages.length === 0,
    allocations,
    shortages
  };
};
