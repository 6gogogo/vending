import type { BackofficeRole } from "@vm/shared-types";

export type RoleManualId = "provider" | "admin" | "merchant" | "restocker" | "app";

export interface RoleManualSection {
  title: string;
  steps: string[];
  note?: string;
}

export interface RoleManual {
  id: RoleManualId;
  label: string;
  summary: string;
  sections: RoleManualSection[];
}

export const roleManualOrder: readonly RoleManualId[] = [
  "provider",
  "admin",
  "merchant",
  "restocker",
  "app"
];

export const roleManuals: Record<RoleManualId, RoleManual> = {
  provider: {
    id: "provider",
    label: "服务商",
    summary: "创建和管理实例，开通首位实例管理员，并在必要时帮助下级账号恢复访问。",
    sections: [
      {
        title: "创建并进入实例",
        steps: [
          "打开“全局工作台”，选择“创建实例”。",
          "填写实例名称，按实际用途选择模拟服务或正式服务。",
          "同时创建首位实例管理员，保存后从实例列表进入该实例。",
          "完成实例内工作后选择“退出当前实例”，返回全局工作台。"
        ]
      },
      {
        title: "管理实例账号",
        steps: [
          "在实例详情中新增、停用或更换实例管理员。",
          "下级账号忘记密码时，核对实例和人员后执行上级重置。",
          "服务商自己的密码在已登录时从侧栏修改；无法登录时使用 VNC 本机维护入口恢复。"
        ],
        note: "不要把服务商账号交给实例人员使用。"
      }
    ]
  },
  admin: {
    id: "admin",
    label: "实例管理员",
    summary: "管理当前实例的人员、货品、库存、柜机、预约规则和操作记录。",
    sections: [
      {
        title: "首次登录",
        steps: [
          "使用已经开通的后台账号登录。",
          "确认侧栏身份显示为“实例管理员”，并核对当前实例名称。",
          "打开“系统设置”，确认预约取货、额度规则和 App 登录方式。",
          "至少再开通一名可登录的实例管理员，避免唯一管理员无法自助找回密码。"
        ]
      },
      {
        title: "人员和权限",
        steps: [
          "在“人员管理”完成建档、审核和启用。",
          "按实际工作选择实例管理员、商户、补货员或普通用户。",
          "商户和补货员必须分配柜机；普通用户只使用 App，不需要后台账号。",
          "操作完成后重新打开人员详情，确认角色、账号状态和柜机范围。"
        ]
      },
      {
        title: "预约和人工验证码",
        steps: [
          "在“系统设置”开启预约取货；预约制不要求支付。",
          "在“人员管理”找到已启用的 App 用户，签发“APP / 小程序登录”用途的一次性验证码。",
          "验证码过期、撤销或使用后必须重新签发，不能多人共用。",
          "用户完成预约后，在预约记录和操作日志中核对结果。"
        ]
      }
    ]
  },
  merchant: {
    id: "merchant",
    label: "商户",
    summary: "查看自己的补货货品、入柜记录和已分配柜机。",
    sections: [
      {
        title: "开始工作",
        steps: [
          "使用实例管理员开通的商户账号登录。",
          "打开“商家工作台”，查看可补货模板和本人最近记录。",
          "打开“柜机监控”，核对分配给自己的柜机、货门和可见库存。",
          "页面没有提供的实例设置、人员管理和远程操作交由实例管理员处理。"
        ],
        note: "看不到未分配柜机属于正常权限限制。"
      }
    ]
  },
  restocker: {
    id: "restocker",
    label: "补货员",
    summary: "在分配给自己的柜机范围内完成补货、巡检和异常反馈。",
    sections: [
      {
        title: "补货与巡检",
        steps: [
          "使用实例管理员开通的补货员账号登录。",
          "打开“柜机监控”，确认目标柜机已经分配给自己。",
          "进入柜机详情，核对柜机编号、货门和当前库存。",
          "完成现场工作后记录异常柜门、库存差异和处理结果，并交给实例管理员复核。"
        ],
        note: "不要借用他人账号，也不要处理页面没有授权的柜机。"
      }
    ]
  },
  app: {
    id: "app",
    label: "App 用户",
    summary: "使用一次性验证码登录，预约物资并在有效期内到柜领取。",
    sections: [
      {
        title: "登录和预约",
        steps: [
          "首次使用前联系实例管理员完成建档、审核和启用。",
          "输入本人手机号和管理员交付的一次性验证码，阅读提示后登录。",
          "选择在线柜机和可预约物资，核对数量与保留时间后提交。",
          "在“当前预约”中查看状态；预约取货不会要求付款。"
        ]
      },
      {
        title: "到柜领取",
        steps: [
          "在预约有效期内到达页面显示的柜机。",
          "打开当前预约，核对柜机和物资后按页面提示操作。",
          "取出物资并关好柜门，等待页面显示最终结果。",
          "状态未确认时不要重复开柜，保留页面并联系实例管理员。"
        ]
      }
    ]
  }
};

const singleRoleManual: Partial<Record<BackofficeRole, RoleManualId>> = {
  admin: "admin",
  merchant: "merchant",
  restocker: "restocker"
};

export const resolveVisibleRoleManualIds = (
  role: BackofficeRole | undefined
): readonly RoleManualId[] => {
  if (role === "super_admin") {
    return roleManualOrder;
  }

  const manualId = role ? singleRoleManual[role] : undefined;
  return manualId ? [manualId] : [];
};
