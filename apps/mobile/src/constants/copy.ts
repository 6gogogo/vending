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
    planTitle: "预约取货计划",
    planSubtitle: "请先选择物资并提交预约，到柜后使用预约开柜。",
    selectionHint: "预约仅保留物资种类和数量；到柜后请按预约内容取货并及时关门。",
    itemListTitle: "预约物资清单",
    submitAction: "提交预约取货",
    openConfirmTitle: "确认预约取货",
    openConfirmHint: "请逐项核对现场柜机、距离和预约物资，再决定是否开门。",
    openConfirmSummary: "本次预约物资",
    openConfirmNotice: "柜门关闭后系统会记录实际领取结果；若与预约不一致，将转入管理员核对，不会发起支付。",
    resultTitle: "预约取货结果",
    completedStatus: "预约取货完成",
    mismatchStatus: "领取待核对",
    completedHint: "平台已完成本次预约取货核对，不涉及支付。",
    mismatchHint: "实际领取结果与预约不一致，已转交管理员核对；本次不会产生支付。",
    completionTitle: "预约取货完成",
    completionAction: "确认取货",
    completionContent: (settledItems: string, comparisonText: string) =>
      `平台核对：${settledItems}${comparisonText}\n本次预约取货已完成，不涉及支付。确认后将返回首页。`
  },
  cabinetPickup: {
    defaultDeviceName: "柜机",
    loadingStatus: {
      label: "状态加载中",
      hint: "请等待柜机状态加载完成。"
    },
    entry: {
      pickupEyebrow: "扫码领取",
      reservationEyebrow: "预约领取",
      identifying: "正在识别柜机",
      identityAriaLabel: "当前柜机",
      code: (deviceCode: string) => `柜机编号 ${deviceCode}`,
      compactCode: (deviceCode: string) => `编号 ${deviceCode}`
    },
    action: {
      reload: "重新加载",
      unavailable: "柜机暂不可开",
      open: "开柜领取",
      openCount: (quantity: number) => `开柜领取（${quantity} 件）`,
      reservationClosed: "预约暂未开放",
      submitCount: (quantity: number) => `提交预约（${quantity} 件）`,
      selectQuantity: "请选择领取数量",
      selectedCount: (quantity: number) => `已选 ${quantity} 件`
    },
    hint: {
      syncing: "正在同步柜机、库存、额度和预约信息。",
      reservationClosed: "当前暂未开放预约取货，系统不会发送开门指令。",
      existingReservation: "将使用当前有效预约开柜，不会重复创建预约或占用额度。",
      selectQuantity: "请选择每种商品的领取数量。",
      pickupReady: "确认后将创建临时预约并立即开柜；取货后请及时关门并核对领取结果。",
      reservationReady: "提交后会在本页显示预约凭条；到柜扫码时可直接使用该预约。"
    },
    quota: {
      maximum: (quantity: number) => `最多可领取 ${quantity} 件`,
      empty: "当前没有可领取额度"
    },
    confirmation: {
      title: "确认开柜领取",
      defaultGoods: "商品",
      noGoods: "未选择商品",
      content: (deviceName: string, deviceCode: string, goodsSummary: string) =>
        `${deviceName}\n柜机编号：${deviceCode}\n领取：${goodsSummary}`,
      confirm: "确认开柜",
      cancel: "返回修改"
    },
    errors: {
      selectPickup: "请先选择要领取的商品数量。",
      invalidOpenRequest: "未能生成有效的开柜请求。",
      selectReservation: "请先选择要预约的商品数量。",
      temporaryCancelled: (message: string) => `${message} 本次临时预约已自动取消。`,
      temporaryCancelUnknown: (message: string, forbidRepeat = false) =>
        `${message} 临时预约取消结果未确认，请到预约记录核对${forbidRepeat ? "，且不要重复开柜" : ""}。`
    },
    cancellation: {
      title: "确认取消预约",
      content: (goodsSummary: string) => `将取消 ${goodsSummary}。`,
      confirm: "取消预约",
      keep: "保留预约",
      success: "预约已取消"
    },
    invalidEntry: {
      title: "未识别到有效柜机",
      content: "请重新扫描柜机上的二维码。系统不会读取库存或发送开门指令。",
      confirm: "我知道了"
    },
    receipt: {
      ariaLabel: "预约凭条",
      eyebrow: "预约凭条",
      title: "等待到柜领取",
      pending: "待领取",
      machine: "柜机",
      goods: "商品",
      expiry: "有效期",
      state: "状态",
      stateText: "预约有效，扫码对应柜机后可开柜",
      expiresBefore: (expiresAt: string) => `${expiresAt} 前`,
      cancel: "取消预约"
    },
    existingReservation: {
      title: "已找到当前预约",
      status: "直接领取",
      expiresAt: (expiresAt: string) => `有效至 ${expiresAt}`
    },
    goods: {
      title: "选择领取数量",
      hint: "可预约数量和今日可领取额度会在开柜前再次校验。",
      stockLabel: "库存",
      availableLabel: "可领取",
      imageAlt: (goodsName: string) => `${goodsName}商品图`,
      imageUnavailable: "图片暂不可用",
      availabilityAriaLabel: (stock: number, available: number) =>
        `库存 ${stock} 件，可领取 ${available} 件`,
      entitlement: {
        rootFallback: "任意物资",
        sharedHint: "全局任意额度",
        selected: "已选",
        parentQuota: "本类",
        dedicated: "专属",
        shared: "任意"
      },
      meta: (category: string, stock: number, remaining: number) =>
        `${category} · 库存 ${stock} · 可领取 ${remaining}`,
      unreserved: (quantity: number) => `未预约 ${quantity} 件`,
      decreaseAriaLabel: (goodsName: string) => `为${goodsName}减少一件`,
      increaseAriaLabel: (goodsName: string) => `为${goodsName}增加一件`,
      loadingTitle: "正在加载商品",
      emptyTitle: "当前暂无可领取商品",
      loadingDescription: "请稍候。",
      emptyDescription: "库存或领取额度恢复后可再试。"
    }
  },
  serviceHighlights: ["手机号验证码注册登录", "审核状态实时同步", "取货、补货、反馈全程留痕"],
  firstUseSteps: [
    "首次使用先提交注册申请",
    "工作人员审核通过后登录",
    "首页查看今日额度和开放时段",
    "选择柜机与物资，提交预约后到柜取货"
  ]
};
