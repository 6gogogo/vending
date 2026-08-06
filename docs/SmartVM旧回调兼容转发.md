# SmartVM 旧回调兼容转发

柜机平台仍使用旧的 `http://5gogogo.top:4000` 回调地址时，由 VNC 上的独立兼容进程把请求原样送入当前 Spark 入口。该进程不是旧 API，也不提供后台、健康检查或其他业务接口。

```text
SmartVM 旧 HTTP 回调
  -> VNC 0.0.0.0:4000 固定路径兼容进程
  -> WireGuard 10.66.66.2:5795
  -> Spark vending-public-web.service 受限 API relay
  -> Spark API 127.0.0.1:8100
```

## 固定兼容范围

仅接受 `Host: 5gogogo.top[:4000]`、`POST`、`Content-Type: application/json` 且不带查询参数的下列路径：

- `/api/cabinet-events/callbacks/door-status`
- `/api/cabinet-events/callbacks/settlement`
- `/api/cabinet-events/callbacks/adjustment`
- `/api/inventory-orders/callbacks/refund`

请求正文最多 1 MiB。兼容进程不解析、不改写、不重签正文；客户端提供的 `Host`、转发头和内部 `X-Vending-*` 头不会继续传递，来源地址由 TCP 连接重建。Spark 的状态码、响应正文和端到端头会返回给柜机平台，上游不可用时只返回空的 `502`。兼容进程自身不记录回调正文或签名；当前 API 仍按既有脱敏规则保存业务回调日志。

其他主机名返回 `403`，其余路径返回 `404`，非 `POST` 返回 `405`，非 JSON 返回 `415`。不得把白名单扩大成 `/api/*`，不得在 VNC 恢复完整 Node API，也不得把 Spark 原始端口直接暴露到公网。

## 发布

代码必须来自已验证并推送的 Git 提交。VNC 使用既有仓库对象建立只读、可回退的版本工作树，并由专用软链接 `/home/vnc/vending-legacy-callback-current` 指向当前版本；不能从 VNC 的脏工作树复制文件或直接改线上脚本。

安装用户服务：

```bash
install -D -m 644 \
  deploy/systemd/vending-legacy-smartvm-callback-relay.service \
  "$HOME/.config/systemd/user/vending-legacy-smartvm-callback-relay.service"
systemctl --user daemon-reload
systemctl --user enable --now vending-legacy-smartvm-callback-relay.service
```

启动前必须确认 `:4000` 没有其他监听者，并从 VNC 验证 `http://10.66.66.2:5795/api/health` 返回 `200`。不得通过强杀占用进程抢端口；若端口已有归属，先查明受管服务并停止发布。

## 验证

以下检查不会生成业务回调：

```bash
systemctl --user is-active --quiet vending-legacy-smartvm-callback-relay.service
ss -lntp | grep ':4000'
test "$(curl -sS -o /dev/null -w '%{http_code}' \
  http://127.0.0.1:4000/api/health)" = 404
test "$(curl -sS -o /dev/null -w '%{http_code}' \
  http://127.0.0.1:4000/api/cabinet-events/callbacks/door-status)" = 405
```

公网使用同一路径检查 `405`，用于确认云防火墙和监听链路已通。不要为了验收伪造签名回调；完整端到端成功以柜机平台下一次真实回调的正常确认和后台回调日志为准。

## 回滚与退役

兼容进程与 HTTPS 入口、VNC、Nginx 和其他业务相互独立。异常时只执行：

```bash
systemctl --user disable --now vending-legacy-smartvm-callback-relay.service
```

供应商把四个地址全部改为 `https://vending.5gogogo.top` 并完成真实回调确认后，停止该服务并关闭公网 TCP 4000；不要长期保留裸 HTTP 兼容入口。
