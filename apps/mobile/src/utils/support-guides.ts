import type { UserRole } from "@vm/shared-types";

export interface SupportGuideFaq {
  question: string;
  answer: string;
}

export interface SupportGuideTopic {
  id: string;
  title: string;
  summary: string;
  steps: string[];
  faqs: SupportGuideFaq[];
}

const specialTopics: SupportGuideTopic[] = [
  {
    id: "login-code",
    title: "登录与验证码",
    summary: "适合处理验证码、登录失败和手机号核对问题。",
    steps: [
      "先确认当前填写的是本人正在使用的手机号。",
      "发送验证码后请等待 60 秒冷却结束，不要连续重复点击。",
      "如果仍无法登录，可返回登录首页重新获取验证码。"
    ],
    faqs: [
      {
        question: "一直收不到验证码怎么办？",
        answer: "先确认手机号是否正确、短信是否被拦截；若等待一段时间后仍未收到，可重新发送或提交反馈。"
      },
      {
        question: "验证码填错了会怎样？",
        answer: "系统会提示重新输入，你可以核对短信后再提交。"
      }
    ]
  },
  {
    id: "pickup",
    title: "验证领取",
    summary: "适合处理领取资格、提醒信息和扫码开门流程。",
    steps: [
      "先在主入口确认当天资格和开放时段。",
      "确认后可去附近柜机，或直接扫码进入柜机详情。",
      "出现提醒时先看说明，再决定是否提交反馈。"
    ],
    faqs: [
      {
        question: "为什么今天看不到领取资格？",
        answer: "可能当前不在开放时段，或当天额度已用完；请先看页面提醒。"
      },
      {
        question: "扫码后提示异常怎么办？",
        answer: "先核对柜机编号和当前账号，再重新扫码一次；如果仍异常，请走反馈入口。"
      }
    ]
  },
  {
    id: "nearby-device",
    title: "附近柜机与地图",
    summary: "适合处理定位不准、找柜机和地图按钮使用问题。",
    steps: [
      "进入附近柜机后先看地图位置，再使用下方整行按钮操作。",
      "如果定位不准，可刷新位置或改为扫码开门。",
      "查看柜机列表时优先选择在线柜机。"
    ],
    faqs: [
      {
        question: "地图没有显示我的位置怎么办？",
        answer: "先确认手机已开启定位权限，再返回页面重试。"
      },
      {
        question: "附近没有合适柜机怎么办？",
        answer: "可切换到列表查看其他柜机，或联系工作人员了解最近可用点位。"
      }
    ]
  }
];

const merchantTopics: SupportGuideTopic[] = [
  {
    id: "template",
    title: "商品属性维护",
    summary: "适合处理商品信息录入、图片和规格维护问题。",
    steps: [
      "先补全商品名称、分类、规格和默认数量。",
      "确认属性可用后，再进入补货登记。",
      "如发现旧属性不准确，可先修改后再继续补货。"
    ],
    faqs: [
      {
        question: "为什么补货时找不到商品？",
        answer: "通常是商品属性还没创建，或已被停用；请先检查商品属性页。"
      }
    ]
  },
  {
    id: "restock",
    title: "补货登记",
    summary: "适合处理补货数量、生产日期和柜机选择问题。",
    steps: [
      "进入补货登记后先选商品，再选柜机。",
      "确认数量和生产日期，必要时补充说明。",
      "提交后可到记录页查看流向。"
    ],
    faqs: [
      {
        question: "补货后数量看起来不对怎么办？",
        answer: "先核对提交记录和柜机详情；如果仍不一致，可反馈给管理员。"
      }
    ]
  },
  {
    id: "trace",
    title: "货物流向查看",
    summary: "适合处理累计帮助数据和批次去向查看问题。",
    steps: [
      "到记录页先看按日汇总，再看具体批次。",
      "如果要核对某批货，优先看柜机名称、剩余数量和到期时间。",
      "发现异常时结合最近补货日志一起排查。"
    ],
    faqs: [
      {
        question: "为什么当天帮助次数没有变化？",
        answer: "可能当天还没有新的领取记录，或数据仍在同步中。"
      }
    ]
  }
];

const adminTopics: SupportGuideTopic[] = [
  {
    id: "todo",
    title: "待办事件处理",
    summary: "适合处理临期、用户反馈和系统提示分类事件。",
    steps: [
      "先看分类数量，再按临期、反馈、系统提示顺序安排。",
      "点击详情核对柜机、商品、用户和时间信息。",
      "确认无误后再标记已处理，避免误关单。"
    ],
    faqs: [
      {
        question: "哪些事件应该优先处理？",
        answer: "优先处理影响领取和安全的事件，例如临期、故障和连续用户反馈。"
      }
    ]
  },
  {
    id: "approval",
    title: "人员审批与日志",
    summary: "适合处理注册审批、驳回原因和日志核对问题。",
    steps: [
      "审批前先核对姓名、手机号和申请身份。",
      "如需驳回，尽量填写明确原因，方便后续补充资料。",
      "通过后可继续在人员日志里查看记录和后续操作。"
    ],
    faqs: [
      {
        question: "为什么建议填写驳回原因？",
        answer: "明确原因能减少反复沟通，也方便申请人下一次补正资料。"
      }
    ]
  },
  {
    id: "device-list",
    title: "柜机巡检与列表",
    summary: "适合处理在线状态、待处理红点和进入详情页问题。",
    steps: [
      "柜机列表先看在线状态和待处理红点。",
      "待处理数量不为 0 时，应优先进入详情页处理。",
      "今日领取数可以帮助判断柜机当天服务活跃度。"
    ],
    faqs: [
      {
        question: "红点出现说明什么？",
        answer: "表示该柜机当前有待处理任务，建议优先查看详情。"
      }
    ]
  }
];

export const getSupportGuideTopics = (role: UserRole) => {
  if (role === "admin") {
    return adminTopics;
  }

  if (role === "merchant") {
    return merchantTopics;
  }

  return specialTopics;
};
