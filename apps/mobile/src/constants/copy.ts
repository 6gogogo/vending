export const appCopy = {
  title: "小柜大爱",
  supportPhone: "18051952053",
  supportPhoneLabel: "柜机异常？请联系客服电话",
  loginHeadline: "让用户、商家与管理员在同一套流程里顺畅协作。",
  loginBody:
    "请使用手机号验证码登录。首次使用可直接提交身份资料，审核通过后自动进入对应角色页面。",
  loginSupport: "若手机号已预先导入系统，首次登录仍需补齐基础资料；新账号提交后会进入审核流程。",
  runtime: {
    simulationBadge: "模拟服务",
    unknownBadge: "运行环境未确认"
  },
  disclaimer: {
    title: "公益智助柜用户免责声明",
    loginGuide: "输入手机号并同意免责声明",
    agreementCopy: "我已阅读并同意",
    validationMessage: "请先勾选同意《公益智助柜用户免责声明》。",
    validationToast: "请先勾选同意免责声明",
    dialogHint: "请阅读内容；是否同意请回到登录页勾选",
    bodyAriaLabel: "免责声明正文"
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
  serviceHighlights: ["手机号验证码注册登录", "审核状态实时同步", "取货、补货、反馈全程留痕"],
  firstUseSteps: [
    "首次使用先提交注册申请",
    "工作人员审核通过后登录",
    "首页查看今日额度和开放时段",
    "选择柜机、物资并开柜领取"
  ]
};
