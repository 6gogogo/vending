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
  | "refund";

export type AlertStatus = "open" | "resolved";

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

export interface DeviceGoods {
  goodsCode: string;
  goodsId: string;
  name: string;
  category: GoodsCategory;
  price: number;
  imageUrl: string;
  stock: number;
  expiresAt?: string;
}

export interface DeviceDoor {
  doorNum: string;
  label: string;
  goods: DeviceGoods[];
}

export interface DeviceRecord {
  deviceCode: string;
  name: string;
  location: string;
  status: DeviceStatus;
  doors: DeviceDoor[];
  lastSeenAt: string;
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
  remainingQuota?: Partial<Record<GoodsCategory, number>>;
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
  type: "expiry" | "callback" | "inventory";
  title: string;
  status: AlertStatus;
  deviceCode?: string;
  targetUserId?: string;
  dueAt: string;
  createdAt: string;
  detail: string;
}

export interface DashboardStats {
  activeSpecialUsers: number;
  activeMerchants: number;
  todayOpenEvents: number;
  pendingAlerts: number;
  donatedUnits: number;
  pickedUnits: number;
}

export interface DemandPoint {
  category: GoodsCategory;
  count: number;
}

export interface TrendPoint {
  label: string;
  pickups: number;
  donations: number;
}

export interface DashboardSnapshot {
  stats: DashboardStats;
  demandByCategory: DemandPoint[];
  weeklyTrend: TrendPoint[];
  openAlerts: AlertTask[];
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
        drink: 1,
        daily: 1
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
    lastSeenAt: "2026-03-24T08:15:00.000Z",
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
            stock: 8,
            expiresAt: "2026-03-25T16:00:00.000Z"
          },
          {
            goodsCode: "690000000002",
            goodsId: "goods-1002",
            name: "矿泉水",
            category: "drink",
            price: 0,
            imageUrl: "https://dummyimage.com/160x160/c8f7e7/0b1220.png",
            stock: 10
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
    lastSeenAt: "2026-03-24T08:20:00.000Z",
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
            stock: 5
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
    createdAt: "2026-03-24T01:10:00.000Z",
    updatedAt: "2026-03-24T01:14:00.000Z",
    amount: 0,
    goods: [
      {
        goodsId: "goods-1002",
        goodsName: "矿泉水",
        category: "drink",
        quantity: 1,
        unitPrice: 0
      }
    ]
  },
  {
    eventId: "evt-002",
    orderNo: "ord-002",
    userId: "merchant-001",
    phone: "13800000004",
    role: "merchant",
    deviceCode: "CAB-1001",
    doorNum: "1",
    status: "closed",
    createdAt: "2026-03-24T02:30:00.000Z",
    updatedAt: "2026-03-24T02:36:00.000Z",
    amount: 0,
    goods: [
      {
        goodsId: "goods-1001",
        goodsName: "三明治",
        category: "food",
        quantity: 3,
        unitPrice: 0
      }
    ]
  }
];

export const seedInventory: InventoryMovement[] = [
  {
    id: "mov-001",
    orderNo: "ord-001",
    userId: "special-001",
    deviceCode: "CAB-1001",
    goodsId: "goods-1002",
    goodsName: "矿泉水",
    category: "drink",
    quantity: 1,
    unitPrice: 0,
    type: "pickup",
    happenedAt: "2026-03-24T01:14:00.000Z"
  },
  {
    id: "mov-002",
    orderNo: "ord-002",
    userId: "merchant-001",
    deviceCode: "CAB-1001",
    goodsId: "goods-1001",
    goodsName: "三明治",
    category: "food",
    quantity: 3,
    unitPrice: 0,
    type: "donation",
    happenedAt: "2026-03-24T02:36:00.000Z",
    expiresAt: "2026-03-25T16:00:00.000Z"
  }
];

export const seedAlerts: AlertTask[] = [
  {
    id: "alert-001",
    type: "expiry",
    title: "物资即将过期",
    status: "open",
    deviceCode: "CAB-1001",
    targetUserId: "merchant-001",
    dueAt: "2026-03-25T12:00:00.000Z",
    createdAt: "2026-03-24T03:00:00.000Z",
    detail: "三明治批次即将到期，请在领取期限结束前处理。"
  }
];

export const cloneSeedState = () => ({
  users: structuredClone(seedUsers),
  rules: structuredClone(seedRules),
  devices: structuredClone(seedDevices),
  events: structuredClone(seedEvents),
  inventory: structuredClone(seedInventory),
  alerts: structuredClone(seedAlerts)
});
