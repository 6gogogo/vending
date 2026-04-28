import type { SystemSettingInputType, SystemSettingOption } from "@vm/shared-types";

interface SystemSettingMetadata {
  label: string;
  description: string;
  inputType?: SystemSettingInputType;
  options?: SystemSettingOption[];
  sensitive?: boolean;
  required?: boolean;
  restartRequired?: boolean;
}

export const systemSettingCatalog: Record<string, SystemSettingMetadata> = {
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
    description: "系统级请求、外部接口调用和配置变更审计日志文件。",
    inputType: "path",
    required: true
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
    description: "OpenAI 兼容接口地址，例如 DashScope 或自建代理的 /v1 地址。",
    inputType: "url"
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
  SMARTVM_BASE_URL: {
    label: "柜机平台地址",
    description: "智能柜平台 API 根地址。",
    inputType: "url"
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
  PAYMENT_MOCK_ENABLED: {
    label: "启用本地模拟支付",
    description: "为空时按商户配置自动判断；true 强制模拟，false 强制真实支付。",
    inputType: "select",
    options: [
      { label: "自动", value: "" },
      { label: "启用", value: "true" },
      { label: "停用", value: "false" }
    ]
  },
  WECHAT_PAY_APP_ID: {
    label: "微信支付 App ID",
    description: "微信支付应用编号。",
    inputType: "password",
    sensitive: true
  },
  WECHAT_PAY_MCH_ID: {
    label: "微信支付商户号",
    description: "微信支付商户号。",
    inputType: "text"
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
    description: "mock 为本地验证码，aliyun 为阿里云短信验证码。",
    inputType: "select",
    options: [
      { label: "本地模拟", value: "mock" },
      { label: "阿里云短信", value: "aliyun" }
    ],
    required: true
  },
  VERIFICATION_CODE_PREVIEW_ENABLED: {
    label: "显示模拟验证码",
    description: "使用本地模拟验证码时，是否在接口响应中返回验证码便于联调。",
    inputType: "boolean"
  },
  ALIYUN_SMS_ACCESS_KEY_ID: {
    label: "阿里云 AccessKey ID",
    description: "阿里云短信服务 AccessKey ID。",
    inputType: "password",
    sensitive: true
  },
  ALIYUN_SMS_ACCESS_KEY_SECRET: {
    label: "阿里云 AccessKey Secret",
    description: "阿里云短信服务 AccessKey Secret。",
    inputType: "password",
    sensitive: true
  },
  ALIYUN_SMS_REGION_ID: {
    label: "阿里云短信地域",
    description: "阿里云短信服务地域 ID。",
    inputType: "text"
  },
  ALIYUN_SMS_ENDPOINT: {
    label: "阿里云短信 Endpoint",
    description: "阿里云短信服务接入域名。",
    inputType: "url"
  }
};
