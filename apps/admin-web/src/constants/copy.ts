export const adminCopy = {
  runtime: {
    simulationBadge: "验收模拟实例",
    unknownBadge: "运行环境未确认"
  },
  map: {
    unsupported: "当前环境不支持地图加载",
    mockMode:
      "当前实例地图模式为模拟，未加载高德脚本，也不会发送地点搜索请求。" +
      "请将 VM_FULL_SIMULATION_MAP_MODE 设为 real，并为 API 进程配置有效的 " +
      "AMAP_WEB_KEY、AMAP_SECURITY_JS_CODE 后重启；在此之前可手工录入坐标。",
    missingWebKey: "后端未配置 AMAP_WEB_KEY",
    scriptLoadFailed:
      "高德地图脚本加载失败，请检查 AMAP_WEB_KEY、AMAP_SECURITY_JS_CODE 与当前域名白名单",
    searchUnavailable:
      "地图尚未初始化，无法搜索地点。请检查 AMAP_WEB_KEY、AMAP_SECURITY_JS_CODE 与域名白名单。",
    searchNoResult: "未找到地点，请尝试更具体的关键词。",
    searchInvalidCredential: (info: string) =>
      `高德搜索失败（${info}），请检查 AMAP_WEB_KEY、AMAP_SECURITY_JS_CODE 与当前域名白名单。`,
    searchFailed: (info?: string) =>
      info
        ? `高德搜索失败（${info}），请检查 AMAP_WEB_KEY、AMAP_SECURITY_JS_CODE、域名白名单或控制台配额。`
        : "高德搜索失败，请检查 AMAP_WEB_KEY、AMAP_SECURITY_JS_CODE、域名白名单或控制台配额。"
  }
} as const;
