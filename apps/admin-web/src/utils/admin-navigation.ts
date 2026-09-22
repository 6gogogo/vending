import type { BackofficePermission, BackofficeRole } from "@vm/shared-types";

export interface AdminWorkspaceSection {
  value: string;
  label: string;
  keywords?: string;
  permission?: BackofficePermission;
  anyPermissions?: readonly BackofficePermission[];
  // 所列权限全部缺失时才显示，例如新实例的初始化指引。
  withoutPermissions?: readonly BackofficePermission[];
}

export interface AdminDestination {
  path: string;
  label: string;
  group: string;
  icon: string;
  description: string;
  permission?: BackofficePermission;
  roles?: readonly BackofficeRole[];
  sections?: AdminWorkspaceSection[];
}

const administrators: readonly BackofficeRole[] = ["super_admin", "admin"];
const extendedUserPermissions: readonly BackofficePermission[] = ["users:review", "users:rules:manage", "reservations:manage", "dashboard:view"];
const userSections: AdminWorkspaceSection[] = [
  { value: "directory", label: "人员台账", keywords: "新增 编辑 Excel 导入 后台权限 柜机分配 签发验证码 批量绑定 策略" },
  { value: "registrations", label: "注册审核", permission: "users:review" },
  { value: "rules", label: "领取与预约", keywords: "每日物资 模板 预约", anyPermissions: extendedUserPermissions },
  { value: "setup", label: "初始化指引", keywords: "开通 账号", withoutPermissions: extendedUserPermissions },
  { value: "regions", label: "地区管理", keywords: "坐标 地图", permission: "users:manage", anyPermissions: extendedUserPermissions },
  { value: "verification", label: "验证码记录", keywords: "应急码 登录验证", permission: "verification-codes:manage" }
];

// 导航、功能检索共用入口定义；路由和服务端仍独立校验权限。
export const adminDestinations: AdminDestination[] = [
  { path: "/platform", label: "全局工作台", group: "服务商平台", icon: "Building2", description: "创建和进入客户实例", permission: "platform-overview:view", roles: ["super_admin"] },
  { path: "/merchant", label: "商家工作台", group: "日常运营", icon: "Store", description: "补货批次、货品模板与领取去向", permission: "merchant-workbench:view", roles: ["merchant"] },
  { path: "/dashboard", label: "工作台", group: "工作空间", icon: "LayoutDashboard", description: "今日服务、待办任务和近期动态", permission: "dashboard:view", roles: administrators, sections: [{ value: "overview", label: "今日概况" }, { value: "tasks", label: "待办任务", keywords: "故障 反馈 预警" }, { value: "activity", label: "近期动态" }] },
  { path: "/users", label: "人员管理", group: "日常运营", icon: "UsersRound", description: "人员台账、注册审核、领取规则与账号授权", permission: "users:view", roles: administrators, sections: userSections },
  { path: "/operations", label: "柜机监控", group: "日常运营", icon: "PanelsTopLeft", description: "柜机在线状态、柜门、库存与异常", permission: "devices:view" },
  { path: "/goods", label: "货品管理", group: "日常运营", icon: "Package", description: "货品台账、库存预警和物资调拨", permission: "goods:view", roles: administrators, sections: [{ value: "catalog", label: "货品台账", keywords: "新增 分类 商品 同步平台" }, { value: "inventory", label: "库存与预警", keywords: "阈值 模板 分布 缺货" }, { value: "transfer", label: "库存调拨", keywords: "仓库" }] },
  { path: "/warehouse", label: "本地仓库", group: "日常运营", icon: "Warehouse", description: "仓库库存、上架调拨、过期处置与盘点", permission: "warehouse:view", roles: administrators, sections: [{ value: "inventory", label: "库存台账" }, { value: "transfer", label: "上架与盘点" }, { value: "expiry", label: "过期处置" }, { value: "records", label: "出入库记录", keywords: "调拨 盘点 导出" }] },
  { path: "/data-monitor", label: "数据分析", group: "分析与工具", icon: "ChartNoAxesCombined", description: "按日查看服务、货品和事件变化", permission: "analytics:data-monitor:view", roles: administrators },
  { path: "/logs", label: "操作日志", group: "分析与工具", icon: "ScrollText", description: "按人、柜、货和事件追溯操作", permission: "operation-logs:view", roles: administrators },
  { path: "/ai", label: "AI 助手", group: "分析与工具", icon: "Sparkles", description: "异常诊断、运营日报与策略建议", permission: "ai-insights:view", roles: administrators },
  { path: "/goods-taxonomy", label: "领取分类", group: "管理与帮助", icon: "Network", description: "货品分类树、唯一归属与额度范围", permission: "goods:view", roles: administrators },
  { path: "/settings", label: "系统设置", group: "管理与帮助", icon: "Settings2", description: "领取方式、登录验证和已授权服务", permission: "system-settings:view", roles: administrators },
  { path: "/manual", label: "操作手册", group: "管理与帮助", icon: "BookOpen", description: "当前身份的操作指引与常见问题", roles: ["super_admin", "admin", "merchant", "restocker"] }
];

export const isAdminDestinationActive = (path: string, target: string) =>
  path === target || path.startsWith(`${target}/`);

export const resolveWorkspaceSection = (raw: unknown, values: readonly string[]): string =>
  typeof raw === "string" && values.includes(raw) ? raw : values[0] ?? "";

export const canAccessAdminDestination = (
  item: AdminDestination,
  role: BackofficeRole | undefined,
  can: (permission: BackofficePermission) => boolean
) => Boolean(role) && (!item.roles || item.roles.includes(role!)) && (!item.permission || can(item.permission));

export const canAccessAdminSection = (
  section: NonNullable<AdminDestination["sections"]>[number],
  can: (permission: BackofficePermission) => boolean
) => (!section.permission || can(section.permission))
  && (!section.anyPermissions || section.anyPermissions.some(can))
  && (!section.withoutPermissions || !section.withoutPermissions.some(can));

// 页面与搜索消费同一份分区定义；页面只补充实时角标，避免新功能只出现在其中一处。
export const getAdminWorkspaceSections = (
  path: string,
  can: (permission: BackofficePermission) => boolean,
  counts: Record<string, number> = {}
) => (adminDestinations.find(item => item.path === path)?.sections ?? [])
  .filter(section => canAccessAdminSection(section, can))
  .map(section => ({ ...section, count: counts[section.value] }));
