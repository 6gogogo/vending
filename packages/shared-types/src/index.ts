export type UserRole = "admin" | "merchant" | "special";

export type GoodsCategory = "food" | "drink" | "daily";

export type DeviceStatus = "online" | "offline" | "maintenance";

export type CabinetEventStatus =
  | "created"
  | "opening"
  | "opened"
  | "closed"
  | "settled"
  | "failed"
  | "refunded";

export type InventoryMovementType =
  | "pickup"
  | "donation"
  | "expired"
  | "adjustment"
  | "manual-restock"
  | "manual-deduction"
  | "refund";

export type AlertStatus = "open" | "resolved";

export type PolicyStatus = "active" | "inactive";

export type ServiceCompletionStatus = "complete" | "partial" | "unserved" | "not_applicable";

export interface ApiEnvelope<T> {
  code: number;
  message: string;
  data: T;
}

export interface AccessQuota {
  dailyLimit: number;
  categoryLimit: Partial<Record<GoodsCategory, number>>;
}

export interface UserRecord {
  id: string;
  role: UserRole;
  phone: string;
  name: string;
  status: "active" | "inactive";
  neighborhood?: string;
  tags: string[];
  quota?: AccessQuota;
  merchantProfile?: {
    donationWindowDays: number;
    defaultDeviceCodes: string[];
  };
}

export interface GoodsCatalogItem {
  goodsCode: string;
  goodsId: string;
  name: string;
  category: GoodsCategory;
  price: number;
  imageUrl: string;
}

export interface DeviceGoods extends GoodsCatalogItem {
  stock: number;
  expiresAt?: string;
}

export interface DeviceDoor {
  doorNum: string;
  label: string;
  goods: DeviceGoods[];
}

export interface DeviceRuntimeState {
  deviceCode: string;
  doorState: "open" | "closed" | "unknown";
  lastCommandAt?: string;
  lastOpenedAt?: string;
  lastClosedAt?: string;
  lastRefreshAt?: string;
  openedAfterLastCommand: boolean;
}

export interface DeviceRecord {
  deviceCode: string;
  name: string;
  location: string;
  status: DeviceStatus;
  doors: DeviceDoor[];
  lastSeenAt: string;
  runtime?: DeviceRuntimeState;
}

export interface CabinetAccessRule {
  role: Extract<UserRole, "special" | "merchant">;
  dailyLimit: number;
  categoryLimit: Partial<Record<GoodsCategory, number>>;
  requiresPhoneMatch: boolean;
  allowExpirySetup: boolean;
}

export interface CabinetOpenRequest {
  phone: string;
  deviceCode: string;
  doorNum?: string;
  payStyle?: "2" | "3";
  category?: GoodsCategory;
}

export interface CabinetOpenResult {
  orderNo: string;
  eventId: string;
  deviceCode: string;
  doorNum: string;
  role: UserRole;
  remainingQuota?: Partial<Record<string, number>>;
}

export interface CabinetEventRecord {
  eventId: string;
  orderNo: string;
  userId: string;
  phone: string;
  role: UserRole;
  deviceCode: string;
  doorNum: string;
  status: CabinetEventStatus;
  createdAt: string;
  updatedAt: string;
  amount: number;
  goods: Array<{
    goodsId: string;
    goodsName: string;
    category: GoodsCategory;
    quantity: number;
    unitPrice: number;
  }>;
}

export interface InventoryMovement {
  id: string;
  orderNo?: string;
  userId: string;
  deviceCode: string;
  goodsId: string;
  goodsName: string;
  category: GoodsCategory;
  quantity: number;
  unitPrice: number;
  type: InventoryMovementType;
  happenedAt: string;
  expiresAt?: string;
}

export interface AlertTask {
  id: string;
  type: "expiry" | "callback" | "inventory" | "device_fault" | "user_feedback";
  title: string;
  status: AlertStatus;
  deviceCode?: string;
  targetUserId?: string;
  goodsId?: string;
  goodsName?: string;
  dueAt: string;
  createdAt: string;
  detail: string;
  sourceLogId?: string;
  resolvedAt?: string;
  resolvedByUserId?: string;
  resolutionNote?: string;
}

export type OperationLogCategory =
  | "pickup"
  | "restock"
  | "device"
  | "admin"
  | "alert"
  | "inventory"
  | "user"
  | "policy"
  | "goods";

export type OperationLogStatus = "success" | "pending" | "warning" | "failed";

export interface OperationLogActor {
  type: "admin" | "merchant" | "special" | "system";
  id?: string;
  name: string;
  role?: UserRole;
}

export interface OperationLogSubject {
  type: "user" | "device" | "event" | "alert" | "goods";
  id: string;
  label: string;
}

export interface OperationLogRecord {
  id: string;
  category: OperationLogCategory;
  type: string;
  status: OperationLogStatus;
  occurredAt: string;
  actor: OperationLogActor;
  primarySubject?: OperationLogSubject;
  secondarySubject?: OperationLogSubject;
  detail: string;
  description: string;
  relatedEventId?: string;
  relatedOrderNo?: string;
  metadata?: Record<string, unknown>;
}

export interface SpecialAccessPolicyGoodsLimit {
  goodsId: string;
  goodsName: string;
  category: GoodsCategory;
  quantity: number;
}

export interface SpecialAccessPolicy {
  id: string;
  name: string;
  weekdays: number[];
  startHour: number;
  endHour: number;
  goodsLimits: SpecialAccessPolicyGoodsLimit[];
  applicableUserIds: string[];
  status: PolicyStatus;
}

export interface ServiceOverviewPerson {
  userId: string;
  name: string;
  phone: string;
  neighborhood?: string;
  completionStatus: ServiceCompletionStatus;
  fulfilledGoods: number;
  totalGoods: number;
  summary: string;
}

export interface ServiceOverviewBucket {
  count: number;
  users: ServiceOverviewPerson[];
}

export interface GoodsOverviewItem {
  deviceCode: string;
  deviceName: string;
  goodsId: string;
  goodsName: string;
  category: GoodsCategory;
  stock: number;
  lowStockThreshold: number;
  status: "ok" | "low" | "empty";
}

export interface GoodsAlertPolicyThreshold {
  goodsId: string;
  goodsName: string;
  category: GoodsCategory;
  lowStockThreshold: number;
}

export interface GoodsAlertPolicy {
  id: string;
  name: string;
  applicableDeviceCodes: string[];
  thresholds: GoodsAlertPolicyThreshold[];
  status: PolicyStatus;
}

export interface GoodsOverviewSnapshot {
  totalKinds: number;
  lowStockKinds: number;
  outOfStockKinds: number;
  flaggedGoods: GoodsOverviewItem[];
  byDevice: Array<{
    deviceCode: string;
    deviceName: string;
    totalStock: number;
    kinds: number;
    lowStockItems: number;
  }>;
  byGoods: Array<{
    goodsId: string;
    goodsName: string;
    category: GoodsCategory;
    totalStock: number;
    lowStockDevices: number;
    outOfStockDevices: number;
    deviceDistribution: GoodsOverviewItem[];
  }>;
  recentLogs: OperationLogRecord[];
}

export interface DashboardStats {
  completeUsers: number;
  partialUsers: number;
  unservedUsers: number;
  pendingTasks: number;
  lowStockKinds: number;
  outOfStockKinds: number;
}

export interface TrendPoint {
  label: string;
  pickups: number;
  donations: number;
}

export interface DashboardSnapshot {
  businessDateKey: string;
  stats: DashboardStats;
  weeklyTrend: TrendPoint[];
  serviceOverview: {
    completeUsers: ServiceOverviewBucket;
    partialUsers: ServiceOverviewBucket;
    unservedUsers: ServiceOverviewBucket;
    totalUsers: number;
  };
  pendingTasks: AlertTask[];
  goodsOverview: GoodsOverviewSnapshot;
  summaryLogs: OperationLogRecord[];
}

export interface DeviceMonitoringDetail {
  device: DeviceRecord;
  runtime: DeviceRuntimeState;
  businessDateKey: string;
  servedUsers: number;
  totalStock: number;
  pendingTasks: AlertTask[];
  recentEvents: CabinetEventRecord[];
  recentLogs: OperationLogRecord[];
  businessDayServedUsers: Array<{
    userId: string;
    userName: string;
    role: UserRole;
    goodsSummary: string;
    totalQuantity: number;
    lastServedAt: string;
  }>;
  stockChanges: Array<{
    goodsId: string;
    goodsName: string;
    category: GoodsCategory;
    currentStock: number;
    deltaSinceStartOfBusinessDay: number;
  }>;
}

export interface SpecialAccessWindowUsage {
  policyId: string;
  policyName: string;
  weekdays: number[];
  startHour: number;
  endHour: number;
  goodsUsage: Array<{
    goodsId: string;
    goodsName: string;
    category: GoodsCategory;
    quantityLimit: number;
    usedQuantity: number;
  }>;
}

export interface UserManagementDetail {
  user: UserRecord;
  stats?: {
    pickupCount: number;
    donationCount: number;
    adjustmentCount: number;
    lastActiveAt?: string;
  };
  recentRecords: InventoryMovement[];
  recentEvents: CabinetEventRecord[];
  recentLogs: OperationLogRecord[];
  relatedTasks?: AlertTask[];
  applicablePolicies?: SpecialAccessPolicy[];
  businessDaySummary?: {
    businessDateKey: string;
    completionStatus: ServiceCompletionStatus;
    windows: SpecialAccessWindowUsage[];
  };
}

export interface SmartVmCredentials {
  clientId: string;
  key: string;
}

export interface SmartVmDoorStatusPayload {
  eventId: string;
  deviceCode: string;
  status: "OPENDING" | "SUCCESS" | "CLOSED" | "FAIL";
  doorIsOpen?: "Y" | "N";
}

export interface SmartVmSettlementPayload {
  orderNo: string;
  eventId: string;
  phone: string;
  deviceCode: string;
  amount: number;
  notifyUrl: string;
  detail?: Array<{
    goodsName: string;
    quantity: number;
    unitPrice: number;
    goodsId: string;
  }>;
}

export interface SmartVmAdjustmentPayload {
  orgOrderNo: string;
  orderNo: string;
  eventId: string;
  phone: string;
  deviceCode: string;
  amount: number;
  noticeUrl: string;
  detail?: Array<{
    goodsName: string;
    quantity: number;
    unitPrice: number;
    goodsId: string;
  }>;
}

export interface SmartVmPaymentPayload {
  orderNo: string;
  eventId: string;
  transactionId: string;
  openId?: string;
  deviceCode: string;
  amount: number;
}

export interface SmartVmRefundPayload {
  orderNo: string;
  transactionId: string;
  refundNo: string;
  deviceCode: string;
  amount: number;
}

export const seedUsers: UserRecord[] = [
  {
    id: "admin-001",
    role: "admin",
    phone: "13800000001",
    name: "街道管理员",
    status: "active",
    tags: ["运营"]
  },
  {
    id: "special-001",
    role: "special",
    phone: "13800000002",
    name: "林阿姨",
    status: "active",
    neighborhood: "扬名街道",
    tags: ["老人", "重点关怀"],
    quota: {
      dailyLimit: 2,
      categoryLimit: {
        food: 1,
        drink: 1
      }
    }
  },
  {
    id: "special-002",
    role: "special",
    phone: "13800000003",
    name: "陈师傅",
    status: "active",
    neighborhood: "扬名街道",
    tags: ["新业态劳动者"],
    quota: {
      dailyLimit: 2,
      categoryLimit: {
        food: 1,
        drink: 1
      }
    }
  },
  {
    id: "special-003",
    role: "special",
    phone: "13800000005",
    name: "赵阿姨",
    status: "active",
    neighborhood: "扬名街道",
    tags: ["独居老人"],
    quota: {
      dailyLimit: 2,
      categoryLimit: {
        food: 1,
        drink: 1
      }
    }
  },
  {
    id: "merchant-001",
    role: "merchant",
    phone: "13800000004",
    name: "鲜食爱心商户",
    status: "active",
    tags: ["食品捐赠"],
    merchantProfile: {
      donationWindowDays: 2,
      defaultDeviceCodes: ["CAB-1001", "CAB-1002"]
    }
  }
];

export const seedRules: CabinetAccessRule[] = [
  {
    role: "special",
    dailyLimit: 2,
    categoryLimit: {
      food: 1,
      drink: 1,
      daily: 1
    },
    requiresPhoneMatch: true,
    allowExpirySetup: false
  },
  {
    role: "merchant",
    dailyLimit: 8,
    categoryLimit: {},
    requiresPhoneMatch: true,
    allowExpirySetup: true
  }
];

export const seedDevices: DeviceRecord[] = [
  {
    deviceCode: "CAB-1001",
    name: "扬名西点位",
    location: "扬名街道西侧公益柜",
    status: "online",
    lastSeenAt: "2026-04-08T02:30:00.000Z",
    doors: [
      {
        doorNum: "1",
        label: "右门",
        goods: [
          {
            goodsCode: "690000000001",
            goodsId: "goods-1001",
            name: "三明治",
            category: "food",
            price: 0,
            imageUrl: "https://dummyimage.com/160x160/dae4ff/0b1220.png",
            stock: 3,
            expiresAt: "2026-04-09T08:00:00.000Z"
          },
          {
            goodsCode: "690000000002",
            goodsId: "goods-1002",
            name: "牛奶",
            category: "drink",
            price: 0,
            imageUrl: "https://dummyimage.com/160x160/c8f7e7/0b1220.png",
            stock: 1
          }
        ]
      }
    ]
  },
  {
    deviceCode: "CAB-1002",
    name: "扬名东点位",
    location: "扬名街道东侧公益柜",
    status: "online",
    lastSeenAt: "2026-04-08T02:35:00.000Z",
    doors: [
      {
        doorNum: "1",
        label: "右门",
        goods: [
          {
            goodsCode: "690000000003",
            goodsId: "goods-1003",
            name: "方便面",
            category: "food",
            price: 0,
            imageUrl: "https://dummyimage.com/160x160/f8d9c8/0b1220.png",
            stock: 0
          },
          {
            goodsCode: "690000000004",
            goodsId: "goods-1004",
            name: "牙刷",
            category: "daily",
            price: 0,
            imageUrl: "https://dummyimage.com/160x160/f7f3b8/0b1220.png",
            stock: 6
          }
        ]
      }
    ]
  }
];

export const seedGoodsCatalog: GoodsCatalogItem[] = [
  {
    goodsCode: "690000000001",
    goodsId: "goods-1001",
    name: "三明治",
    category: "food",
    price: 0,
    imageUrl: "https://dummyimage.com/160x160/dae4ff/0b1220.png"
  },
  {
    goodsCode: "690000000002",
    goodsId: "goods-1002",
    name: "牛奶",
    category: "drink",
    price: 0,
    imageUrl: "https://dummyimage.com/160x160/c8f7e7/0b1220.png"
  },
  {
    goodsCode: "690000000003",
    goodsId: "goods-1003",
    name: "方便面",
    category: "food",
    price: 0,
    imageUrl: "https://dummyimage.com/160x160/f8d9c8/0b1220.png"
  },
  {
    goodsCode: "690000000004",
    goodsId: "goods-1004",
    name: "牙刷",
    category: "daily",
    price: 0,
    imageUrl: "https://dummyimage.com/160x160/f7f3b8/0b1220.png"
  }
];

export const seedSpecialAccessPolicies: SpecialAccessPolicy[] = [
  {
    id: "policy-001",
    name: "早餐关怀",
    weekdays: [1, 2, 3, 4, 5],
    startHour: 8,
    endHour: 12,
    goodsLimits: [
      {
        goodsId: "goods-1001",
        goodsName: "三明治",
        category: "food",
        quantity: 1
      },
      {
        goodsId: "goods-1002",
        goodsName: "牛奶",
        category: "drink",
        quantity: 1
      }
    ],
    applicableUserIds: ["special-001", "special-002", "special-003"],
    status: "active"
  }
];

export const seedGoodsAlertPolicies: GoodsAlertPolicy[] = [
  {
    id: "goods-policy-001",
    name: "早餐柜机低库存模板",
    applicableDeviceCodes: ["CAB-1001", "CAB-1002"],
    status: "active",
    thresholds: [
      {
        goodsId: "goods-1001",
        goodsName: "三明治",
        category: "food",
        lowStockThreshold: 2
      },
      {
        goodsId: "goods-1002",
        goodsName: "牛奶",
        category: "drink",
        lowStockThreshold: 1
      },
      {
        goodsId: "goods-1003",
        goodsName: "方便面",
        category: "food",
        lowStockThreshold: 2
      }
    ]
  }
];

export const seedEvents: CabinetEventRecord[] = [
  {
    eventId: "evt-001",
    orderNo: "ord-001",
    userId: "special-001",
    phone: "13800000002",
    role: "special",
    deviceCode: "CAB-1001",
    doorNum: "1",
    status: "settled",
    createdAt: "2026-04-08T01:02:00.000Z",
    updatedAt: "2026-04-08T01:08:00.000Z",
    amount: 0,
    goods: [
      {
        goodsId: "goods-1001",
        goodsName: "三明治",
        category: "food",
        quantity: 1,
        unitPrice: 0
      },
      {
        goodsId: "goods-1002",
        goodsName: "牛奶",
        category: "drink",
        quantity: 1,
        unitPrice: 0
      }
    ]
  },
  {
    eventId: "evt-002",
    orderNo: "ord-002",
    userId: "special-002",
    phone: "13800000003",
    role: "special",
    deviceCode: "CAB-1001",
    doorNum: "1",
    status: "settled",
    createdAt: "2026-04-08T01:20:00.000Z",
    updatedAt: "2026-04-08T01:30:00.000Z",
    amount: 0,
    goods: [
      {
        goodsId: "goods-1001",
        goodsName: "三明治",
        category: "food",
        quantity: 1,
        unitPrice: 0
      }
    ]
  },
  {
    eventId: "evt-003",
    orderNo: "ord-003",
    userId: "merchant-001",
    phone: "13800000004",
    role: "merchant",
    deviceCode: "CAB-1001",
    doorNum: "1",
    status: "closed",
    createdAt: "2026-04-08T00:15:00.000Z",
    updatedAt: "2026-04-08T00:22:00.000Z",
    amount: 0,
    goods: [
      {
        goodsId: "goods-1001",
        goodsName: "三明治",
        category: "food",
        quantity: 4,
        unitPrice: 0
      },
      {
        goodsId: "goods-1002",
        goodsName: "牛奶",
        category: "drink",
        quantity: 2,
        unitPrice: 0
      }
    ]
  },
  {
    eventId: "evt-004",
    orderNo: "ord-004",
    userId: "admin-001",
    phone: "13800000001",
    role: "admin",
    deviceCode: "CAB-1002",
    doorNum: "1",
    status: "opening",
    createdAt: "2026-04-08T02:00:00.000Z",
    updatedAt: "2026-04-08T02:00:30.000Z",
    amount: 0,
    goods: []
  }
];

export const seedInventory: InventoryMovement[] = [
  {
    id: "mov-001",
    orderNo: "ord-001",
    userId: "special-001",
    deviceCode: "CAB-1001",
    goodsId: "goods-1001",
    goodsName: "三明治",
    category: "food",
    quantity: 1,
    unitPrice: 0,
    type: "pickup",
    happenedAt: "2026-04-08T01:06:00.000Z"
  },
  {
    id: "mov-002",
    orderNo: "ord-001",
    userId: "special-001",
    deviceCode: "CAB-1001",
    goodsId: "goods-1002",
    goodsName: "牛奶",
    category: "drink",
    quantity: 1,
    unitPrice: 0,
    type: "pickup",
    happenedAt: "2026-04-08T01:08:00.000Z"
  },
  {
    id: "mov-003",
    orderNo: "ord-002",
    userId: "special-002",
    deviceCode: "CAB-1001",
    goodsId: "goods-1001",
    goodsName: "三明治",
    category: "food",
    quantity: 1,
    unitPrice: 0,
    type: "pickup",
    happenedAt: "2026-04-08T01:30:00.000Z"
  },
  {
    id: "mov-004",
    orderNo: "ord-003",
    userId: "merchant-001",
    deviceCode: "CAB-1001",
    goodsId: "goods-1001",
    goodsName: "三明治",
    category: "food",
    quantity: 4,
    unitPrice: 0,
    type: "donation",
    happenedAt: "2026-04-08T00:22:00.000Z",
    expiresAt: "2026-04-09T08:00:00.000Z"
  },
  {
    id: "mov-005",
    orderNo: "ord-003",
    userId: "merchant-001",
    deviceCode: "CAB-1001",
    goodsId: "goods-1002",
    goodsName: "牛奶",
    category: "drink",
    quantity: 2,
    unitPrice: 0,
    type: "donation",
    happenedAt: "2026-04-08T00:22:00.000Z",
    expiresAt: "2026-04-09T08:00:00.000Z"
  }
];

export const seedAlerts: AlertTask[] = [
  {
    id: "task-001",
    type: "expiry",
    title: "物资即将过期",
    status: "open",
    deviceCode: "CAB-1001",
    targetUserId: "merchant-001",
    goodsId: "goods-1001",
    goodsName: "三明治",
    dueAt: "2026-04-09T06:00:00.000Z",
    createdAt: "2026-04-08T02:40:00.000Z",
    detail: "三明治批次即将到期，请在领取期限结束前处理。"
  },
  {
    id: "task-002",
    type: "device_fault",
    title: "柜机开门无响应",
    status: "open",
    deviceCode: "CAB-1002",
    dueAt: "2026-04-08T02:02:00.000Z",
    createdAt: "2026-04-08T02:01:30.000Z",
    detail: "远程开门后超过 90 秒未收到成功开门确认。"
  },
  {
    id: "task-003",
    type: "user_feedback",
    title: "用户反馈柜门关闭缓慢",
    status: "open",
    deviceCode: "CAB-1001",
    targetUserId: "special-002",
    dueAt: "2026-04-08T03:20:00.000Z",
    createdAt: "2026-04-08T02:50:00.000Z",
    detail: "陈师傅反馈 CAB-1001 关门速度较慢，需要现场检查闭门器。"
  }
];

export const seedOperationLogs: OperationLogRecord[] = [
  {
    id: "log-001",
    category: "restock",
    type: "inventory-restock",
    status: "success",
    occurredAt: "2026-04-08T00:22:00.000Z",
    actor: {
      type: "merchant",
      id: "merchant-001",
      name: "鲜食爱心商户",
      role: "merchant"
    },
    primarySubject: {
      type: "device",
      id: "CAB-1001",
      label: "扬名西点位"
    },
    secondarySubject: {
      type: "goods",
      id: "goods-1001",
      label: "三明治"
    },
    description: "鲜食爱心商户向扬名西点位补充了三明治 x4。",
    detail: "商户完成补货开柜后，向 CAB-1001 投放三明治 4 件。",
    relatedEventId: "evt-003",
    relatedOrderNo: "ord-003",
    metadata: {
      quantity: 4,
      deviceCode: "CAB-1001",
      goodsId: "goods-1001",
      goodsName: "三明治"
    }
  },
  {
    id: "log-002",
    category: "pickup",
    type: "inventory-pickup",
    status: "success",
    occurredAt: "2026-04-08T01:08:00.000Z",
    actor: {
      type: "special",
      id: "special-001",
      name: "林阿姨",
      role: "special"
    },
    primarySubject: {
      type: "device",
      id: "CAB-1001",
      label: "扬名西点位"
    },
    secondarySubject: {
      type: "goods",
      id: "goods-1002",
      label: "牛奶"
    },
    description: "林阿姨在扬名西点位领取牛奶 x1。",
    detail: "用户通过特殊群体端开柜后完成领取，系统记录牛奶 1 件。",
    relatedEventId: "evt-001",
    relatedOrderNo: "ord-001",
    metadata: {
      quantity: 1,
      deviceCode: "CAB-1001",
      goodsId: "goods-1002",
      goodsName: "牛奶"
    }
  },
  {
    id: "log-003",
    category: "alert",
    type: "create-alert",
    status: "warning",
    occurredAt: "2026-04-08T02:40:00.000Z",
    actor: {
      type: "system",
      name: "系统巡检"
    },
    primarySubject: {
      type: "alert",
      id: "task-001",
      label: "物资即将过期"
    },
    secondarySubject: {
      type: "device",
      id: "CAB-1001",
      label: "扬名西点位"
    },
    description: "系统为扬名西点位创建了物资即将过期任务。",
    detail: "到期巡检命中三明治批次，已生成开放状态的临期任务。",
    metadata: {
      goodsId: "goods-1001",
      deviceCode: "CAB-1001"
    }
  },
  {
    id: "log-004",
    category: "device",
    type: "remote-open-device",
    status: "pending",
    occurredAt: "2026-04-08T02:00:00.000Z",
    actor: {
      type: "admin",
      id: "admin-001",
      name: "街道管理员",
      role: "admin"
    },
    primarySubject: {
      type: "device",
      id: "CAB-1002",
      label: "扬名东点位"
    },
    secondarySubject: {
      type: "event",
      id: "evt-004",
      label: "ord-004"
    },
    description: "街道管理员向扬名东点位下发了远程开门指令。",
    detail: "设备 CAB-1002 已收到远程开门请求，等待门状态回调。",
    relatedEventId: "evt-004",
    relatedOrderNo: "ord-004",
    metadata: {
      deviceCode: "CAB-1002"
    }
  },
  {
    id: "log-005",
    category: "alert",
    type: "create-alert",
    status: "warning",
    occurredAt: "2026-04-08T02:50:00.000Z",
    actor: {
      type: "system",
      name: "用户反馈"
    },
    primarySubject: {
      type: "alert",
      id: "task-003",
      label: "用户反馈柜门关闭缓慢"
    },
    secondarySubject: {
      type: "device",
      id: "CAB-1001",
      label: "扬名西点位"
    },
    description: "系统记录了 CAB-1001 的用户反馈。",
    detail: "陈师傅反馈柜门关闭缓慢，已进入待处理任务池。",
    metadata: {
      deviceCode: "CAB-1001",
      targetUserId: "special-002"
    }
  },
  {
    id: "log-006",
    category: "alert",
    type: "create-alert",
    status: "warning",
    occurredAt: "2026-04-08T02:01:30.000Z",
    actor: {
      type: "system",
      name: "系统巡检"
    },
    primarySubject: {
      type: "alert",
      id: "task-002",
      label: "柜机开门无响应"
    },
    secondarySubject: {
      type: "device",
      id: "CAB-1002",
      label: "扬名东点位"
    },
    description: "系统记录了 CAB-1002 的开门无响应异常。",
    detail: "远程开门超过 90 秒未得到成功反馈，已进入待处理任务池。",
    metadata: {
      deviceCode: "CAB-1002"
    }
  }
];

export const cloneSeedState = () => ({
  users: structuredClone(seedUsers),
  rules: structuredClone(seedRules),
  devices: structuredClone(seedDevices),
  goodsCatalog: structuredClone(seedGoodsCatalog),
  specialAccessPolicies: structuredClone(seedSpecialAccessPolicies),
  goodsAlertPolicies: structuredClone(seedGoodsAlertPolicies),
  events: structuredClone(seedEvents),
  inventory: structuredClone(seedInventory),
  alerts: structuredClone(seedAlerts),
  logs: structuredClone(seedOperationLogs)
});
