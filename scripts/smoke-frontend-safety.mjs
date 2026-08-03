import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

const readSource = (path) => readFileSync(resolve(process.cwd(), path), "utf8");

const collectSourceFiles = (directory) => readdirSync(resolve(process.cwd(), directory), { withFileTypes: true })
  .flatMap((entry) => {
    const relativePath = `${directory}/${entry.name}`;
    if (entry.isDirectory()) return collectSourceFiles(relativePath);
    return /\.(?:ts|vue)$/.test(entry.name) ? [relativePath] : [];
  });

const scanSource = readSource("apps/mobile/src/utils/scan-device.ts");
assert.match(scanSource, /onlyFromCamera:\s*true/, "扫码必须仅允许相机来源");
assert.doesNotMatch(scanSource, /onlyFromCamera:\s*false/, "扫码不得重新开放相册来源");

const deviceDetailSource = readSource("apps/mobile/src/pages/special/device-detail.vue");
assert.match(deviceDetailSource, /const previewAndConfirmOpen\s*=\s*async/, "开柜必须保留统一预览确认入口");
const reservationOpenSource = deviceDetailSource.slice(
  deviceDetailSource.indexOf("const openWithReservation"),
  deviceDetailSource.indexOf("const cancelReservation")
);
assert.match(reservationOpenSource, /previewAndConfirmOpen\(payload, reservation\)/, "预约开柜必须经过预览确认");
assert.doesNotMatch(reservationOpenSource, /performOpen\(payload\)/, "预约开柜不得绕过统一确认入口");
for (const reservationCopy of [
  "预约不锁定当前批次或当前保质期",
  "到柜开门时将使用仍有效的库存",
  "预约仍在，但当前没有可履约的有效批次",
  "重新查看物资",
  "取消预约"
]) {
  assert.ok(deviceDetailSource.includes(reservationCopy), `预约流程必须明确展示：${reservationCopy}`);
}
assert.doesNotMatch(
  deviceDetailSource,
  /v-if="[^"]*!accessibilityEnabled[^"]*" class="(?:reservation-panel|reservation-rules|settlement-preview|distance-banner)/,
  "无障碍模式不得隐藏预约、预结算或距离风险信息"
);
assert.match(deviceDetailSource, /:aria-label="`为\$\{goods\.name\}减少一件`"/, "减少商品数量按钮必须有具体可访问名称");
assert.match(deviceDetailSource, /:aria-label="`为\$\{goods\.name\}增加一件`"/, "增加商品数量按钮必须有具体可访问名称");
assert.match(deviceDetailSource, /class="stepper__value" aria-live="polite" aria-atomic="true"/, "商品数量变化必须向辅助技术播报");
for (const requiredContext of ["柜机编号", "柜门", "距离验证"]) {
  assert.ok(deviceDetailSource.includes(requiredContext), `开柜最终确认必须展示${requiredContext}`);
}
assert.match(
  deviceDetailSource,
  /appCopy\.reservationPickup\.openConfirmSummary/,
  "开柜最终确认必须展示预约物资摘要"
);
assert.match(
  deviceDetailSource,
  /class="open-confirmation-dialog"[\s\S]+role="dialog"[\s\S]+aria-modal="true"/,
  "开柜最终确认必须使用有明确模态语义的结构化核对单"
);
assert.doesNotMatch(deviceDetailSource, /class="open-confirmation-settlement__amount"/, "预约取货确认不得展示支付金额");
assert.match(deviceDetailSource, /class="open-confirmation-risk"/, "预约取货确认必须继续独立展示距离风险");
assert.doesNotMatch(deviceDetailSource, /quoteExpiresAt/, "预约取货确认不得依赖服务端支付报价有效期");
assert.match(
  deviceDetailSource,
  /:disabled="submitting"/,
  "预约取货确认提交中必须禁止重复开柜"
);
assert.match(deviceDetailSource, /@keydown\.tab\.stop="trapOpenConfirmationFocus"/, "开柜确认必须限制键盘焦点在弹窗内");
assert.match(deviceDetailSource, /@keydown\.esc\.stop\.prevent="finishOpenConfirmation\('cancelled'\)"/, "开柜确认必须支持 Escape 安全取消");
assert.match(deviceDetailSource, /:inert="Boolean\(openConfirmation\)"/, "开柜确认显示时必须隔离背景交互");
const performOpenSource = deviceDetailSource.slice(
  deviceDetailSource.indexOf("const performOpen"),
  deviceDetailSource.indexOf("const showOpenBlocked")
);
assert.match(performOpenSource, /findLikelyOpenEvent/, "开柜结果不确定时必须优先查询当前用户事件");
assert.match(performOpenSource, /resultType=open-pending/, "查不到开柜事件时必须进入待确认结果页");
assert.doesNotMatch(performOpenSource, /isOpenQuoteRefreshRequired|requote/, "预约取货开柜不得走支付报价重新预览链路");
assert.doesNotMatch(performOpenSource, /actionText=\$\{encodeURIComponent\("重新尝试"\)\}/, "开柜结果不确定时不得诱导立即重试");
const previewConfirmationSource = deviceDetailSource.slice(
  deviceDetailSource.indexOf("const previewAndConfirmOpen"),
  deviceDetailSource.indexOf("const createReservation")
);
assert.doesNotMatch(previewConfirmationSource, /uni\.showModal/, "预结算不得再压缩到居中的原生文本弹窗");
assert.doesNotMatch(previewConfirmationSource, /previewOpenSettlement|openResult === "requote"/, "预约取货确认不得请求支付报价或重报价");
assert.match(deviceDetailSource, /警告：未确认（手动模式/, "手动模式距离未知时必须明确告警但允许继续");

const openingSource = readSource("apps/mobile/src/pages/common/opening.vue");
assert.match(openingSource, /resultType=open-stopped/, "开门终止状态必须使用不会诱导重试的结果类型");
assert.match(openingSource, /页面会继续自动查询/, "开门状态暂时无法同步时必须留在轮询页继续确认");
assert.doesNotMatch(openingSource, /请稍后重试/, "开门轮询页不得诱导用户立即重复开柜");

const resultSource = readSource("apps/mobile/src/pages/common/result.vue");
assert.match(resultSource, /resultType\.value === "open-pending"/, "结果页必须提供开门待确认状态");
assert.match(resultSource, /不要重复发起开柜/, "开门待确认结果必须明确阻止重复开柜");

const adminDeviceSource = readSource("apps/admin-web/src/pages/DeviceDetailPage.vue");
const adminAppSource = readSource("apps/admin-web/src/App.vue");
const adminCopySource = readSource("apps/admin-web/src/constants/copy.ts");
const adminLoginSource = readSource("apps/admin-web/src/pages/AdminLoginPage.vue");
const adminSystemSettingsPageSource = readSource("apps/admin-web/src/pages/SystemSettingsPage.vue");
const publicGuideSource = readSource("apps/admin-web/src/pages/PublicGuidePage.vue");
const roleGuideSource = readSource("apps/admin-web/src/pages/RoleGuidePage.vue");
const roleManualSource = readSource("apps/admin-web/src/utils/role-manual.ts");
const userManualSource = readSource("docs/公益智助柜用户使用手册.md");
const instanceAdminManualSource = readSource("docs/用户手册/实例管理员使用手册.md");
const merchantManualSource = readSource("docs/用户手册/商户使用手册.md");
const restockerManualSource = readSource("docs/用户手册/补货员使用手册.md");
const appUserManualSource = readSource("docs/用户手册/App用户使用手册.md");
const adminUsersSource = readSource("apps/admin-web/src/pages/UsersPage.vue");
const adminApiSource = readSource("apps/admin-web/src/api/admin.ts");
const adminRouterSource = readSource("apps/admin-web/src/router/index.ts");
const roleBoundaryLayoutSource = readSource("apps/admin-web/src/layouts/AdminLayout.vue");
const adminSessionSource = readSource("apps/admin-web/src/stores/session.ts");
const workspaceServiceLabelSource = readSource(
  "apps/admin-web/src/utils/workspace-service-label.ts"
);
const platformOverviewSource = readSource(
  "apps/admin-web/src/pages/PlatformOverviewPage.vue"
);
const adminOperationsSource = readSource("apps/admin-web/src/pages/OperationsPage.vue");
const deviceWorkspaceSource = readSource("apps/admin-web/src/pages/DeviceWorkspacePage.vue");
const assignedDeviceDetailPageSource = readSource("apps/admin-web/src/pages/AssignedDeviceDetailPage.vue");
const merchantBackofficeSource = readSource("apps/admin-web/src/pages/MerchantBackofficePage.vue");
const systemSettingsPageSource = readSource("apps/admin-web/src/pages/SystemSettingsPage.vue");
const publicConfigControllerSource = readSource("apps/api/src/app.controller.ts");
const sharedTypesSource = readSource("packages/shared-types/src/index.ts");
const adminPublicConfigSource = readSource("apps/admin-web/src/utils/public-config.ts");
const mobilePublicConfigSource = readSource("apps/mobile/src/api/runtime-config.ts");
assert.match(
  sharedTypesSource,
  /export type VerificationProvider = "mock" \| "manual" \| "aliyun_pnvs"/,
  "共享公开配置必须使用封闭的验证码提供方枚举"
);
assert.match(
  sharedTypesSource,
  /verificationProvider\?: VerificationProvider;[\s\S]{0,80}verificationPreviewEnabled\?: boolean;/,
  "共享公开配置必须声明验证码提供方和预览状态"
);
assert.match(
  adminPublicConfigSource,
  /AdminPublicConfig = PublicRuntimeConfig/,
  "后台必须复用共享公开配置类型"
);
assert.match(
  mobilePublicConfigSource,
  /MobilePublicConfig = PublicRuntimeConfig/,
  "移动端必须复用共享公开配置类型"
);
const publicConfigMethodSource = publicConfigControllerSource.slice(
  publicConfigControllerSource.indexOf("publicConfig()"),
  publicConfigControllerSource.lastIndexOf("\n  }")
);
assert.match(
  publicConfigMethodSource,
  /verificationProvider: verificationRuntimeConfig\.provider/,
  "公开配置必须暴露非敏感的验证码提供方状态"
);
assert.match(
  publicConfigMethodSource,
  /verificationPreviewEnabled: verificationRuntimeConfig\.previewEnabled/,
  "公开配置必须暴露非敏感的验证码预览状态"
);
assert.doesNotMatch(
  publicConfigMethodSource,
  /ALIYUN_PNVS_(?:ACCESS_KEY|SIGN_NAME|TEMPLATE_CODE|SCHEME_NAME)|VERIFICATION_CODE_MANUAL_VALUE/,
  "公开配置不得读取或返回验证码凭据、方案、签名、模板或人工码"
);
assert.doesNotMatch(
  adminAppSource,
  /runtimeDataPlane|loadPublicRuntimeConfig/,
  "管理后台根组件不得再用全局运行数据平面给账号身份贴标签"
);
assert.match(
  roleBoundaryLayoutSource,
  /resolveWorkspaceServiceLabel\(\{[\s\S]{0,160}scope: sessionStore\.user\?\.scope,[\s\S]{0,160}tenantServiceMode: sessionStore\.user\?\.tenantServiceMode/,
  "后台工作区服务标签必须由服务端会话作用域和实例服务类型决定"
);
assert.match(
  workspaceServiceLabelSource,
  /input\.scope === "provider"[\s\S]{0,100}return "正式服务商平台"/,
  "服务商平台身份必须始终显示为正式服务商平台"
);
assert.match(
  platformOverviewSource,
  /<option value="production">正式服务<\/option>[\s\S]{0,100}<option value="simulation">模拟服务<\/option>/,
  "服务商创建实例时必须可明确选择正式服务或模拟服务"
);
assert.doesNotMatch(
  adminLoginSource,
  /模拟服务|服务状态待确认|runtimeStatusLabel/,
  "后台登录页不得展示运行平面自述"
);
assert.match(
  adminLoginSource,
  /grid-template-columns: minmax\(0, 1fr\)/,
  "后台登录页必须固定可收缩的单列网格，避免窄屏按内容撑宽"
);
assert.match(
  adminLoginSource,
  /width: min\(420px, calc\(100vw - var\(--login-shell-gutter\)\)\)/,
  "后台登录卡必须在窄屏按视口扣除边距后收缩"
);
assert.match(
  adminLoginSource,
  /--login-shell-gutter: 36px/,
  "后台登录页在手机宽度必须保留左右安全边距"
);
assert.match(
  adminLoginSource,
  /:type="showPassword \? 'text' : 'password'"/,
  "后台登录页必须允许用户核对浏览器实际填入的密码"
);
assert.match(
  adminLoginSource,
  /清空浏览器自动填充/,
  "后台登录失败时必须提示清除旧的浏览器自动填充"
);
assert.doesNotMatch(adminCopySource, /验收模拟实例/, "管理后台不得向用户展示验收自述");
const roleSpecificManualSources = [
  instanceAdminManualSource,
  merchantManualSource,
  restockerManualSource,
  appUserManualSource
];
for (const userGuideSource of [publicGuideSource, userManualSource, ...roleSpecificManualSources]) {
  assert.doesNotMatch(
    userGuideSource,
    /服务提供商|服务商|数据平面|生产门禁|平台初始化/,
    "面向实例用户的操作说明不得出现平台身份或内部部署概念"
  );
}
for (const source of [publicGuideSource, roleGuideSource, roleManualSource, ...roleSpecificManualSources]) {
  assert.doesNotMatch(source, /设计自述|验收步骤|验收结果/, "用户帮助内容不得出现设计或验收自述");
}
assert.match(
  publicGuideSource,
  /详细操作手册会在登录后按当前账号身份显示/,
  "登录前向导必须说明详细手册在登录后可见"
);
assert.doesNotMatch(
  publicGuideSource,
  /GuideAudienceId|role="tablist"|签发 App 登录验证码|管理货品、库存和柜机/,
  "登录前向导不得包含分角色详细操作手册"
);
assert.match(
  publicGuideSource,
  /\.login-guide \{[\s\S]{0,100}box-sizing: border-box;[\s\S]{0,100}width: 100%;[\s\S]{0,100}max-width: 960px;/,
  "登录前向导必须使用视口内盒模型，避免手机宽度出现横向裁切"
);
assert.match(
  roleManualSource,
  /if \(role === "super_admin"\) \{[\s\S]{0,80}return roleManualOrder;/,
  "只有服务商角色可以取得全部角色手册"
);
for (const [role, expectedManual] of [
  ["admin", "admin"],
  ["merchant", "merchant"],
  ["restocker", "restocker"]
]) {
  assert.match(
    roleManualSource,
    new RegExp(role + ': "' + expectedManual + '"'),
    role + " 角色必须只映射到自己的手册"
  );
}
assert.match(roleGuideSource, /v-if="showRoleTabs"/, "多角色页签只能在服务商可见集合中显示");
assert.match(
  adminRouterSource,
  /path: "\/manual"[\s\S]{0,420}backofficeRoles: \["super_admin", "admin", "merchant", "restocker"\]/,
  "登录后手册路由必须允许所有后台角色进入"
);
assert.doesNotMatch(
  adminRouterSource,
  /to\.path === "\/manual"/,
  "登录后手册不得加入公开路由白名单"
);
for (const [manualSource, screenshotName] of [
  [instanceAdminManualSource, "backoffice-login-public-1280x720-20260729.png"],
  [instanceAdminManualSource, "backoffice-instance-settings-live-1440x900-20260730.jpg"],
  [merchantManualSource, "backoffice-login-public-1280x720-20260729.png"],
  [restockerManualSource, "backoffice-login-public-1280x720-20260729.png"],
  [appUserManualSource, "app-public-login-390x844-20260729.png"],
  [appUserManualSource, "app-public-manual-login-390x844-20260729.png"]
]) {
  assert.ok(
    manualSource.includes("../assets/" + screenshotName),
    "分角色手册必须引用截图 " + screenshotName
  );
  assert.ok(
    existsSync(resolve(process.cwd(), "docs", "assets", screenshotName)),
    "分角色手册截图必须存在：" + screenshotName
  );
}
assert.match(
  systemSettingsPageSource,
  /<RouterLink class="admin-button admin-button--ghost settings-page__guide-link" to="\/manual">查看操作手册<\/RouterLink>/,
  "系统设置页必须进入登录后身份手册"
);
assert.match(
  systemSettingsPageSource,
  /getSystemSettingOperatorDescription\(entry\)/,
  "系统设置页必须显示短操作提示"
);
assert.doesNotMatch(
  systemSettingsPageSource,
  /\{\{\s*entry\.description\s*\}\}/,
  "系统设置页不得直接展示部署配置原始说明"
);
assert.match(
  adminRouterSource,
  /path: "\/merchant"[\s\S]{0,420}backofficeRoles: \["merchant"\]/,
  "商家工作台路由必须同时限制商家角色"
);
const routeBlock = (path) => {
  const start = adminRouterSource.indexOf(`path: "${path}"`);
  const end = adminRouterSource.indexOf("\n        {", start + 1);
  return start >= 0 ? adminRouterSource.slice(start, end >= 0 ? end : undefined) : "";
};
const navBlock = (path) => {
  const start = roleBoundaryLayoutSource.indexOf(`to: "${path}"`);
  const end = roleBoundaryLayoutSource.indexOf("\n      {", start + 1);
  return start >= 0 ? roleBoundaryLayoutSource.slice(start, end >= 0 ? end : undefined) : "";
};
for (const path of [
  "/dashboard",
  "/goods",
  "/goods/:goodsId",
  "/data-monitor",
  "/warehouse",
  "/ai",
  "/settings",
  "/users",
  "/users/:userId",
  "/logs",
  "/logs/:logId"
]) {
  assert.match(
    routeBlock(path),
    /backofficeRoles: \["super_admin", "admin"\]/,
    `${path} 是管理员业务域，路由必须在请求 API 前限制后台角色`
  );
}
assert.match(
  routeBlock("/platform"),
  /backofficeRoles: \["super_admin"\]/,
  "/platform 是服务商业务域，路由必须限制超级管理员角色"
);
for (const path of [
  "/dashboard",
  "/goods",
  "/data-monitor",
  "/warehouse",
  "/ai",
  "/settings",
  "/users",
  "/logs"
]) {
  assert.match(
    navBlock(path),
    /roles: \["super_admin", "admin"\]/,
    `${path} 菜单必须只向管理员角色显示`
  );
}
assert.match(
  navBlock("/platform"),
  /roles: \["super_admin"\]/,
  "/platform 菜单必须只向超级管理员角色显示"
);
assert.match(
  roleBoundaryLayoutSource,
  /const canViewDataMonitor = computed\(\(\) =>[\s\S]{0,180}hasBackofficeRouteRole\(sessionStore\.user\?\.backofficeRole, \["super_admin", "admin"\]\)/,
  "顶部数据监控入口必须同时限制管理员角色"
);
assert.match(
  roleBoundaryLayoutSource,
  /v-if="canViewDataMonitor"[\s\S]{0,80}to="\/data-monitor"/,
  "顶部数据监控直链必须复用角色受限的可见条件"
);
for (const path of ["/goods", "/warehouse", "/logs"]) {
  const defaultRouteStart = adminSessionSource.indexOf(`path: "${path}"`);
  const defaultRouteEnd = adminSessionSource.indexOf("\n", defaultRouteStart);
  const defaultRoute = defaultRouteStart >= 0
    ? adminSessionSource.slice(defaultRouteStart, defaultRouteEnd >= 0 ? defaultRouteEnd : undefined)
    : "";
  assert.doesNotMatch(
    defaultRoute,
    /merchant|restocker/,
    `${path} 不得作为商户或补货员的默认落点`
  );
}
assert.match(
  routeBlock("/operations/:deviceCode"),
  /component: DeviceWorkspacePage/,
  "柜机详情必须按后台角色分流，不能把管理员监控页直接给商户或补货员"
);
assert.match(
  routeBlock("/operations/:deviceCode"),
  /description: "按当前账号权限查看柜机状态与库存；仅管理员可执行管理和远程操作。"/,
  "柜机详情说明必须与商户和补货员的受限能力一致"
);
assert.doesNotMatch(
  routeBlock("/operations/:deviceCode"),
  /事件、日志并执行刷新或远程开门/,
  "柜机详情说明不得向商户或补货员承诺不可用的管理员操作"
);
assert.match(
  adminApiSource,
  /assignedDeviceDetail\(deviceCode: string\)[\s\S]{0,180}`\/devices\/\$\{deviceCode\}`/,
  "商户和补货员柜机详情必须使用服务端已校验分配关系的只读接口"
);
assert.match(
  adminOperationsSource,
  /v-if="canViewDeviceLogs" class="admin-link" :to="`\/logs\?subjectType=device&subjectId=\$\{device\.deviceCode\}`"/,
  "柜机列表不得向无日志访问权的角色展示日志入口"
);
assert.match(
  adminOperationsSource,
  /const canManageDevices = computed\(\(\) =>[\s\S]{0,180}hasBackofficeRouteRole\(sessionStore\.user\?\.backofficeRole, \["super_admin", "admin"\]\)/,
  "柜机新增、编辑和删除必须同时要求管理员角色，不能只依赖可误授的权限"
);
assert.match(
  deviceWorkspaceSource,
  /<AssignedDeviceDetailPage v-if="usesAssignedDeviceWorkspace" \/>/,
  "商户和补货员进入柜机详情时必须改用受限工作台"
);
assert.match(
  assignedDeviceDetailPageSource,
  /adminApi\.assignedDeviceDetail\(String\(route\.params\.deviceCode\)\)/,
  "受限柜机工作台必须请求已分配柜机详情接口"
);
assert.doesNotMatch(
  assignedDeviceDetailPageSource,
  /adminApi\.(?:deviceDetail|refreshDevice|remoteOpenDevice|goodsCatalog|deviceCallbackLogs|systemAuditLogs)/,
  "受限柜机工作台不得触发管理员监控、远程操作或审计接口"
);
assert.doesNotMatch(
  merchantBackofficeSource,
  /adminApi\.alerts\(\)/,
  "商家工作台不得请求未按商家数据边界过滤的全局告警"
);
assert.match(
  merchantBackofficeSource,
  /任务由实例管理员统一处理/,
  "商家工作台必须明确实例任务的处理边界"
);
assert.match(
  merchantBackofficeSource,
  /暂无可用模板/,
  "商家工作台必须在没有补货模板时提供明确空态"
);
assert.match(
  merchantBackofficeSource,
  /class="admin-grid admin-grid--stats-4"/,
  "商家工作台统计卡必须使用已有响应式四列网格"
);
assert.doesNotMatch(
  merchantBackofficeSource,
  /admin-grid--four/,
  "商家工作台不得引用不存在的统计网格样式"
);
assert.match(
  adminSystemSettingsPageSource,
  /settingsVisibleForInstanceAdministration/,
  "实例管理员设置页只展示日常领取、登录和运行环境设置"
);
assert.doesNotMatch(
  adminSystemSettingsPageSource,
  /示例：\{\{ entry\.exampleValue \}\}/,
  "用户可见设置页不得回显底层示例值"
);
assert.match(adminApiSource, /batchRemoveUsers/, "人员后台必须提供批量删除 API 调用");
assert.match(adminUsersSource, /const removeSelectedUsers = async/, "人员后台必须提供批量删除操作");
assert.match(
  adminCopySource,
  /第一次确认：将从当前人员台账中删除 \$\{count\} 人/,
  "批量删除第一次确认必须显示准确人数"
);
assert.match(
  adminCopySource,
  /第二次确认：确定删除这 \$\{count\} 人/,
  "批量删除第二次确认必须再次显示准确人数"
);
assert.match(
  adminUsersSource,
  /adminCopy\.users\.batchRemoveFirstConfirmation\(count\)[\s\S]{0,180}adminCopy\.users\.batchRemoveSecondConfirmation\(count\)/,
  "人员后台必须按顺序使用两次集中维护的确认文案"
);
assert.match(
  adminUsersSource,
  /confirmedCount:\s*count/,
  "批量删除请求必须把已确认人数交给服务端复核"
);
assert.match(
  roleBoundaryLayoutSource,
  /role="status"[\s\S]{0,100}\{\{\s*workspaceServiceLabel\s*\}\}/,
  "当前工作区的服务身份必须向辅助技术声明"
);
const amapLoaderSource = readSource("apps/admin-web/src/utils/amap-loader.ts");
const amapPickerSource = readSource("apps/admin-web/src/components/AmapLocationPicker.vue");
assert.equal(
  existsSync(resolve(process.cwd(), "apps/admin-web/public/__acceptance/map/index.html")),
  false,
  "公开站点不得继续保留地图验收静态页面"
);
assert.equal(
  existsSync(resolve(process.cwd(), "apps/admin-web/src/pages/MapAcceptancePage.vue")),
  false,
  "公开地图验收页面必须从生产前端移除"
);
assert.doesNotMatch(adminRouterSource, /__acceptance\/map/, "地图验收路径不得继续出现在生产路由中");
assert.doesNotMatch(adminRouterSource, /publicAcceptance/, "生产路由不得保留公开验收放行标记");
assert.match(amapPickerSource, /props\.confirmLabel\?\.trim\(\) \|\| "保存位置"/, "业务地图组件默认按钮文案必须保持保存位置");
assert.match(amapPickerSource, /\{\{ resolvedConfirmLabel \}\}/, "业务地图组件必须使用可选确认按钮文案");
assert.match(
  adminCopySource,
  /请联系服务管理员完成地图服务设置/,
  "地图未启用时必须给出可理解的处理方式"
);
assert.doesNotMatch(
  adminCopySource,
  /VM_FULL_SIMULATION_MAP_MODE|AMAP_WEB_KEY|AMAP_SECURITY_JS_CODE/,
  "用户可见地图提示不得泄露部署变量名"
);
assert.match(
  amapLoaderSource,
  /querySelector<HTMLScriptElement>[\s\S]+\.remove\(\)/,
  "地图脚本加载失败后的重试必须先移除残留脚本"
);
assert.match(
  amapLoaderSource,
  /const rejectScriptLoad[\s\S]+script\.remove\(\)/,
  "地图脚本加载失败时必须清理失败节点"
);
assert.match(
  amapPickerSource,
  /:role="searchFeedbackTone === 'danger' \? 'alert' : 'status'"/,
  "地点搜索错误必须使用可访问的告警语义"
);
assert.match(
  amapPickerSource,
  /:aria-live="searchFeedbackTone === 'danger' \? 'assertive' : 'polite'"/,
  "地点搜索结果必须按严重程度播报"
);
const remoteOpenSource = adminDeviceSource.slice(
  adminDeviceSource.indexOf("const remoteOpen"),
  adminDeviceSource.indexOf("const notifyPaymentSuccess")
);
assert.doesNotMatch(remoteOpenSource, /window\.(prompt|confirm)/, "远程开门不应依赖无法稳定审查的浏览器原生弹窗");
const reasonStepIndex = remoteOpenSource.indexOf('remoteOpenDialogStep.value = "reason"');
const confirmStepIndex = remoteOpenSource.indexOf('remoteOpenDialogStep.value = "confirm"');
const requestIndex = remoteOpenSource.indexOf("adminApi.remoteOpenDevice");
assert.ok(reasonStepIndex >= 0 && confirmStepIndex > reasonStepIndex && requestIndex > confirmStepIndex, "远程开门必须先填原因、再进入复核步骤，最后才请求 API");
assert.match(adminDeviceSource, /role="dialog"/, "远程开门复核必须使用可识别的对话框语义");
assert.match(adminDeviceSource, /<dialog[\s\S]+remote-open-dialog/, "远程开门必须使用原生模态对话框隔离背景内容");
assert.match(remoteOpenSource, /\.showModal\(\)/, "远程开门必须以模态方式打开对话框");
assert.match(adminDeviceSource, /@cancel\.prevent="closeRemoteOpenDialog"/, "远程开门必须接管原生 Escape 取消事件");
assert.doesNotMatch(adminDeviceSource, /@keydown\.tab="trapRemoteOpenFocus"/, "远程开门不应再依赖不完整的手写 Tab 焦点环");
assert.doesNotMatch(adminDeviceSource, /remoteOpenConfirmButton/, "危险最终确认按钮不得成为步骤切换后的默认焦点");
const remoteOpenCompletionSource = adminDeviceSource.slice(
  adminDeviceSource.indexOf("const confirmRemoteOpen"),
  adminDeviceSource.indexOf("const notifyPaymentSuccess")
);
assert.ok(
  remoteOpenCompletionSource.indexOf("remoteOpening.value = false") >= 0 &&
    remoteOpenCompletionSource.indexOf("remoteOpening.value = false") < remoteOpenCompletionSource.indexOf("await resetRemoteOpenDialog()"),
  "远程开门结束后必须先解除按钮禁用状态，再恢复触发按钮焦点"
);
assert.match(adminDeviceSource, /max-height:\s*calc\(100dvh - 48px\)/, "远程开门对话框必须适应低高度和页面缩放");
assert.match(adminDeviceSource, /确认并立即下发/, "远程开门最终按钮必须明确表达立即后果");
assert.match(remoteOpenSource, /remoteOpenDevice\([^\n]+reason\)/, "远程开门原因必须传给服务端审计");
assert.match(remoteOpenSource, /device\.status === "offline"/, "离线柜机必须阻止远程开门");
assert.match(remoteOpenSource, /doorState === "open"/, "门已开启时必须阻止重复下发开门指令");
assert.match(remoteOpenSource, /doorState !== "closed"/, "门状态未知时必须保持关闭式阻断");

const mobileAdminDeviceSource = readSource("apps/mobile/src/pages/admin/device-detail.vue");
assert.match(
  mobileAdminDeviceSource,
  /runtime\.doorState !== "closed"/,
  "移动管理端也必须在门状态未知时禁用运营开门"
);

const financialActionSource = adminDeviceSource.slice(
  adminDeviceSource.indexOf("const openFinancialDialog"),
  adminDeviceSource.indexOf("const resolveTask")
);
const financialValidationSource = adminDeviceSource.slice(
  adminDeviceSource.indexOf("const financialInputError"),
  adminDeviceSource.indexOf("const selectedDoorGoods")
);
const financialSafetySource = readSource("apps/admin-web/src/utils/financial-action-safety.ts");
const adminPaymentApiSource = readSource("apps/admin-web/src/api/admin.ts");
assert.doesNotMatch(financialActionSource, /window\.(prompt|confirm)/, "付款回写和退款不应依赖浏览器 prompt/confirm");
assert.match(financialActionSource, /financialAction\.value\.step = "confirm"/, "付款回写和退款必须先填写再进入最终核对步骤");
assert.match(financialValidationSource, /Number\.isSafeInteger\(amount\)/, "付款回写和退款金额必须限制为安全整数");
assert.match(financialValidationSource, /amount !== draft\.expectedAmount/, "付款回写金额必须与服务端订单金额一致");
assert.match(
  financialValidationSource,
  /validateLegacyFullRefundAmount\(\s*amount,\s*draft\.expectedAmount\s*\)/,
  "旧退款入口必须委托全额退款校验"
);
assert.match(financialSafetySource, /amount === expectedAmount/, "旧退款入口只允许与订单金额完全一致的全额退款");
assert.match(financialActionSource, /currentContext\.amount === draft\.expectedAmount/, "最终提交前必须复核最新订单金额未变化");
assert.ok(
  financialActionSource.indexOf("draft.step !== \"confirm\"") >= 0 &&
    financialActionSource.indexOf("draft.step !== \"confirm\"") < financialActionSource.indexOf("adminApi.notifyPaymentSuccess"),
  "付款回写必须完成最终核对后才允许请求 API"
);
assert.match(adminDeviceSource, /class="remote-open-dialog financial-action-dialog/, "付款回写和退款必须使用项目内原生模态对话框");
assert.match(adminDeviceSource, /@cancel\.prevent="closeFinancialDialog"/, "付款回写和退款必须支持 Escape 安全取消");
for (const requiredSummary of ["订单号", "事件 / 柜机", "交易号", "操作请求编号", "金额"]) {
  assert.ok(adminDeviceSource.includes(requiredSummary), `付款回写和退款最终核对必须展示${requiredSummary}`);
}
for (const refundCopy of [
  "退款申请",
  "最后核对退款信息",
  "此步骤只校验退款信息，不会发起退款请求。",
  "这是实际退款动作。",
  "关闭退款对话框"
]) {
  assert.ok(adminDeviceSource.includes(refundCopy), `退款流程必须使用准确退款文案：${refundCopy}`);
}
for (const misleadingCopy of ["支付高风险操作", "最后核对支付处理信息", "这是实际支付处理动作"]) {
  assert.ok(!adminDeviceSource.includes(misleadingCopy), `退款流程不得继续复用笼统支付文案：${misleadingCopy}`);
}
assert.match(
  adminPaymentApiSource,
  /\/payments\/refunds\/\$\{encodeURIComponent\(id\)\}\/reconcile/,
  "后台退款结果待确认时必须提供受权限保护的主动核对 API"
);
assert.match(
  financialActionSource,
  /adminApi\.reconcileRefund/,
  "后台退款结果待确认时必须允许复用原退款单主动核对"
);
assert.match(
  adminDeviceSource,
  /向支付渠道核对退款状态/,
  "退款结果待确认界面必须提供准确的主动核对入口"
);
assert.match(
  adminDeviceSource,
  /不会新建退款单/,
  "主动核对入口必须明确不会创建新的退款意图"
);
assert.match(
  financialActionSource,
  /const pendingRefund =[\s\S]{0,180}platformContext\.pendingRefund/,
  "刷新后必须从服务端恢复待确认退款摘要"
);
assert.match(
  financialActionSource,
  /refundRecordId:\s*pendingRefund\?\.id/,
  "刷新后恢复退款时必须继续绑定原本地退款单"
);
assert.match(
  adminDeviceSource,
  /findPersistedPendingRefund\(event\.orderNo\)\s*\?\s*"核对退款状态"/,
  "原始订单存在服务端待确认退款时，列表必须提供可点击的核对入口"
);
assert.match(
  adminDeviceSource,
  /isFinancialOutcomePending\('refund', event\.orderNo\)\s*&&\s*!findPersistedPendingRefund\(event\.orderNo\)/,
  "只有无法恢复原退款单的未知结果才应禁用重复退款入口"
);

const warehouseSource = readSource("apps/admin-web/src/pages/WarehousePage.vue");
const warehouseTransferSource = warehouseSource.slice(
  warehouseSource.indexOf("const submitTransfer"),
  warehouseSource.indexOf("const submitStocktake")
);
assert.doesNotMatch(warehouseTransferSource, /window\.confirm/, "仓储调拨不应依赖无法稳定审查的浏览器原生弹窗");
assert.ok(
  warehouseTransferSource.indexOf("requestConfirmation") >= 0 &&
    warehouseTransferSource.indexOf("requestConfirmation") < warehouseTransferSource.indexOf("adminApi.createInventoryTransfer"),
  "仓储调拨必须先展示项目内确认明细"
);

const goodsOverviewSource = readSource("apps/admin-web/src/pages/GoodsOverviewPage.vue");
assert.match(
  goodsOverviewSource,
  /v-if="message"[\s\S]{0,320}:role="message\.type === 'error' \? 'alert' : 'status'"[\s\S]{0,180}:aria-live="message\.type === 'error' \? 'assertive' : 'polite'"[\s\S]{0,80}aria-atomic="true"/,
  "货品总览异步结果必须按成功或失败向辅助技术播报"
);
const goodsTransferSource = goodsOverviewSource.slice(
  goodsOverviewSource.indexOf("const submitTransfer"),
  goodsOverviewSource.indexOf("const toggleAlertBucket")
);
assert.doesNotMatch(goodsTransferSource, /window\.confirm/, "货品总览调拨不应依赖浏览器 confirm 弹窗");
assert.ok(
  goodsTransferSource.indexOf("requestTransferConfirmation") >= 0 &&
    goodsTransferSource.indexOf("requestTransferConfirmation") < goodsTransferSource.indexOf("adminApi.createInventoryTransfer"),
  "货品总览调拨必须先展示项目内二步核对"
);
assert.match(goodsTransferSource, /!selectedBatch\.value/, "货品总览调拨提交前必须确认来源批次仍可用");
assert.match(goodsTransferSource, /transferForm\.fromCode === transferForm\.toCode/, "货品总览调拨必须拒绝相同来源和目标");
assert.match(goodsTransferSource, /Number\.isSafeInteger\(transferForm\.quantity\)/, "货品总览调拨数量必须是安全整数");
assert.match(
  goodsTransferSource,
  /transferForm\.quantity > selectedBatch\.value\.remainingQuantity/,
  "货品总览调拨数量不得超过所选批次可用量"
);
assert.match(goodsOverviewSource, /<dialog[\s\S]+goods-transfer-confirm/, "货品总览调拨必须使用原生 dialog");
assert.match(goodsOverviewSource, /role="dialog"/, "货品总览调拨核对必须暴露对话框语义");
assert.match(goodsOverviewSource, /:aria-label="`选择模板 \$\{item\.name\}`"/, "模板行选择框必须使用模板名称生成可访问名称");
assert.match(goodsOverviewSource, /\.showModal\(\)/, "货品总览调拨核对必须以模态方式打开");
assert.match(goodsOverviewSource, /@cancel\.prevent="answerTransferConfirmation\(false\)"/, "货品总览调拨必须支持 Escape 安全取消");

const stocktakeSource = warehouseSource.slice(
  warehouseSource.indexOf("const submitStocktake"),
  warehouseSource.indexOf("const exportStocktake", warehouseSource.indexOf("const submitStocktake") + "const submitStocktake".length)
);
assert.ok(
  stocktakeSource.indexOf("requestConfirmation") >= 0 &&
    stocktakeSource.indexOf("requestConfirmation") < stocktakeSource.indexOf("adminApi.createStocktake"),
  "盘点提交必须先展示项目内确认明细"
);
assert.doesNotMatch(stocktakeSource, /window\.confirm/, "盘点提交不应依赖无法稳定审查的浏览器原生弹窗");
assert.match(warehouseSource, /role="dialog"/, "仓储确认必须使用可识别的对话框语义");
assert.match(warehouseSource, /<dialog[\s\S]+warehouse-confirm/, "仓储确认必须使用原生模态对话框隔离背景内容");
assert.match(warehouseSource, /\.showModal\(\)/, "仓储确认必须以模态方式打开对话框");
assert.match(warehouseSource, /@cancel\.prevent="answerConfirmation\(false\)"/, "仓储确认必须支持 Escape 安全取消");
assert.doesNotMatch(warehouseSource, /@keydown\.tab="trapConfirmationFocus"/, "仓储确认不应再依赖不完整的手写 Tab 焦点环");
assert.match(warehouseSource, /role="status"[\s\S]+aria-live="polite"[\s\S]+aria-atomic="true"/, "仓储操作结果必须向辅助技术播报");
assert.match(warehouseSource, /max-height:\s*calc\(100dvh - 48px\)/, "仓储确认对话框必须适应低高度和页面缩放");
for (const [name, source] of [
  ["仓储调拨", warehouseTransferSource],
  ["仓储盘点", stocktakeSource]
]) {
  assert.ok(
    source.indexOf("saving.value = false") >= 0 &&
      source.indexOf("saving.value = false") < source.indexOf("restoreConfirmationFocus"),
    `${name}结束后必须先解除按钮禁用状态，再恢复触发按钮焦点`
  );
}
assert.match(warehouseSource, /确认并立即提交盘点/, "盘点最终按钮必须明确表达立即后果");
assert.match(
  warehouseSource,
  /:aria-label="`\$\{item\.goodsName\}实盘数量`"/,
  "每个盘点数量输入必须使用货品名称生成独立的程序化标签"
);
assert.match(warehouseSource, /type="number"[\s\S]{0,80}min="0"[\s\S]{0,80}step="1"/, "盘点数量输入必须限定为非负整数");
assert.match(warehouseSource, /snapshot\.value\?\.expiredBatches/, "仓储管理必须直接使用服务端过期待处置批次集合");
assert.match(warehouseSource, /已过期 · 不可调拨/, "仓储管理必须明确标记已过期批次不可调拨");
assert.match(warehouseTransferSource, /批次到期/, "仓储调拨最终确认必须展示批次到期日");
assert.ok(
  warehouseTransferSource.indexOf("selectedBatch") >= 0 &&
    warehouseTransferSource.indexOf("selectedBatch") < warehouseTransferSource.indexOf("adminApi.createInventoryTransfer"),
  "仓储调拨必须在提交前绑定可用批次"
);

const nativeInputAccessibilitySource = readSource("apps/mobile/src/utils/native-input-accessibility.ts");
const appLoginSource = readSource("apps/mobile/src/pages/common/app-login.vue");
const mobileAuthFlowSource = readSource("apps/mobile/src/composables/useAuthFlow.ts");
const mobileRegisterSource = readSource("apps/mobile/src/pages/common/register.vue");
const publicWebServerSource = readSource("scripts/serve-public-web.mjs");
const rootPackageJson = JSON.parse(readSource("package.json"));
const mobileViteConfigSource = readSource("apps/mobile/vite.config.ts");
const mobileH5PublicBaseSource = readSource("apps/mobile/src/config/h5-public-base.ts");
const mobileH5DeploymentBuildSource = readSource("apps/mobile/scripts/build-h5-deployment.mjs");
const mobileProductionEnvSource = readSource("apps/mobile/.env.production");
const merchantRestockSource = readSource("apps/mobile/src/pages/merchant/restock.vue");
assert.match(
  mobileViteConfigSource,
  /process\.env\.UNI_PLATFORM === "h5"[\s\S]{0,120}resolveMobileH5PublicBase\(process\.env\.VITE_MOBILE_H5_PUBLIC_BASE\)/,
  "移动 H5 只有在 H5 构建时才能应用显式发布基路径"
);
assert.match(
  mobileH5PublicBaseSource,
  /const defaultMobileH5PublicBase = "\/"/,
  "移动 H5 未配置发布基路径时必须继续使用根路径"
);
assert.match(
  mobileH5DeploymentBuildSource,
  /VITE_MOBILE_H5_PUBLIC_BASE:\s*"\/mobile\/"/,
  "移动 H5 公网部署构建必须显式固定 /mobile/ 基路径"
);
assert.match(
  mobileH5DeploymentBuildSource,
  /VITE_SHOW_VERIFICATION_PREVIEW:\s*"false"/,
  "移动 H5 公网部署构建必须显式关闭验证码预览"
);
assert.match(
  mobileH5DeploymentBuildSource,
  /VITE_API_BASE_URL:\s*"\/api"/,
  "移动 H5 公网部署构建必须使用同源 /api，避免跨域阻断运行配置与登录链路"
);
assert.equal(
  rootPackageJson.scripts["build:public-web"],
  "npm run build --workspace @vm/admin-web && npm run build:h5:deployment --workspace @vm/mobile",
  "公网静态构建必须在后台构建后重新生成 /mobile/ 基路径的移动 H5，避免全量构建覆盖发布产物"
);
for (const [name, source] of [
  ["应用登录", appLoginSource],
  ["注册", mobileRegisterSource],
  ["通用认证流程", mobileAuthFlowSource]
]) {
  assert.match(
    source,
    /import\.meta\.env\.DEV && import\.meta\.env\.VITE_SHOW_VERIFICATION_PREVIEW === "true"/,
    `${name}的验证码预览必须同时受开发模式门禁`
  );
}
assert.doesNotMatch(
  mobileProductionEnvSource,
  /^VITE_SHOW_VERIFICATION_PREVIEW\s*=\s*true\s*$/m,
  "移动端生产配置不得启用验证码预览"
);
assert.match(
  publicWebServerSource,
  /method !== "GET" && method !== "HEAD"/,
  "公网静态服务必须拒绝除 GET 和 HEAD 外的请求"
);
assert.match(
  publicWebServerSource,
  /segment === "\." \|\| segment === "\.\."/,
  "公网静态服务必须拒绝路径穿越片段"
);
assert.match(
  publicWebServerSource,
  /pathname\.startsWith\("\/mobile\/"\)[\s\S]{0,120}404/,
  "移动端命名空间中的未知路径不得回退到后台 SPA"
);
assert.match(
  publicWebServerSource,
  /extname\(filePath\)[\s\S]{0,160}"no-store"/,
  "公网静态服务必须禁止缓存 HTML"
);
assert.match(nativeInputAccessibilitySource, /querySelector\("input"\)/, "uni-app H5 必须将可访问名同步到真正获取焦点的 input");
assert.match(nativeInputAccessibilitySource, /setAttribute\("aria-labelledby", options\.labelId\)/, "H5 原生输入必须关联可见标签");
assert.match(nativeInputAccessibilitySource, /input\.autocomplete = options\.autocomplete/, "H5 原生输入必须接收登录表单的自动填充语义");
for (const [rootId, labelId] of [
  ["app-login-phone", "app-login-phone-label"],
  ["app-login-code", "app-login-code-label"]
]) {
  assert.ok(appLoginSource.includes(`\"${rootId}\"`) && appLoginSource.includes(`\"${labelId}\"`), `登录输入 ${rootId} 必须保留标签关联`);
}
for (const [rootId, labelId] of [
  ["merchant-restock-quantity", "merchant-restock-quantity-label"],
  ["merchant-restock-batch", "merchant-restock-batch-label"],
  ["merchant-restock-note", "merchant-restock-note-label"],
  ["merchant-restock-search", "merchant-restock-search-label"]
]) {
  assert.ok(
    merchantRestockSource.includes(`\"${rootId}\"`) && merchantRestockSource.includes(`\"${labelId}\"`),
    `补货输入 ${rootId} 必须保留标签关联`
  );
}
assert.match(appLoginSource, /role="dialog"/, "免责声明必须暴露对话框语义");
assert.match(appLoginSource, /aria-modal="true"/, "免责声明必须标记为模态内容");
assert.match(appLoginSource, /aria-labelledby="disclaimer-dialog-title"/, "免责声明必须关联可访问标题");
assert.match(appLoginSource, /<checkbox-group[\s\S]+@change="handleDisclaimerAgreementChange"/, "登录页必须使用可直接勾选的免责声明复选框");
assert.match(appLoginSource, /class="disclaimer-agreement"[\s\S]+disclaimer-agreement--invalid/, "未勾选免责声明时必须高亮协议区域");
assert.match(appLoginSource, /role="alert"[\s\S]+aria-live="assertive"[\s\S]+disclaimerValidationMessage/, "免责声明校验失败必须提供可访问文本提示");
assert.doesNotMatch(appLoginSource, /@scrolltolower="markDisclaimerRead"/, "免责声明不得以滚动到底作为同意门槛");
assert.doesNotMatch(appLoginSource, /disclaimerReadToEnd/, "免责声明阅读弹窗不得控制登录复选框状态");
const ensureDisclaimerSource = appLoginSource.slice(
  appLoginSource.indexOf("const ensureDisclaimerAccepted"),
  appLoginSource.indexOf("const resolveDisclaimerElement")
);
assert.doesNotMatch(ensureDisclaimerSource, /openDisclaimer|showModal/, "未勾选时只能高亮提示，不得强制打开弹窗");
assert.match(appLoginSource, /disclaimerPreviousFocus/, "免责声明关闭后必须恢复触发点焦点");

const adminLayoutSource = readSource("apps/admin-web/src/layouts/AdminLayout.vue");
const mobileApiSource = readSource("apps/mobile/src/api/mobile.ts");
const mobileSettingsSource = readSource("apps/mobile/src/pages/tabs/settings.vue");
assert.match(adminApiSource, /post<\{ revoked: boolean \}>\("\/auth\/logout"\)/, "后台必须调用服务端退出接口");
assert.match(
  adminLayoutSource,
  /to: "\/merchant"[\s\S]{0,180}roles: \["merchant"\]/,
  "商家工作台菜单必须同时限制商家角色"
);
assert.match(mobileApiSource, /post<\{ revoked: boolean \}>\("\/auth\/logout"\)/, "移动端必须调用服务端退出接口");
assert.match(adminApiSource, /\{ doorNum, reason \}/, "后台远程开门 API 必须透传原因");
assert.match(mobileApiSource, /\{ doorNum, reason \}/, "移动端远程开门 API 必须透传原因");
for (const [name, source, clearMarker] of [
  ["后台", adminLayoutSource, "sessionStore.clearSession()"],
  ["移动端", mobileSettingsSource, "sessionStore.clear()"]
]) {
  const logoutSource = source.slice(source.indexOf("const logout = async"), source.indexOf("onShow", source.indexOf("const logout = async")));
  assert.ok(logoutSource.indexOf("await") < logoutSource.indexOf(clearMarker), `${name}退出必须先请求撤销再清理本地会话`);
  assert.match(logoutSource, /finally\s*\{/, `${name}退出必须在 finally 中清理本地会话`);
}

const doorClosedSource = readSource("apps/mobile/src/pages/common/door-closed.vue");
assert.match(doorClosedSource, /cabinetEventId:\s*event\.value\.eventId/, "入柜登记必须携带柜门事件编号");
assert.match(doorClosedSource, /hasUnexpectedCharge/, "闭门页必须识别公益领取中的异常金额");
assert.match(doorClosedSource, /appCopy\.freeOnly\.unexpectedCharge/, "异常金额必须显示集中维护的免费领取提示");
assert.match(doorClosedSource, /goFeedback/, "异常金额必须提供反馈入口");
for (const forbiddenPaymentEntry of [
  "createPaymentOrder",
  "mockPaymentPaid",
  "requestPayment",
  "paySettlement"
]) {
  assert.ok(
    !doorClosedSource.includes(forbiddenPaymentEntry),
    `公益领取闭门页不得保留用户支付入口：${forbiddenPaymentEntry}`
  );
}

const nearbySource = readSource("apps/mobile/src/pages/tabs/nearby.vue");
const mobileErrorMessageSource = readSource("apps/mobile/src/utils/error-message.ts");
const recordsSource = readSource("apps/mobile/src/pages/tabs/records.vue");
const primarySource = readSource("apps/mobile/src/pages/tabs/primary.vue");
const mobileReviewsSource = readSource("apps/mobile/src/pages/admin/reviews.vue");
const feedbackSource = readSource("apps/mobile/src/pages/common/feedback.vue");
const seedSource = readSource("packages/shared-types/src/index.ts");
assert.match(recordsSource, /Promise\.allSettled/, "管理员三类记录必须独立接收加载结果");
assert.match(recordsSource, /adminLoadErrors\[adminView\.value\]/, "管理员页签必须使用独立错误态");
assert.match(primarySource, /Promise\.allSettled/, "管理员首页的审批和待办必须独立接收加载结果");
assert.match(primarySource, /adminApplicationsError/, "管理员首页必须显示独立审批错误态");
assert.match(primarySource, /adminAlertsError/, "管理员首页必须显示独立待办错误态");
assert.match(primarySource, /specialHasLoadedData/, "用户主入口必须区分首次同步失败和可参考的历史数据");
assert.match(primarySource, /资格与领取数据未更新/, "用户主入口必须明确展示资格数据同步失败");
assert.match(primarySource, /这不是“无额度”/, "用户主入口不得把同步失败伪装成无额度");
assert.match(primarySource, /:disabled="Boolean\(loadError\) \|\| remainingTotal <= 0" @tap="goScanPickup"/, "资格同步失败或免费额度用尽时扫码开柜入口必须禁用");
assert.match(primarySource, /:disabled="Boolean\(loadError\)" @tap="goNearby"/, "资格同步失败时柜机选择入口必须禁用");
assert.match(primarySource, /let latestLoadRequestId = 0/, "首页加载必须使用递增请求代次");
assert.match(primarySource, /const ownsLatestLoad = \(\) =>[\s\S]{0,240}sessionStore\.token === sessionToken/, "首页异步结果必须同时绑定最新请求、用户和会话");
assert.match(primarySource, /catch \(error\) \{[\s\S]{0,120}if \(!ownsLatestLoad\(\)\) \{[\s\S]{0,40}return;/, "过期失败结果不得覆盖最新成功状态");
assert.match(primarySource, /remainingFreeTotal/, "首页总剩余额度必须优先使用服务端同时受每日上限约束的聚合值");
assert.match(primarySource, /Math\.min\(sessionStore\.quota\?\.remainingDaily/, "旧会话数据也必须用每日总上限约束商品额度求和");
assert.match(primarySource, /已用免费额度/, "首页不得把仅消耗免费额度的统计误写成全部领取数量");
assert.doesNotMatch(primarySource, /按商品价格结算|超出免费额度的部分/, "当前公益领取入口不得保留普通用户付费导向文案");
assert.doesNotMatch(deviceDetailSource, /quoteId:\s*preview\.quoteId/, "预约取货开柜不得携带支付报价标识");
assert.match(mobileReviewsSource, /const loadError = ref\(""\)/, "移动审核工作台必须保留可见加载错误态");
assert.match(mobileReviewsSource, /审核数据加载失败/, "移动审核工作台必须提供失败说明和重试入口");
const mobileReviewsLoadSource = mobileReviewsSource.slice(
  mobileReviewsSource.indexOf("const load = async"),
  mobileReviewsSource.indexOf("const review = async")
);
assert.doesNotMatch(mobileReviewsLoadSource, /uni\.showToast/, "审核列表加载失败不得再用 toast 遮挡重试入口");
assert.match(mobileReviewsSource, /overviewUnavailable/, "审核摘要必须区分加载失败与真实空队列");
assert.match(mobileReviewsSource, /overviewValue\(pendingCount\)/, "审核加载失败时待审数必须显示不可用占位");
assert.match(mobileReviewsSource, /syncNativeInputAccessibility\(rejectReasonRootId\(application\.id\)/, "移动审核驳回原因必须把标签同步到真正获取焦点的 H5 input");
assert.match(mobileReviewsSource, /:aria-labelledby="rejectReasonLabelId\(item\.id\)"/, "移动审核驳回原因必须关联可见标签");
assert.match(mobileErrorMessageSource, /request:fail/i, "移动端必须识别 uni.request 底层错误");
assert.match(mobileErrorMessageSource, /failed to fetch/i, "移动端必须识别 H5 fetch 底层错误");
assert.match(mobileErrorMessageSource, /暂时无法连接服务，请检查网络后重试/, "底层网络错误必须映射为可行动中文提示");
assert.match(adminUsersSource, /:aria-label="`选择人员 \$\{user\.name\}`"/, "人员行选择框必须使用人员名称生成可访问名称");
assert.match(adminUsersSource, /loadRegistrationApplications\(\)/, "电脑端审核数据必须独立加载");
assert.match(adminUsersSource, /registrationApplicationsError/, "电脑端审核数据必须使用独立错误态");
assert.match(
  adminUsersSource,
  /v-if="actionMessage"[\s\S]{0,320}:role="actionMessage\.type === 'error' \? 'alert' : 'status'"[\s\S]{0,180}:aria-live="actionMessage\.type === 'error' \? 'assertive' : 'polite'"[\s\S]{0,80}aria-atomic="true"/,
  "人员操作结果必须按成功或失败向辅助技术播报"
);
assert.match(
  adminUsersSource,
  /v-if="reservationMessage"[\s\S]{0,420}:role="reservationMessage\.type === 'error' \? 'alert' : 'status'"[\s\S]{0,180}:aria-live="reservationMessage\.type === 'error' \? 'assertive' : 'polite'"[\s\S]{0,80}aria-atomic="true"/,
  "预约规则异步结果必须按成功或失败向辅助技术播报"
);
assert.match(
  adminUsersSource,
  /v-if="registrationApplicationsError"[\s\S]{0,160}role="alert"[\s\S]{0,80}aria-live="assertive"[\s\S]{0,80}aria-atomic="true"/,
  "审核数据加载失败必须立即向辅助技术播报"
);
assert.match(feedbackSource, /detail\.length < 5/, "反馈页面必须在提交前校验最小内容长度");
for (const [name, source] of [
  ["附近柜机页面", nearbySource],
  ["种子数据", seedSource]
]) {
  assert.doesNotMatch(source, /a\.amap\.com\/jsapi_demos|dummyimage\.com/, `${name} 不得依赖演示占位资源`);
}
assert.equal(
  [...nearbySource.matchAll(/v-if="hasRealLocation" class="nearby-map-preview__user"/g)].length,
  2,
  "H5 地图仅在取得真实定位后显示用户位置点"
);
assert.equal(
  [...nearbySource.matchAll(/:show-location="hasRealLocation"/g)].length,
  2,
  "小程序地图仅在取得真实定位后显示系统位置点"
);

const dashboardSource = readSource("apps/admin-web/src/pages/DashboardPage.vue");
const adminGlobalStyleSource = readSource("apps/admin-web/src/styles/global.css");
assert.doesNotMatch(dashboardSource, /待办 TOPS/, "后台待办标题不得使用不自然的 TOPS 文案");
assert.match(appLoginSource, />\s*获取验证码\s*<\/button>/, "登录验证码按钮必须说明具体动作");
assert.match(adminGlobalStyleSource, /"brand nav" auto[\s\S]{0,120}"status nav" auto/, "后台窄屏布局必须并排压缩导航，避免主内容被整页导航推离首屏");

const mobileAdminUsersSource = readSource("apps/mobile/src/pages/admin/users.vue");
const mobileAdminLogsSource = readSource("apps/mobile/src/pages/admin/logs.vue");
const mobileLabelsSource = readSource("apps/mobile/src/constants/labels.ts");
assert.match(mobileAdminUsersSource, /\.role-filter,[\s\S]{0,80}\.action-grid[\s\S]{0,100}grid-template-columns: repeat\(2/, "移动人员筛选和批量操作必须使用紧凑双列布局");
assert.match(mobileAdminLogsSource, /\.filter-grid \{[\s\S]{0,100}grid-template-columns: repeat\(4/, "移动日志分类必须使用紧凑多列布局");
assert.match(mobileAdminLogsSource, /\.log-item \{[\s\S]{0,120}width: 100%;[\s\S]{0,80}margin: 0;/, "移动日志卡片必须等宽对齐");
assert.match(mobileLabelsSource, /operationLogStatusLabelMap[\s\S]{0,180}success: "成功"[\s\S]{0,120}warning: "警告"/, "移动日志状态必须使用中文标签");
for (const path of [
  "apps/mobile/src/pages/admin/logs.vue",
  "apps/mobile/src/pages/admin/log-detail.vue",
  "apps/mobile/src/pages/tabs/records.vue"
]) {
  assert.match(readSource(path), /operationLogStatusLabelMap/, `${path} 必须翻译日志状态`);
}

const datetimeSource = readSource("apps/mobile/src/utils/datetime.ts");
assert.match(datetimeSource, /8 \* 60 \* 60 \* 1000/, "移动端日期显示必须显式使用北京时间偏移");
assert.match(datetimeSource, /getUTCFullYear\(\)/, "北京时间格式化必须避开宿主机本地时区漂移");
for (const path of collectSourceFiles("apps/mobile/src")) {
  const source = readSource(path);
  assert.doesNotMatch(source, /\.toISOString\(\)\.slice\(0,\s*10\)/, `${path} 不得用 UTC 日期初始化本地业务日期`);
  assert.doesNotMatch(source, /\.slice\(0,\s*(?:16|19)\)\.replace\(["']T["']/, `${path} 不得直接裁剪 ISO 时间作为用户可见时间`);
}
for (const path of [
  "apps/mobile/src/pages/merchant/restock.vue",
  "apps/mobile/src/pages/common/door-closed.vue",
  "apps/mobile/src/pages/special/device-detail.vue",
  "apps/mobile/src/pages/tabs/records.vue"
]) {
  assert.match(readSource(path), /formatBeijing/, `${path} 必须通过统一工具展示或初始化北京时间`);
}

const operationsSource = readSource("apps/admin-web/src/pages/OperationsPage.vue");
assert.match(
  operationsSource,
  /v-if="actionMessage"[\s\S]{0,320}:role="actionMessage\.type === 'error' \? 'alert' : 'status'"[\s\S]{0,180}:aria-live="actionMessage\.type === 'error' \? 'assertive' : 'polite'"[\s\S]{0,80}aria-atomic="true"/,
  "柜机操作结果必须按成功或失败向辅助技术播报"
);
assert.match(
  operationsSource,
  /v-if="loadError"[\s\S]{0,160}role="alert"[\s\S]{0,80}aria-live="assertive"[\s\S]{0,80}aria-atomic="true"/,
  "柜机加载失败必须立即向辅助技术播报"
);
const operationsLoadStartIndex = operationsSource.indexOf("const load = async");
const operationsLoadSource = operationsSource.slice(
  operationsLoadStartIndex,
  operationsSource.indexOf("onMounted(async", operationsLoadStartIndex)
);
const operationsEmptySource = operationsSource.slice(
  operationsSource.indexOf('<div v-else class="admin-empty"'),
  operationsSource.indexOf('<div v-if="drawerMode"')
);
assert.match(operationsSource, /loadError\.value[\s\S]{0,120}—（暂不可用）/, "柜机加载失败时总数不得误显示为 0");
assert.match(
  operationsLoadSource,
  /暂时无法获取柜机状态，请确认本地服务已启动，然后重试。/,
  "柜机加载失败必须展示统一中文恢复建议"
);
assert.doesNotMatch(operationsLoadSource, /readErrorMessage/, "柜机加载失败不得直接暴露 Failed to fetch 等底层错误");
assert.match(operationsSource, /v-if="!loadError"[\s\S]{0,120}@click="load"/, "普通刷新入口在错误态必须收起");
assert.doesNotMatch(operationsEmptySource, /@click="load"/, "柜机空态不得与错误提示重复提供重试入口");
assert.match(operationsSource, /stock <= 0[\s\S]{0,120}缺货/, "柜机列表只有零库存才应标记缺货");
assert.match(operationsSource, /goods\.stock <= goods\.lowStockThreshold[\s\S]{0,120}低库存/, "柜机列表达到阈值但未归零时应标记低库存");
assert.match(
  adminLayoutSource,
  /@media \(min-width: 561px\) and \(max-width: 760px\) and \(max-height: 650px\)[\s\S]*?\.workbench__sidebar\s*\{[\s\S]*?display:\s*flex/,
  "低高度窄屏后台必须压缩侧栏，让主要内容更早出现"
);
assert.match(
  adminLayoutSource,
  /\.workbench__nav[\s\S]{0,260}overflow-x: auto/,
  "压缩侧栏后的导航必须可横向滚动，不能裁掉入口"
);
assert.match(adminDeviceSource, /stock <= 0[\s\S]{0,120}缺货/, "柜机详情只有零库存才应标记缺货");
assert.match(adminDeviceSource, /goods\.stock <= goods\.lowStockThreshold[\s\S]{0,120}低库存/, "柜机详情达到阈值但未归零时应标记低库存");
assert.ok(
  [...goodsOverviewSource.matchAll(/warehouseSnapshot\.value\?\.transferableBatches/g)].length >= 2,
  "货品总览的货品和批次选项必须只读取可调拨批次"
);
assert.doesNotMatch(
  goodsOverviewSource,
  /warehouseSnapshot\.value\?\.availableBatches/,
  "货品总览不得继续使用含义含混的 availableBatches"
);
assert.match(goodsTransferSource, /label: "批次到期"/, "货品总览调拨确认必须展示批次到期日");
assert.match(goodsOverviewSource, /item\.status === "empty"[\s\S]{0,80}缺货/, "货品总览只有零库存才应标记缺货");
assert.match(goodsOverviewSource, /item\.status === "low"[\s\S]{0,80}低库存/, "货品总览低库存状态必须使用低库存标签");

const relativeLuminance = (hex) => {
  const channels = hex
    .slice(1)
    .match(/.{2}/g)
    .map((value) => Number.parseInt(value, 16) / 255)
    .map((value) => (value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4));
  return 0.2126 * channels[0] + 0.7152 * channels[1] + 0.0722 * channels[2];
};
const contrastAgainstWhite = (hex) => 1.05 / (relativeLuminance(hex) + 0.05);
const themeSource = readSource("apps/mobile/src/styles/theme.css");
const mobileShellSource = readSource("apps/mobile/src/layouts/MobileShell.vue");
const mobileCopySource = readSource("apps/mobile/src/constants/copy.ts");
const specialHomeSource = readSource("apps/mobile/src/pages/special/home.vue");
assert.doesNotMatch(
  mobileShellSource,
  /runtimeDataPlane|模拟服务|服务状态待确认|shell__runtime-badge/,
  "移动端壳层不得展示运行平面自述"
);
assert.doesNotMatch(mobileCopySource, /模拟服务|服务状态待确认/, "移动端文案不得保留运行平面自述");
assert.doesNotMatch(mobileCopySource, /验收模拟实例/, "移动端不得向用户展示验收自述");
for (const color of ["#9a4f00", "#8f4700", "#a95500", "#ad5700"]) {
  assert.ok(themeSource.includes(color), `主题必须包含已核验的高对比度颜色 ${color}`);
  assert.ok(contrastAgainstWhite(color) >= 4.5, `${color} 上的白字对比度必须至少为 4.5:1`);
}
assert.doesNotMatch(mobileShellSource, /--vm-warning:\s*#ff8a2b/, "页面模式不得覆盖为低对比度警示色");
assert.doesNotMatch(specialHomeSource, /var\(--vm-warning\),\s*#ff9a33/, "扫码主按钮不得使用低对比度渐变端点");

console.log("frontend safety smoke: passed");
