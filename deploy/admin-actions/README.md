# Vending 公网入口 root action 候选

本目录提供的是受限 root action 的**候选包**。它只解决公网入口所需的 root 托管边界，不能代替 `codex-admin *`，不能接受任意路径或参数，也不会直接暴露 Spark 服务端口。

## 固定能力

- 四个 wrapper 都是零参数命令：`vending-public-ingress-prepare`、`vending-public-ingress-activate`、`vending-public-ingress-rollback-readiness` 与 `vending-public-ingress-rollback`；sudoers 必须用空参数规则精确匹配，不能授予 Node、shell、`codex-admin *` 或通配符。
- action 只接受 root:root、不可被组/其他用户写入的 `/usr/local/lib/vending-public-ingress-admin/v1`。计划、计划 SHA-256、四个 entrypoint 与 payload 都必须为 root:root、0644。
- 计划中的三份 payload、四个目标路径、秘密来源与现有文件 SHA-256 都被固定校验。`absent-or-same` 只允许目标不存在，或其内容已经等于新 payload；不会覆盖未知 root 配置。
- 服务令牌只从既有 root-only 来源 `/etc/vending/secrets/vending-private-api-relay.token` 原子复制到 `/etc/vending/credentials/vnc/private-api-relay.token`。目标父目录必须是 root:vnc、0710，令牌必须是 vnc:vnc、0600；不会写入 VNC 用户可改写的 home 链。
- 输出只包含 JSON 的阶段、计划 SHA-256 与结果；不输出令牌、环境变量、Nginx 全文或命令错误详情。每个阶段还会追加到 root:root、0600 的 `/var/log/vending-public-ingress-admin/audit.log`，只记录时间、action 版本、计划 SHA-256、阶段和结果，便于审计与回滚追踪。

## 两阶段，避免切流到未就绪 socket

1. **准备**：`vending-public-ingress-prepare` 只安装 tmpfiles、建立 `/run/vending`、校验当前 Nginx 语法、再写入 VNC 私有令牌。它不会改 vhost、不会 reload Nginx，因此不改变现有 HTTPS `/api` 连接。
2. **VNC 服务检查**：受管 VNC 用户完成 Git-only 更新、构建并启动 API edge，验证 Unix socket 的正向健康请求和非授权本机用户的拒绝结果。
3. **切流**：`vending-public-ingress-activate` 先核验 tmpfiles、令牌、socket 的属主/组/模式、Nginx worker 组以及正反 socket 探针；仅在这些检查通过后才原子安装 Nginx fragment/vhost，运行 `nginx -t` 与有效 server-block 合同校验，最后 reload。任一失败都会恢复 fragment/vhost 并重新验证旧配置；已尝试 reload 时还会 reload 已恢复的旧配置。
4. **退役前回退预检**：`vending-public-ingress-rollback-readiness` 只核验当前 fragment/vhost 仍精确匹配 sealed payload、root-only `previous/<plan-sha>` 归档及 manifest 完整、`nginx -t` 和有效 server-block 合同通过。它不会替换文件、reload、改 tmpfiles、令牌、Spark 或 VNC user service；只记录最小审计阶段。旧本地回退服务 disable 前必须成功执行此检查。
5. **已成功切流后的固定回退**：`vending-public-ingress-rollback` 只恢复当前 sealed plan 对应的 root-only `previous/<plan-sha>` Nginx fragment/vhost 备份；它先拒绝 drift，核对 root-only manifest 中的计划 SHA、备份状态和每个文件 SHA-256，再 `nginx -t` 后 reload。它不改 tmpfiles、令牌或 Spark 数据面。回退前后的配置快照保留在 root-only 审计目录；同一 sealed plan 若需再次切流，必须重新密封新计划，不能覆盖历史备份。

`:5795` 的 HTTP 入口别名属于受管 VNC 用户服务，仍须在 HTTPS 主站回归通过后独立启动；本 root action 不会把完整应用、API 或 Spark 原始端口绑定到公网 `:5795`。

最终运行态不保留 VNC 上旧的完整 vending API/静态业务。Spark 承载实际 API 和静态应用；VNC 只保留 Nginx、带服务令牌的 API edge、静态转发器以及可选的仅跳转入口。旧本地回退服务只能在新公网链路、管理员后台和必要角色流都通过验收后，按已核验的具体受管 service 优雅停用；禁止按端口批量杀进程或影响其他 VNC 业务。

旧服务退役不是 root action 的职责，也不能在计划未密封时提前做。切流稳定至少 30 分钟并完成第二次公网回归后，使用 [退役记录模板](vending-legacy-runtime-retirement.record.template.md) 固定旧 service、PID、工作目录和回滚资产；仅 stop/disable 记录中的两个旧 vending user service。旧 unit、checkout 与依赖保留至少 7 天。若要回退，先重新启动并健康验证旧 API，再执行本 action 的 Nginx rollback，最后停止新 API edge；静态服务先停止新 edge 再恢复旧服务。这个顺序避免旧 upstream 尚未启动时把公网入口切回去。

## 为什么模板不能直接运行

`vending-public-ingress.plan.template.json` 有意标记为 `candidate`，并以 `UNCONFIGURED` 占位。管理员必须先在 root 会话中以 `nginx -T` 定位**实际** `vending.5gogogo.top` vhost，复制完整内容到 sealed payload，只替换受控 `/api/` location，并记录当前 vhost 精确 SHA-256。

当前 v1 固定的 vhost 目标是 `/etc/nginx/conf.d/vending.5gogogo.top.conf`。若真实目标不同，不要通过参数、软链接或修改已安装计划绕过；应先制作并审查新的固定版本 action，再密封该版本。

## root 安装门禁

root 管理员必须从 root-owned、已核验提交的 checkout 或等价受控工件安装下列文件，不要从 VNC 用户可写工作目录直接 `sudo` 执行脚本：

- `scripts/vending-public-ingress-root-action.mjs`
- `scripts/vending-public-ingress-prepare-root-action.mjs`
- `scripts/vending-public-ingress-rollback-root-action.mjs`
- `scripts/vending-public-ingress-rollback-readiness-root-action.mjs`
- `scripts/verify-vnc-nginx-edge-contract.mjs`
- `deploy/admin-actions/payload/vending-edge.conf`
- `deploy/admin-actions/payload/vending-api-edge-unix-socket.conf`
- 已密封的 `vending-public-ingress.plan.json` 与匹配的 SHA-256 文件
- `deploy/admin-actions/vending-public-ingress-prepare`、`vending-public-ingress-activate`、`vending-public-ingress-rollback-readiness`、`vending-public-ingress-rollback` 与 `vending-public-ingress.sudoers`

`/usr/bin/node` 也必须是 root 管理、不可被组/其他用户写入的系统二进制；不可使用 `/home/vnc/.nvm/...`。安装 sudoers 后先以 `visudo -cf` 校验。计划未密封、文件 hash 不符、socket 不就绪或 Nginx 合同不完整时 action 必须失败关闭。

当前 VNC 主机为 Ubuntu 24.04 且尚无 `/usr/bin/node`。管理员可在独立 root 维护窗口先执行下面的运行时前置；它不安装本 action、不改 Nginx，也不接触令牌：

```bash
sudo apt-get update
sudo apt-get install -y --no-install-recommends nodejs
sudo test -x /usr/bin/node
sudo stat -c '%U:%G %a %n' /usr/bin/node
```

## 管理员审计项

此前只读元数据发现 `/etc/codex-admin.d/codex-admin.env` 为 `root:root 0644`。未读取内容，不能据此断言含有秘密；管理员应确认它不承载敏感值，若承载则按最小可读权限修复。不要为此调用或修改现有不透明 `codex-admin`。
