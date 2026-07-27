# Spark 公网最终入口链路

本文件定义当前上线的唯一入口：**VNC 只运行 Nginx；Spark 运行完整应用。**它替代旧的 VNC API Unix socket、VNC 私网 API relay、VNC 静态 relay 三段入口设计。旧设计仍保留在仓库中作为历史回退资料，但不是这次上线的部署步骤。

```text
用户 HTTPS 请求
  -> VNC Nginx :443
  -> WireGuard http://10.66.66.2:5795
  -> Spark vending-public-web.service
       -> 后台与移动 H5 静态内容
       -> 受限内部 API relay
       -> Spark API 127.0.0.1:8100
```

VNC 不运行 vending 的 Node API、静态站点、Unix socket edge、私网 API relay，也不把 Spark 原始端口直接暴露到公网。`10.66.66.2:5795` 只经 WireGuard 由 VNC Nginx 访问；防火墙放宽不改变这一条边界。

## Spark 就绪门槛

Spark 上受管的 `vending-public-web.service` 必须由当前 Git 发布版本提供，同时满足下列精确检查：

```bash
curl -fsS -o /dev/null http://10.66.66.2:5795/
test "$(curl -sS -o /dev/null -w '%{http_code}' http://10.66.66.2:5795/api/health)" = 200
curl -fsS -o /dev/null http://127.0.0.1:8100/api/health
```

`/api/health` 为非 `200`（包括 `404`）时，入口切换必须停止；不能用旧 VNC API、裸露 Spark 端口或临时 Nginx 配置绕过。Spark 内部 relay 仍必须限制来源和重建信任代理头，不能把客户端转发头直接交给 API。

## VNC 切换与回滚

VNC 上只允许经 root-owned、固定目标的 [最小切换助手](../deploy/simple-vnc-spark-cutover/README.md) 修改 `/etc/nginx/sites-available/vending.5gogogo.top`。它限定且仅改该文件中唯一的 `location ^~ /api/` 与 `location /` 的直接 `proxy_pass`，二者都改向 `http://10.66.66.2:5795`；当前审查过的原始 SHA-256 被硬编码，变更后先 `nginx -t` 再 reload，失败自动恢复。

安装完成后的切换命令固定为：

```bash
sudo /usr/local/sbin/vending-spark-vhost-cutover
```

固定回滚命令为：

```bash
sudo /usr/local/sbin/vending-spark-vhost-rollback
```

不接受参数，不允许在 VNC 用户可写 checkout 中直接 `sudo python`，不新增 `443` server block，不改防火墙，不停止旧 Node 服务。旧 VNC vending 服务只能在公网根页面、同源 `/api/health`、管理员后台角色流程均通过并稳定观察后，按单独记录的具体 service 优雅退役；不得按端口批量杀进程。

## 验收顺序

1. Spark Git-only 更新、构建、API 与 `:5795` 受管服务都通过本机检查。
2. VNC 执行固定切换助手；Nginx 语法和 reload 成功。
3. 从公网 HTTPS 验证根页面、`/login`、`/mobile/`、`/api/health` 和管理员登录流程。
4. 保留 root-only vhost 备份；异常时先执行固定回滚命令，再处理 Spark 服务。
5. 两次公网回归且稳定观察后，才列出并退役经核验的旧 VNC vending service。VNC、Nginx 与其他业务不在退役范围内。
