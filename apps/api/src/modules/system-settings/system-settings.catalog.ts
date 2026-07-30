import type {
  SystemSettingInputType,
  SystemSettingNumberConstraints,
  SystemSettingOption
} from "@vm/shared-types";

import { productionConfigurationSafetyCriticalKeys } from "../../common/config/production-safety";

interface SystemSettingMetadata {
  group?: string;
  label: string;
  description: string;
  inputType?: SystemSettingInputType;
  options?: SystemSettingOption[];
  numberConstraints?: SystemSettingNumberConstraints;
  sensitive?: boolean;
  required?: boolean;
  restartRequired?: boolean;
}

export const systemSettingCatalog: Record<string, SystemSettingMetadata> = {
  NODE_ENV: {
    group: "运行环境",
    label: "服务运行环境",
    description: "从下拉选项选择服务用途。上线后的生产环境由发布流程锁定。",
    inputType: "select",
    options: [
      { label: "开发环境", value: "development" },
      { label: "测试环境", value: "test" },
      { label: "生产环境", value: "production" }
    ],
    restartRequired: true
  },
  APP_ENV: {
    group: "运行环境",
    label: "应用运行环境",
    description: "与服务运行环境保持一致。上线后的生产环境由发布流程锁定。",
    inputType: "select",
    options: [
      { label: "开发环境", value: "development" },
      { label: "测试环境", value: "test" },
      { label: "生产环境", value: "production" }
    ],
    restartRequired: true
  },
  VM_DATA_PLANE: {
    group: "运行环境",
    label: "数据运行方式",
    description: "由发布流程确定。后台仅用于确认当前服务使用模拟数据还是实机数据。",
    inputType: "select",
    options: [
      { label: "模拟服务", value: "simulation" },
      { label: "实机服务", value: "live" }
    ],
    required: true,
    restartRequired: true
  },
  VM_SIMULATION_PROFILE: {
    group: "运行方式",
    label: "模拟运行档",
    description: "standard 为全模块 mock；full 为隔离的全真模拟，允许逐项选择真实外部模块，但仍绝不使用真实数据平面。",
    inputType: "select",
    options: [
      { label: "标准模拟：全部 mock", value: "standard" },
      { label: "全真模拟：按模块选择", value: "full" }
    ],
    required: true,
    restartRequired: true
  },
  VM_FULL_SIMULATION_ENABLED: {
    group: "运行方式",
    label: "确认启用全真模拟",
    description: "只有 VM_SIMULATION_PROFILE=full 时生效。必须显式开启，并配合独立的数据根和实例标识后才能启动。",
    inputType: "boolean",
    restartRequired: true
  },
  VM_FULL_SIMULATION_SMARTVM_MODE: {
    group: "运行方式",
    label: "全真模拟：柜机平台",
    description: "mock 不会向 SmartVM 发请求；real 仅在隔离模拟数据下使用已配置的真实柜机平台，缺少接入配置将拒绝启动。",
    inputType: "select",
    options: [
      { label: "模拟柜机", value: "mock" },
      { label: "真实 SmartVM", value: "real" }
    ],
    restartRequired: true
  },
  VM_FULL_SIMULATION_PAYMENT_MODE: {
    group: "示例设置",
    label: "非预约领取：支付验证",
    description: "仅在关闭预约取货后选择即时领取的支付处理方式。预约取货开启时无需设置，也不会创建新的支付单。",
    inputType: "select",
    options: [
      { label: "模拟支付", value: "mock" },
      { label: "真实支付", value: "real" }
    ],
    restartRequired: true
  },
  VM_FULL_SIMULATION_VERIFICATION_MODE: {
    group: "示例设置",
    label: "App 登录验证方式",
    description: "选择 App 登录的验证方式。手动设置验证码由当前实例管理员在人员页为已启用账号签发，6 位、短期且只能使用一次。",
    inputType: "select",
    options: [
      { label: "模拟验证码", value: "mock" },
      { label: "短信验证码（服务自动发送）", value: "real" },
      { label: "手动设置验证码", value: "manual" }
    ],
    restartRequired: true
  },
  VM_FULL_SIMULATION_AI_MODE: {
    group: "运行方式",
    label: "全真模拟：AI",
    description: "mock 返回本地稳定兜底结果且不外发业务上下文；real 调用已配置的 OpenAI 兼容服务。",
    inputType: "select",
    options: [
      { label: "模拟 AI", value: "mock" },
      { label: "真实 AI", value: "real" }
    ],
    restartRequired: true
  },
  VM_FULL_SIMULATION_MAP_MODE: {
    group: "运行方式",
    label: "全真模拟：地图",
    description: "mock 不加载高德脚本，可手工录入坐标；real 向后台提供已配置的高德 Web Key。",
    inputType: "select",
    options: [
      { label: "模拟地图", value: "mock" },
      { label: "真实高德地图", value: "real" }
    ],
    restartRequired: true
  },
  VM_RESERVATION_ONLY_PICKUP: {
    group: "示例设置",
    label: "预约取货",
    description: "开启后，用户先预约再取货；当前领取流程不需要支付配置。关闭后按即时领取方式处理。",
    inputType: "boolean",
    restartRequired: true
  },
  VM_DATA_ROOT: {
    label: "运行数据根目录",
    description: "真实平面与全真模拟均从此根目录统一派生状态、审计、上传、备份和金融租约路径；全真模拟必须使用与其他平面不同的目录。",
    inputType: "path",
    required: true,
    restartRequired: true
  },
  VM_DATA_PLANE_ID: {
    label: "运行数据平面实例标识",
    description: "由受控部署环境为每个数据根固定分配；用于拒绝跨实例备份恢复，运行中不得在线修改。",
    inputType: "text",
    required: true,
    restartRequired: true
  },
  PORT: {
    label: "API 服务端口",
    description: "Nest 后端监听端口，修改后需要重启服务才会切换监听端口。",
    inputType: "number",
    required: true,
    restartRequired: true
  },
  PUBLIC_BASE_URL: {
    label: "后端公开地址",
    description: "用于回调、静态资源和外部服务访问后端的公开根地址。",
    inputType: "url",
    required: true
  },
  CORS_ORIGINS: {
    label: "允许跨域来源",
    description: "允许浏览器访问 API 的前端来源，多个来源用英文逗号分隔；生产环境必须使用 HTTPS。",
    inputType: "text",
    required: true,
    restartRequired: true
  },
  API_DATA_FILE: {
    label: "业务数据文件",
    description: "本地 JSON 数据文件路径。修改后建议重启并确认数据迁移。",
    inputType: "path",
    required: true,
    restartRequired: true
  },
  UPLOAD_DIR: {
    label: "上传文件目录",
    description: "图片等上传文件保存目录。静态资源挂载在启动时完成，修改后需重启。",
    inputType: "path",
    required: true,
    restartRequired: true
  },
  SYSTEM_LOG_FILE: {
    label: "系统审计日志",
    description: "系统级请求、外部接口调用和配置变更审计日志文件；只能在停服维护窗口通过受控部署配置修改。",
    inputType: "path",
    required: true,
    restartRequired: true
  },
  DATABASE_URL: {
    label: "数据库连接",
    description: "PostgreSQL/Prisma 数据库连接串，数据库模式切换通常需要重启服务。",
    inputType: "password",
    sensitive: true,
    restartRequired: true
  },
  BUSINESS_TIMEZONE_OFFSET_HOURS: {
    label: "业务时区偏移",
    description: "业务日期换算使用的 UTC 偏移小时数，例如北京时间为 8。",
    inputType: "number",
    required: true
  },
  BUSINESS_DAY_START_HOUR: {
    label: "业务日起始小时",
    description: "业务日从本地几点开始统计，例如 4 表示凌晨四点切换业务日。",
    inputType: "number",
    required: true
  },
  AMAP_WEB_KEY: {
    label: "高德 Web Key",
    description: "PC 后台地图组件使用的高德 Web 端 Key。",
    inputType: "password",
    sensitive: true
  },
  AMAP_SECURITY_JS_CODE: {
    label: "高德安全密钥",
    description: "高德 JS API 安全密钥，前端地图加载时使用。",
    inputType: "password",
    sensitive: true
  },
  OPENAI_API_KEY: {
    label: "大模型 API Key",
    description: "OpenAI 兼容接口鉴权 Key，留空则 AI 能力不可用。",
    inputType: "password",
    sensitive: true
  },
  OPENAI_BASE_URL: {
    label: "大模型 Base URL",
    description: "OpenAI 兼容接口地址；默认只接受 HTTPS 公网主机。",
    inputType: "url"
  },
  OPENAI_BASE_URL_EXACT_HOST_ALLOWLIST: {
    label: "大模型精确主机允许名单",
    description: "仅供本地或私网模型例外使用，填写逗号分隔的精确主机名或 IP；不支持 URL、端口或通配符。",
    inputType: "text"
  },
  OPENAI_MODEL: {
    label: "大模型名称",
    description: "AI 工作台默认调用的模型名称。",
    inputType: "text"
  },
  OPENAI_TIMEOUT_MS: {
    label: "大模型超时毫秒",
    description: "调用大模型接口的请求超时时间。",
    inputType: "number"
  },
  SMARTVM_MODE: {
    group: "柜机平台接入",
    label: "柜机接入状态",
    description: "新实例还没有柜机时选择“尚未接入柜机”；录入首台柜机前必须切换为正式 SmartVM，并完成生产地址和凭据配置。",
    inputType: "select",
    options: [
      { label: "尚未接入柜机", value: "disabled" },
      { label: "正式 SmartVM", value: "real" }
    ],
    required: true,
    restartRequired: true
  },
  SMARTVM_BASE_URL: {
    group: "柜机平台接入",
    label: "柜机平台地址",
    description: "智能柜平台 API 根地址。",
    inputType: "url"
  },
  SMARTVM_TIMEOUT_MS: {
    label: "柜机平台超时毫秒",
    description: "柜机查询、开门、付款回写和退款外呼的最长等待时间。",
    inputType: "number"
  },
  SMARTVM_STATUS_STALE_AFTER_MS: {
    label: "柜机状态过期毫秒",
    description: "设备最后一次可信在线活动超过该时长后按状态过期处理，并在重新验证前禁止开门。",
    inputType: "number"
  },
  SMARTVM_OPEN_COMMAND_LEASE_MS: {
    label: "开门命令在途保护毫秒",
    description: "开门命令等待设备响应期间，同一柜门禁止重复下发的最长保护时间。",
    inputType: "number"
  },
  SMARTVM_ALLOWED_NOTIFY_ORIGINS: {
    label: "柜机回写允许来源",
    description: "额外允许的付款回写 URL 来源，多个用英文逗号分隔；柜机平台根地址会自动允许。",
    inputType: "text"
  },
  SMARTVM_CLIENT_ID: {
    label: "柜机平台 Client ID",
    description: "智能柜平台分配的接入账号。",
    inputType: "password",
    sensitive: true
  },
  SMARTVM_KEY: {
    label: "柜机平台密钥",
    description: "智能柜平台签名密钥。",
    inputType: "password",
    sensitive: true
  },
  SMARTVM_ALLOW_UNSIGNED_CALLBACKS: {
    label: "允许未签名柜机回调",
    description: "仅用于本地联调；生产环境必须关闭。",
    inputType: "boolean"
  },
  SMARTVM_DEFAULT_PAY_STYLE: {
    label: "默认支付方式",
    description: "下发开门请求时使用的默认 payStyle。",
    inputType: "number"
  },
  SMARTVM_AUTO_FORWARD_SETTLEMENT_PAYMENT_SUCCESS: {
    label: "结算后自动转发支付成功",
    description: "柜机结算回调后是否自动触发支付成功转发。",
    inputType: "boolean"
  },
  SMARTVM_TEST_DEVICE_CODE: {
    label: "测试柜机编号",
    description: "沙箱脚本和联调默认使用的柜机编号。",
    inputType: "text"
  },
  SMARTVM_TEST_DOOR_NUM: {
    label: "测试门号",
    description: "沙箱脚本和联调默认使用的柜门号。",
    inputType: "number"
  },
  SMARTVM_DOOR_STATUS_CALLBACK_PATH: {
    label: "门状态回调路径",
    description: "智能柜门状态回调在本系统中的接收路径。",
    inputType: "path"
  },
  SMARTVM_SETTLEMENT_CALLBACK_PATH: {
    label: "结算回调路径",
    description: "智能柜结算回调在本系统中的接收路径。",
    inputType: "path"
  },
  SMARTVM_ADJUSTMENT_CALLBACK_PATH: {
    label: "补扣回调路径",
    description: "智能柜补扣回调在本系统中的接收路径。",
    inputType: "path"
  },
  SMARTVM_ADJUSTMENT_QUOTA_TIME_MODE: {
    group: "示例设置",
    label: "领取差异的额度归属",
    description: "当柜机实际数量与预约不一致时，选择差异计入哪一天的可领取额度。建议保留“自动”。",
    inputType: "select",
    options: [
      { label: "自动：有预约按预约日，无预约按领取日", value: "auto" },
      { label: "按原领取时间计入额度", value: "transaction_time" },
      { label: "按预约创建时间计入额度", value: "reservation_time" },
      { label: "按柜机回传时间计入额度", value: "callback_time" }
    ]
  },
  SMARTVM_REFUND_CALLBACK_PATH: {
    label: "退款回调路径",
    description: "智能柜退款回调在本系统中的接收路径。",
    inputType: "path"
  },
  SMARTVM_PAYMENT_SUCCESS_PATH: {
    label: "支付成功通知路径",
    description: "向柜机平台转发支付成功通知时使用的接口路径。",
    inputType: "path"
  },
  PAYMENT_MODE: {
    label: "支付运行模式",
    description: "预约取货可关闭支付；即时领取可使用模拟、自动或严格真实支付。",
    inputType: "select",
    options: [
      { label: "关闭支付（仅预约取货）", value: "disabled" },
      { label: "自动：缺配置时模拟", value: "auto" },
      { label: "强制模拟支付", value: "mock" },
      { label: "严格真实支付", value: "real" }
    ]
  },
  PAYMENT_PROVIDER_TIMEOUT_MS: {
    label: "支付平台超时毫秒",
    description: "微信支付和支付宝外呼的最长等待时间。",
    inputType: "number"
  },
  FINANCIAL_SINGLE_WRITER_ENABLED: {
    label: "金融单写者租约",
    description: "JSON 账本仅允许一个 API 实例写入支付与退款；生产环境必须启用。",
    inputType: "boolean",
    restartRequired: true
  },
  WEB_CONCURRENCY: {
    label: "Web 工作者数量",
    description: "JSON 账本阶段必须固定为 1，禁止 cluster 或多工作者。",
    inputType: "number",
    numberConstraints: {
      min: 1,
      max: 1,
      integerOnly: true
    },
    restartRequired: true
  },
  API_INSTANCE_COUNT: {
    label: "API 实例数量",
    description: "JSON 账本阶段必须固定为 1，禁止并行 API 实例写入同一账本。",
    inputType: "number",
    numberConstraints: {
      min: 1,
      max: 1,
      integerOnly: true
    },
    restartRequired: true
  },
  FINANCIAL_INSTANCE_ID: {
    label: "金融实例标识",
    description: "单写者租约的实例标识。留空会自动生成；多进程排障时可填写稳定且唯一的值。",
    inputType: "text",
    restartRequired: true
  },
  FINANCIAL_SINGLE_WRITER_LEASE_FILE: {
    label: "金融单写者租约文件",
    description: "跨进程互斥租约的本地文件路径。所有同一账本实例必须共享该路径。",
    inputType: "path",
    restartRequired: true
  },
  FINANCIAL_SINGLE_WRITER_LEASE_MS: {
    label: "金融租约有效期毫秒",
    description: "心跳失联后租约等待过期的最长时间，建议保持 30000。",
    inputType: "number",
    restartRequired: true
  },
  FINANCIAL_SINGLE_WRITER_HEARTBEAT_MS: {
    label: "金融租约心跳毫秒",
    description: "单写者续租频率，必须小于租约有效期的一半。",
    inputType: "number",
    restartRequired: true
  },
  PAYMENT_RECONCILIATION_ENABLED: {
    label: "支付后台自动对账",
    description: "仅对真实支付和退款的待确认状态查询原渠道；生产环境必须启用。",
    inputType: "boolean",
    restartRequired: true
  },
  PAYMENT_RECONCILIATION_INTERVAL_MS: {
    label: "支付对账扫描间隔毫秒",
    description: "后台扫描到期支付或退款的间隔，范围为 1000 至 3600000 毫秒。",
    inputType: "number",
    numberConstraints: {
      min: 1_000,
      max: 3_600_000,
      integerOnly: true
    },
    restartRequired: true
  },
  PAYMENT_RECONCILIATION_INITIAL_DELAY_MS: {
    label: "支付对账首次等待毫秒",
    description: "渠道结果未明确时，首次自动核对前等待 1000 至 3600000 毫秒，且不能大于最大退避。",
    inputType: "number",
    numberConstraints: {
      min: 1_000,
      max: 3_600_000,
      integerOnly: true
    }
  },
  PAYMENT_RECONCILIATION_MAX_DELAY_MS: {
    label: "支付对账最大退避毫秒",
    description: "连续待确认或失败时，自动对账间隔上限为 1000 至 86400000 毫秒，且不能小于首次等待。",
    inputType: "number",
    numberConstraints: {
      min: 1_000,
      max: 86_400_000,
      integerOnly: true
    }
  },
  PAYMENT_RECONCILIATION_BATCH_SIZE: {
    label: "支付对账单轮上限",
    description: "每个后台周期最多核对的支付和退款总数，必须是 1 至 100 的整数。",
    inputType: "number",
    numberConstraints: {
      min: 1,
      max: 100,
      integerOnly: true
    }
  },
  PAYMENT_RECONCILIATION_ALERT_AFTER_ATTEMPTS: {
    label: "支付对账告警阈值",
    description: "连续自动核对达到 1 至 100 次仍无终态时，仅创建一次人工核对告警。",
    inputType: "number",
    numberConstraints: {
      min: 1,
      max: 100,
      integerOnly: true
    }
  },
  PAYMENT_RECONCILIATION_USER_REQUEST_COOLDOWN_MS: {
    label: "本人核对请求冷却毫秒",
    description: "特殊群体本人重复请求后台核对原支付单的最短间隔，范围为 1000 至 3600000 毫秒；请求线程不会直接访问支付渠道。",
    inputType: "number",
    numberConstraints: {
      min: 1_000,
      max: 3_600_000,
      integerOnly: true
    }
  },
  PAYMENT_MOCK_ENABLED: {
    label: "旧版模拟支付开关",
    description: "兼容旧配置；PAYMENT_MODE 优先。留空跟随 PAYMENT_MODE；true 强制模拟；false 等价严格真实支付。",
    inputType: "select",
    options: [
      { label: "跟随 PAYMENT_MODE", value: "" },
      { label: "强制模拟", value: "true" },
      { label: "严格真实", value: "false" }
    ]
  },
  WECHAT_PAY_APP_ID: {
    label: "微信支付 App ID",
    description: "微信支付应用编号。",
    inputType: "password",
    sensitive: true
  },
  WECHAT_MINI_APP_SECRET: {
    label: "微信小程序 App Secret",
    description: "用于把微信登录 code 换取付款用户 openid。",
    inputType: "password",
    sensitive: true
  },
  WECHAT_MINI_LOGIN_URL: {
    label: "微信登录凭证校验接口",
    description: "微信 jscode2session 接口地址，留空使用官方接口。",
    inputType: "url"
  },
  WECHAT_PAY_MCH_ID: {
    label: "微信支付商户号",
    description: "微信支付商户号。",
    inputType: "text"
  },
  WECHAT_PAY_API_BASE_URL: {
    label: "微信支付 API 地址",
    description: "微信支付 API v3 根地址，留空使用官方生产地址。",
    inputType: "url"
  },
  WECHAT_PAY_NOTIFY_URL: {
    label: "微信支付回调地址",
    description: "微信支付成功回调完整 URL，留空使用 PUBLIC_BASE_URL 自动拼接。",
    inputType: "url"
  },
  WECHAT_PAY_REFUND_NOTIFY_URL: {
    label: "微信退款回调地址",
    description: "微信退款结果回调完整 URL，留空使用 PUBLIC_BASE_URL 自动拼接。",
    inputType: "url"
  },
  WECHAT_PAY_API_V3_KEY: {
    label: "微信支付 API v3 Key",
    description: "微信支付回调解密和签名使用的 API v3 Key。",
    inputType: "password",
    sensitive: true
  },
  WECHAT_PAY_MERCHANT_PRIVATE_KEY: {
    label: "微信支付商户私钥",
    description: "微信支付商户私钥内容。",
    inputType: "textarea",
    sensitive: true
  },
  WECHAT_PAY_MERCHANT_CERT_SERIAL_NO: {
    label: "微信支付商户证书序列号",
    description: "微信支付商户 API 证书序列号。",
    inputType: "password",
    sensitive: true
  },
  WECHAT_PAY_PLATFORM_CERT_SERIAL_NO: {
    label: "微信支付平台证书序列号",
    description: "用于校验 Wechatpay-Serial 回调头，必须与当前平台证书或平台公钥标识匹配。",
    inputType: "password",
    sensitive: true
  },
  WECHAT_PAY_PLATFORM_PUBLIC_KEY: {
    label: "微信支付平台公钥",
    description: "微信支付平台公钥内容。",
    inputType: "textarea",
    sensitive: true
  },
  ALIPAY_APP_ID: {
    label: "支付宝 App ID",
    description: "支付宝应用编号。",
    inputType: "text"
  },
  ALIPAY_GATEWAY_URL: {
    label: "支付宝网关地址",
    description: "支付宝 OpenAPI 网关地址，留空使用官方生产网关。",
    inputType: "url"
  },
  ALIPAY_NOTIFY_URL: {
    label: "支付宝支付回调地址",
    description: "支付宝异步通知完整 URL，留空使用 PUBLIC_BASE_URL 自动拼接。",
    inputType: "url"
  },
  ALIPAY_SELLER_ID: {
    label: "支付宝收款方 ID",
    description: "支付宝卖家账号或商户 UID。",
    inputType: "text"
  },
  ALIPAY_APP_PRIVATE_KEY: {
    label: "支付宝应用私钥",
    description: "支付宝应用私钥内容。",
    inputType: "textarea",
    sensitive: true
  },
  ALIPAY_PUBLIC_KEY: {
    label: "支付宝公钥",
    description: "支付宝公钥内容。",
    inputType: "textarea",
    sensitive: true
  },
  VERIFICATION_CODE_PROVIDER: {
    label: "验证码服务",
    description: "mock 为本地验证码；manual 仅接受后台签发的一次性人工验证码；aliyun_pnvs 使用阿里云号码认证短信。",
    inputType: "select",
    options: [
      { label: "本地模拟", value: "mock" },
      { label: "后台签发一次性人工验证码", value: "manual" },
      { label: "阿里云号码认证（PNVS）", value: "aliyun_pnvs" }
    ],
    required: true
  },
  VERIFICATION_CODE_PREVIEW_ENABLED: {
    label: "显示模拟验证码",
    description: "仅限本机联调。开启后，接口响应可能返回验证码；生产环境必须关闭。",
    inputType: "boolean"
  },
  ALLOW_DEFAULT_BACKOFFICE_LOGIN: {
    label: "允许默认后台密码登录",
    description: "仅限本机初始化联调。关闭后，仍使用默认密码的后台账号不能登录。",
    inputType: "boolean"
  },
  ALIYUN_PNVS_ACCESS_KEY_ID: {
    label: "阿里云 PNVS AccessKey ID",
    description: "仅授予号码认证短信所需最小权限的 RAM AccessKey ID。",
    inputType: "password",
    sensitive: true
  },
  ALIYUN_PNVS_ACCESS_KEY_SECRET: {
    label: "阿里云 PNVS AccessKey Secret",
    description: "仅服务端密钥管理保存的号码认证 RAM AccessKey Secret。",
    inputType: "password",
    sensitive: true
  },
  ALIYUN_PNVS_REGION_ID: {
    label: "阿里云 PNVS 地域",
    description: "号码认证服务地域，通常为 cn-hangzhou。",
    inputType: "text"
  },
  ALIYUN_PNVS_ENDPOINT: {
    label: "阿里云 PNVS Endpoint",
    description: "号码认证服务官方 HTTPS Endpoint，通常为 dypnsapi.aliyuncs.com。",
    inputType: "url"
  },
  ALIYUN_PNVS_SIGN_NAME: {
    label: "阿里云 PNVS 系统签名",
    description: "已在号码认证控制台配置并审核通过的系统签名。",
    inputType: "text",
    required: true
  },
  ALIYUN_PNVS_TEMPLATE_CODE: {
    label: "阿里云 PNVS 系统模板",
    description: "已审核的验证码模板；模板参数必须包含 ##code## 占位符。",
    inputType: "text",
    required: true
  },
  ALIYUN_PNVS_SCHEME_NAME_APP_LOGIN: {
    label: "PNVS 小程序登录方案",
    description: "可选；留空使用阿里云默认方案。填写时只用于 app-login，发送与核验必须一致。",
    inputType: "text"
  },
  ALIYUN_PNVS_SCHEME_NAME_REGISTER: {
    label: "PNVS 注册方案",
    description: "可选；留空使用阿里云默认方案。填写时只用于 register。",
    inputType: "text"
  },
  ALIYUN_PNVS_SCHEME_NAME_GENERAL: {
    label: "PNVS 通用登录方案",
    description: "可选；留空使用阿里云默认方案。填写时只用于 general，发送与核验必须一致。",
    inputType: "text"
  },
  ALIYUN_PNVS_SCHEME_NAME_PASSWORD_RESET: {
    label: "PNVS 本人密码重置方案",
    description: "可选；留空使用阿里云默认方案。填写时只用于 password-reset，发送与核验必须一致。",
    inputType: "text"
  }
};

for (const key of productionConfigurationSafetyCriticalKeys) {
  const metadata = systemSettingCatalog[key];

  if (metadata) {
    metadata.restartRequired = true;
  }
}
