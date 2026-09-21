export const appCopy = {
  title: "小柜大爱",
  supportPhone: "18051952053",
  supportPhoneLabel: "柜机异常？请联系客服电话",
  loginHeadline: "让用户、商家与管理员在同一套流程里顺畅协作。",
  loginBody:
    "请使用手机号验证码登录。首次使用可直接提交身份资料，审核通过后自动进入对应角色页面。",
  loginSupport: "若手机号已预先导入系统，首次登录仍需补齐基础资料；新账号提交后会进入审核流程。",
  disclaimer: {
    title: "公益智助柜用户免责声明",
    loginGuide: "输入手机号并同意免责声明",
    agreementCopy: "我已阅读并同意",
    validationMessage: "请先勾选同意《公益智助柜用户免责声明》。",
    validationToast: "请先勾选同意免责声明",
    dialogHint: "请阅读内容；是否同意请回到登录页勾选",
    bodyAriaLabel: "免责声明正文"
  },
  unifiedAuth: {
    brandSubtitle: "让公益更近一点",
    login: {
      pageTitle: "登录",
      cardTitle: "登录 / 注册",
      phoneLabel: "手机号",
      phonePlaceholder: "请输入手机号",
      phoneValidation: "请输入 11 位手机号",
      codeLabel: "验证码",
      codePlaceholder: "请输入验证码",
      codeValidation: "请输入验证码",
      manualCodeValidation: "请输入 6 位一次性验证码",
      requestCode: "获取验证码",
      codeSent: "验证码已发送",
      manualCodeHint: "请向实例管理员获取一次性验证码",
      providerLoadingHint: "正在确认验证码方式，请稍后重试",
      agreementPrefix: "阅读并同意",
      submit: "登录 / 注册",
      support: "联系工作人员",
      preview: (code: string) => `当前验证码 ${code}`,
      closeDisclaimer: "关闭并返回"
    },
    profile: {
      importedPageTitle: "核对资料",
      newPageTitle: "完善资料",
      importedEyebrow: "资料确认",
      newEyebrow: "注册申请",
      importedHeroTitle: "请核对个人资料",
      newHeroTitle: "请填写个人资料",
      verifiedPhone: "已验证手机号",
      verified: "已验证",
      confirmed: "已确认",
      nameLabel: "姓名",
      namePlaceholder: "请输入姓名",
      roleLabel: "身份",
      specialRole: "受助用户",
      merchantRole: "爱心商户",
      regionLabel: "所在片区",
      regionPlaceholder: "请选择所在片区",
      unset: "未设置",
      merchantNameLabel: "商户名称",
      merchantNamePlaceholder: "请输入商户名称",
      contactNameLabel: "联系人姓名",
      contactNamePlaceholder: "请输入联系人姓名",
      addressLabel: "经营地址",
      addressPlaceholder: "请输入经营地址",
      noteLabel: "备注（选填）",
      notePlaceholder: "可补充需要说明的信息",
      confirm: "确认资料并继续",
      submitReview: "提交审核",
      validation: {
        name: "请输入姓名",
        role: "请选择身份",
        region: "请选择所在片区",
        merchantName: "请输入商户名称",
        contactName: "请输入联系人姓名",
        address: "请输入经营地址"
      }
    },
    review: {
      pageTitle: "审核状态",
      pendingMark: "审核中",
      rejectedMark: "需修改",
      pendingTitle: "资料审核中",
      rejectedTitle: "资料需要修改",
      pendingDetail: "工作人员正在核对你提交的资料。",
      rejectedFallback: "资料需要补充，请修改后重新提交。",
      refresh: "刷新审核状态",
      edit: "修改资料",
      support: "联系工作人员"
    }
  },
  freeOnly: {
    hierarchicalQuotaLabel: "额度",
    quotaExhausted:
      "今天免费领取额度已用完，请等待额度刷新或联系工作人员；当前公益物资不会转为付费领取。",
    quotaEmptyDescription:
      "可继续查看附近柜机；领取额度刷新前不能开柜，当前公益物资不会转为付费领取。",
    amountLabel: "公益物资免费领取",
    historicalResolvedLabel: "历史状态已处理，本页不会发起支付",
    completedHint: "平台已完成领取核对，本次公益物资免费，不会发起支付。",
    unexpectedChargeTitle: "费用异常待核对",
    unexpectedChargeHint:
      "当前公益物资全部免费，系统检测到异常金额并已停止支付入口；请返回首页或提交反馈，由管理员核对。",
    unexpectedChargeBody:
      "请勿通过任何渠道付款。异常金额不会在本页发起支付，管理员核对后会回流处理结果。",
    feedbackAction: "提交费用异常反馈"
  },
  specialWelcome: "先看附近柜机、库存与今日可用额度，再选择意向物资发起取货。",
  merchantWelcome: "围绕柜机选择、补货登记、批次追踪与异常反馈组织每日动作。",
  historyIntro: "按时间查看本人服务记录，方便核对领取和处理结果。",
  openOutcomePending: {
    title: "开门结果待确认",
    detail:
      "暂时无法确认柜机是否已收到指令。请先查看现场柜门，不要重复开柜；返回首页等待状态更新，必要时联系工作人员。",
    actionText: "返回首页"
  },
  reservationPickup: {
    resultTitle: "实际领取结果",
    completedStatus: "领取已完成",
    mismatchStatus: "领取待核对",
    completedHint: "已按实际领取记录，零元订单自动完成。",
    mismatchHint: "这笔历史订单的领取结果待工作人员核对，本次不会产生支付。",
    completionTitle: "领取已完成",
    completionAction: "返回首页",
    completionContent: (settledItems: string, comparisonText: string) =>
      `实际领取：${settledItems}${comparisonText}\n本次领取已完成，不涉及支付。`
  },
  nearbyCabinets: {
    specialSubtitle: "先查询柜内物资，到柜扫码后直接开门领取。",
    choice: {
      reserve: "物资查询 · 查看库存",
      scan: "到柜扫码 · 直接领取"
    },
    location: {
      loadingTitle: "正在读取手机位置",
      readyTitle: "已获取你的位置",
      deniedTitle: "手机定位未授权",
      unavailableTitle: "暂未获取手机位置",
      loadingHint: "定位完成后将按距离排列附近柜机",
      readyHint: "已按距离由近到远排列附近柜机",
      deniedHint: "允许手机定位后可按距离排列，未开启也可正常查询",
      unavailableHint: "请确认手机系统定位已开启；暂时仍按推荐顺序展示",
      useAction: "使用手机定位",
      retryAction: "重新定位",
      loadingAction: "定位中",
      readyMessage: "已获取手机位置，柜机按距离排列",
      deniedMessage: "未获得手机定位权限，已按推荐顺序展示柜机",
      stillDeniedMessage: "手机定位仍未授权，已按推荐顺序展示柜机",
      unavailableMessage: "暂未获取手机位置，已按推荐顺序展示柜机",
      deniedToast: "请在小程序设置中允许手机定位",
      unavailableToast: "暂未获取手机位置，请确认系统定位已开启",
      loadingDistance: "正在读取手机定位",
      recommendedDistance: "按推荐顺序展示",
      pendingCabinetLocation: "柜机位置待设置",
      unavailableDistance: "距离暂不可用",
      distance: (value: string) => `距你 ${value}`
    },
    goods: {
      specialTitle: "柜内物资",
      cabinetTitle: "柜内物资",
      count: (quantity: number) => `共 ${quantity} 种`,
      viewAll: (quantity: number) => `查看全部 ${quantity} 种物资`,
      dialogTitle: "全部物资",
      close: "关闭",
      hierarchicalMeta: (stock: number) => `柜内 ${stock} 件 · 额度请进入详情查看`,
      specialMeta: (stock: number, available: number) =>
        `柜内 ${stock} 件 · 可领取 ${available} 件`,
      cabinetMeta: (category: string, stock: number) => `${category} · 当前 ${stock} 件`
    }
  },
  cabinetPickup: {
    defaultDeviceName: "柜机详情",
    entry: { pickup: "扫码领取", query: "物资查询", code: (code: string) => `柜机编号 ${code}`, compactCode: (code: string) => `编号 ${code}` },
    action: { reload: "重新加载", open: "开门", unavailable: "暂不可开门", noEntitlement: "当前暂不可领取", scan: "扫码开门", refresh: "刷新库存" },
    loadingState: "正在读取柜机状态。",
    syncingState: "正在读取柜机状态…",
    loadingGoods: "正在加载物资…",
    goodsUnavailable: "暂时无法读取库存，请稍后刷新。",
    emptyGoods: "当前尚未录入商品。",
    emptyStock: "暂无库存",
    inactiveGoods: "已停用",
    imageUnavailable: "暂无图片",
    quotaLabel: "今日领取权益",
    quotaCount: (count: number) => `剩余 ${count} 次`,
    rightsUsedUp: "开门权益今日已用完",
    noEntitlementHint: "当前不在可领取时段或没有可领取额度，可继续查看库存。",
    stockCount: (count: number) => `库存 ${count} 件`,
    expiryLabel: "有效期至",
    pickupTitle: "开门后按需领取",
    queryTitle: "柜内物资",
    pickupDescription: "无需选择商品，开门后按需领取。实际取走物资后使用一次权益，空开门不扣权益。",
    queryDescription: "查看柜内商品库存，领取时请到柜机前扫码。",
    pickupHint: "取走商品后请关好柜门，系统按实际取走的商品记录。",
    queryHint: "请到柜机前扫码领取。",
    invalidEntry: {
      title: "未识别到有效柜机",
      content: "请重新扫描柜机上的二维码。系统不会读取库存或发送开门指令。",
      confirm: "我知道了"
    }
  },
  serviceHighlights: ["手机号验证码注册登录", "审核状态实时同步", "取货、补货、反馈全程留痕"],
  firstUseSteps: [
    "首次使用先提交注册申请",
    "工作人员审核通过后登录",
    "首页查看今日额度和开放时段",
    "查询柜内物资，到柜扫码开门，按实际取走的商品记录"
  ]
};
