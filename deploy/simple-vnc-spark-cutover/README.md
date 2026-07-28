# VNC → Spark 最小 HTTPS 切换助手

这是针对一个已核验 vhost 的最小 root 工具：Spark 运行应用，VNC 只保留 Nginx。它只会修改固定文件 `/etc/nginx/sites-available/vending.5gogogo.top` 中唯一的两个 location 的**直接** `proxy_pass` 指令：`location ^~ /api/` 和 `location /` 都固定改为 `http://10.66.66.2:5795`。它不会新增 server block 或 `443` 监听，不改同一文件其它指令，不碰其它站点、防火墙、旧 Node 进程、服务令牌或 Spark 数据。

预映像被钉死为 SHA-256 `3b9c64f5bc394ff2b79ff7dd56076267ded9e772e25b547523d3025063ceaab5`。VNC 上这个文件只要有任何合法变更，工具都会在写入前拒绝；应重新只读审查、重新固定 SHA-256 并发布新的版本化工具，不能在主机上临时编辑脚本或跳过校验。

## 硬门禁与流程

执行顺序固定：Spark 本机先确认 `http://10.66.66.2:5795/` 返回精确 `200`、`http://127.0.0.1:8100/api/health` 返回精确 `200`，并确认本机直连 `http://10.66.66.2:5795/api/health` 返回 `403`；这是 relay 仅信任 VNC 来源的预期行为。随后必须从 VNC `10.66.66.1` 确认 Spark 根路径与 `/api/health` 都返回精确 `200`，才可将当前 vhost 写入 root-only `/var/lib/vending-spark-vhost-cutover/` 备份、原子替换两行 upstream、运行 `nginx -t` 并 reload。替换、语法测试或 reload 任一步失败时，工具会原子恢复已备份 vhost，并再次 `nginx -t`，仅在测试通过时 reload 已恢复配置。输出只含阶段和成功/失败，不输出 Nginx 全文、响应体、环境变量或任何秘密。

当前受管 `scripts/serve-public-web.mjs` 在启用 API relay 后，只接受 VNC `10.66.66.1` 的 `/api/*` 请求：Spark 自身或其他来源会收到 `403`，而 VNC 来源的 `/api/health` 必须为 `200`。未启用 relay 的静态服务才会对 `/api/*` 返回 `404`。不能为了让非 VNC 来源返回 `200` 而放宽白名单，也不能在 VNC 上恢复旧 API 绕过它；先满足上述来源边界与精确健康检查，才可以执行本切换。

## 安装与执行

root 必须从已核验、root-owned 的 Git checkout 或等价受控工件安装文件；不要直接对 VNC 用户可写的工作目录 `sudo python`。安装后的权限必须是：程序和两个 wrapper 均 `root:root`、不可被组/其他用户写入；程序在 `/usr/local/lib/vending-spark-vhost-cutover/vending_spark_vhost_cutover.py`，两个零参数 wrapper 分别在 `/usr/local/sbin/vending-spark-vhost-cutover` 与 `/usr/local/sbin/vending-spark-vhost-rollback`。VNC 已只读确认具备系统 `/usr/bin/python3`、`curl`、`nginx` 与 `systemctl`，无需 Node。

在 VNC 的已核验、tracked-clean Git checkout（当前受管路径为 `/home/vnc/111/vending`）中，root 一次性安装时只复制这三个固定文件；安装后程序还会拒绝任何可被组或其他用户写入的目录链：

```bash
sudo install -d -o root -g root -m 0755 /usr/local/lib/vending-spark-vhost-cutover
sudo install -o root -g root -m 0755 deploy/simple-vnc-spark-cutover/vending_spark_vhost_cutover.py /usr/local/lib/vending-spark-vhost-cutover/vending_spark_vhost_cutover.py
sudo install -o root -g root -m 0755 deploy/simple-vnc-spark-cutover/vending-spark-vhost-cutover /usr/local/sbin/vending-spark-vhost-cutover
sudo install -o root -g root -m 0755 deploy/simple-vnc-spark-cutover/vending-spark-vhost-rollback /usr/local/sbin/vending-spark-vhost-rollback
```

安装完成后的唯一切换命令是：

```bash
sudo /usr/local/sbin/vending-spark-vhost-cutover
```

固定回滚命令是：

```bash
sudo /usr/local/sbin/vending-spark-vhost-rollback
```

回滚只接受本工具写入的 root-only manifest 和备份，并要求当前 vhost 仍精确等于本工具写入后的 SHA-256；检测到 drift 会拒绝覆盖。若回滚的 Nginx 校验或 reload 失败，它会恢复切换后的版本并再次验证。两个 wrapper 都拒绝任意参数。

`current.json` 会在成功回滚后保留为 root-only 审计证据，因此这份固定 SHA 工具是一次性切换工件：回滚后如确需再次切流，必须重新审查当时的 vhost、生成并安装新的版本化工件；不得手动删除 manifest 以绕过复核。

这只是入口切换助手，未授权停止或退役任何旧 VNC 服务。旧服务只有在公网 HTTPS 页面、同源 API 和管理员角色流验收稳定后，才能以单独、可审计的服务清单处理。

## 本地测试

```bash
node --test scripts/vending-spark-vhost-cutover.test.mjs
```

测试仅在临时 fixture 上运行 Python 的 location 解析与改写，涵盖保留 location 内其它指令、没有新 `443` block、重复 location 拒绝、缺失 `proxy_pass` 拒绝以及固定 SHA/目标核验；不会访问 VNC、Spark 或 Nginx。
