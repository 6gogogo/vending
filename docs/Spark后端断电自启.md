# Spark 后端断电自启

## 保障范围

本方案保证 Spark 操作系统完成启动后，无需登录桌面或打开终端，公益智助柜后端会由 systemd 自动恢复：

- `wg-quick@wg-mc.service` 恢复 Spark 与公网机之间的 WireGuard 链路；
- `vending-api-candidate.service` 恢复回环 API `127.0.0.1:8100`；
- `vending-public-web.service` 恢复 `10.66.66.2:5795` 的后台、移动 H5 和受限 API 转发；
- 公网机的受管 Nginx 继续通过 WireGuard 访问 Spark。

主机本身能否在来电后自动开机由 BIOS/UEFI 的“断电恢复后开机”设置决定，不属于 Linux 服务配置。若主机没有自动上电，systemd 无法启动任何应用。

## 一次安装

在当前 Git 发布目录中由 `fivegogogo` 执行：

```bash
bash deploy/scripts/install-spark-backend-autostart.sh
```

安装器不接受参数，不读取或显示业务密钥。它会先确认 `Linger=yes`，备份现有用户单元，再安装仓库中的固定单元，启用并依次重启 API 与公网 Web。任一健康门禁失败时会自动恢复原单元、原启用状态和原运行状态；回滚本身未完整通过时会明确报错，不会误报恢复完成。

安装器只比较现有主单元与版本模板的环境指令摘要，摘要不一致便停止，避免覆盖运行数据平面。API 可继续保留固定路径的 `90-smartvm-notify-origin.conf`，但该文件必须归 `fivegogogo` 所有、权限为 `0600`，且只能设置一个 HTTPS `SMARTVM_ALLOWED_NOTIFY_ORIGINS`；其他指令、维护或未知 drop-in 一律拒绝安装。

两个业务单元使用 `Restart=always` 和 `StartLimitIntervalSec=0`。因此，即使开机时 WireGuard 地址尚未出现，公网 Web 也会继续重试，不会因启动次数达到上限而永久停止。

## 验证

安装后或主机重启后执行：

```bash
bash deploy/scripts/verify-spark-backend-autostart.sh
```

校验同时覆盖：

1. 服务用户已启用 linger；
2. WireGuard、API 和公网 Web 均已启用且正在运行；
3. 两个业务单元指向 `/home/fivegogogo/vending/current`；
4. API 回环健康和生产就绪检查成功；
5. Spark 私网页面返回 `200`；
6. Spark 本机直连受限 API 返回预期的 `403`，来源门禁没有被自启改动绕过；
7. 从 Spark 经公网 HTTPS 回环访问健康和生产就绪接口成功，确认公网 Nginx、WireGuard 和 Spark 三段链路整体恢复。

安装完成后仍建议从另一台设备访问 `https://vending.5gogogo.top/`，补充用户侧网络的独立证据。
