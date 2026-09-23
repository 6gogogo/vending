# 后台重构正式发布与回滚回执

2026-09-23，用户明确授权“如果回滚有备案，就实机上线”。正式服务器已发布 `48650d2`，公网分层检查和已登录后台的浏览器抽查通过。入口：<https://vending.5gogogo.top/>。

## 版本和部署范围

| 项目 | 实际结果 |
| --- | --- |
| 正式源码提交 | `48650d2360f5478e12654e4350f4cdb9dcbbf0a5` |
| 回滚目标 | `d9f38423cae7ab5cc383c53f6bc4042d7be192f9` |
| 开发分支 | `codex/admin-workspace-redesign`；后续修改继续在此分支 |
| 发布分支 | `codex/UI`；服务器通过 Git 快进拉取 |
| 正式主机 / 运行时 | Spark，Linux aarch64，Node 22.22.2 / npm 10.9.7 |
| 受管服务 | `vending-api-candidate.service`、`vending-public-web.service` |
| 服务源码入口 | `/home/fivegogogo/vending/current`；保留既有符号链接与部署拓扑 |
| 运行数据 | 原受控 live 平面，未迁移格式，未回灌旧快照 |
| 机器可读回执 | [deployment-20260923.json](deployment-20260923.json) |

本轮没有修改 API 协议、数据库结构、生产配置、Nginx 或 systemd 单元。后台与 H5 正式静态产物重新构建；未上传微信、支付宝小程序或 App 安装包。原始 F 盘工作区的既有未提交修改未并入发布。

## 发布经过和检查

下列时间均为北京时间（UTC+8）。维护窗口按 Web/API 停止至恢复记录，不能理解为全网用户的精确断连时长。

| 阶段 | 时间 / 结果 |
| --- | --- |
| 首轮维护 | 14:59:38–15:00:53，约 76 秒；Linux 中继安全测试断言失败，自动恢复旧版本 |
| 本地修正 | 修正直接父目录与祖先目录符号链接的两种错误断言，并补覆盖；没有放宽服务端安全检查 |
| 本地复验 | Node 22.22.2 全量检查通过；Windows 1001 通过、6 项平台跳过；WSL Linux 中继专项 17/17 通过、0 跳过 |
| 第二轮维护 | 15:07:56–15:09:26，约 90 秒；重新停写、校验与备份，再 Git 拉取、安装、测试、构建、启动 |
| 正式 Linux 检查 | **1007 项，1007 通过，0 失败，0 跳过**；类型、合同、安全 smoke 检查和全部工作区构建通过 |
| 最终 Web 构建 | `build:public-web` 通过，后台同源 `/api`，H5 `/mobile/`；生产验证码预览关闭 |
| 最终进程状态 | 两个受管服务 `active/running`、`Result=success`、`NRestarts=0`，源码工作树干净且 HEAD 正确 |

首轮失败发生在 `scripts/serve-private-api-relay.test.mjs`：直接父目录为符号链接时，实现正确拒绝并返回“parent must be a directory”，旧断言却期待祖先链错误。同步修正公开中继的同类断言，另加嵌套路径以继续覆盖“parent chain must contain only directories”。先在本地复验、提交和推送，再由服务器 Git 拉取；没有在正式源码目录热修文件。

### 公网和链路复查

| 来源 | 请求 | 结果 |
| --- | --- | --- |
| Spark 直连 | API health、production-readiness | 均 200 |
| Spark 直连 | 私有 Web 根页面 / 非授权来源的 relay API | 200 / 403，符合来源限制 |
| VNC 经 WireGuard | 私有 Web 根页面及 `/api/health` | 均 200 |
| 公网 HTTPS | `/`、`/login`、`/mobile/` | 均 200 |
| 公网 HTTPS | `/api/health`、`/api/health/production-readiness` | 均 200 |
| 公网未登录 | `/api/users` | 403 |
| 公网静态入口资源 | 后台与 H5 引用的 5 个 JS/CSS | 全部 200，MIME 正确 |

最终公网检查时间为 15:17:29。一次辅助 Python 探针继承 Spark 的代理环境，访问私有地址得到 502；改用仅对该探针关闭代理的直连请求后，全部达到预期状态。生产代理和网络配置未更改。

外部服务预检为 **19 通过、0 警告、0 失败、4 跳过**；报告总体标记 `skip`，不能表述为外部端到端全通过。四项为：没有另外提供管理员 token 的支付诊断读取、明确跳过的 SmartVM 外部探测、真实短信发送、当前关闭新支付链路下的支付渠道预检。正式浏览器另外验证了柜机监控读取，但没有执行真实开柜。

### 正式浏览器验收

使用用户既有 Edge 登录会话；未导出会话令牌。以下操作均已实际执行并目视检查截图：

- 桌面工作台、领取规则、人员、仓库、设置、柜机监控加载正常，抽查页面无整页水平溢出。
- 功能搜索直达“领取与预约”，弹层关闭；浏览器后退到工作台，前进恢复相同分区。
- 375×812 人员列表、手机导航和调拨表单可用；320×500 新增人员弹窗顶部可关闭，底部按钮可滚动到达，空表单保存禁用。
- 人员“管理”展开与收起、待办详情打开与关闭均正常。没有签发验证码、标记待办或提交业务表单。
- 服务商退出实例到全局工作台，再进入原实例，正常到达既有默认“人员管理”页；最后回到工作台并恢复桌面视口。
- 本次浏览器验收记录的 console error 为 0。

截图和原始 JSON 留在开发工作树 `.codex-run/production-20260923/`，不提交生产界面中的人员信息。有效截图编号为 01–06、`07-transfer-mobile-form.png`、08–09；其中 `07-transfer-mobile.png` 是截图工具尺寸异常的中间产物，不作为证据。

这是正式服务器与桌面浏览器窄屏验收，**不是物理手机 Safari/微信内置浏览器、软键盘或真实开柜/付款/退款的全链路验收**。公网角色交互使用服务商实例会话，未逐个登录商户、补货员等生产账号；角色与权限的自动回归结果见既有流程记录。

## 回滚备案

回滚机制已在首轮失败时实际执行成功：恢复旧 Git 提交和旧依赖、构建产物后，API 健康/就绪检查和 Web 恢复。**没有恢复 live 数据快照**，避免抹掉正常业务写入。

第二轮发布的完整私有证据目录：

```text
/home/fivegogogo/vending/release-evidence/20260923-admin-redesign-48650d2-retry
```

其中 `status.json` 记录执行步骤，`acceptance-summary.json` 记录测试/备份摘要，`PUBLIC_ACCEPTANCE.json` 记录最终验收，`ROLLBACK.md` 记录回退说明，`previous-runtime.tar` 保存旧依赖和产物。首轮失败与实际回滚的原始日志保存在同级 `20260923-admin-redesign-97b88ec/`，不覆盖历史。

| 备案项目 | 内容 |
| --- | --- |
| 第二轮停写备份 | `/home/fivegogogo/vending/runtime-planes/xiaoguidai-live-v2/backups/2026-09-23T07-07-59-521Z-pre-release-admin-redesign-20260923-retry` |
| 备份清单 SHA256 | `8a83dfb3a2e8425742291ae6780a1e97367c5f99a283003f53331e268b547bc5` |
| 旧运行产物归档 | `previous-runtime.tar`，539,944,960 字节 |
| 归档 SHA256 | `a51c92338b4369168aa24d73521f1b9d32381f83ce27f94e285b414510efe8e8` |
| 归档目录 | `node_modules`、`apps/admin-web/dist`、`apps/api/dist`、`apps/mobile/dist` |

需要回滚时：

1. 核对当前服务工作目录、Git HEAD 和干净状态，确认没有正在开门或待完成的近期柜机流程；保留故障现场和发布后日志。
2. 验证上述归档 SHA256 和旧提交可读取，再优雅停止 Web/API；不启动第二个金融写入进程。
3. 用 `git checkout --detach d9f38423cae7ab5cc383c53f6bc4042d7be192f9` 恢复源码。把当前四个依赖/产物目录移入新的私有故障目录保留，然后解包旧归档到受管源码目录。不要覆盖未知源码修改，不要删除 live 数据。
4. 先启动 API，直连 health 与 production-readiness 均达到 200 后再启动 Web。按上表重验 Spark、VNC、公网及登录会话；核对最终 HEAD 和服务状态。
5. 仅在确认数据损坏且另行获得恢复授权时，才按运行数据恢复流程核对发布后差额并恢复快照；纯界面回退不能回灌旧账本。

既有依赖审计仍为 52 个受影响包条目（22 high、27 moderate、3 low），与基线相同；本次未扩大依赖升级范围，也不宣称审计清零。后续后台修改继续在当前功能分支，发布仍执行本地验证、提交推送、服务器 Git 更新和公网复验。
