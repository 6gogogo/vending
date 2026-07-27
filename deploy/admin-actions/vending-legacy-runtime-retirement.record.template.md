# Vending 旧 VNC 运行时退役记录

此记录用于 Spark 已承载实际应用、VNC 已只保留入口转发后的旧 vending 运行时退役。它不授权停止任何服务；只有所有字段基于当前 VNC 实机只读证据填写，并且两项旧服务都明确属于 vending，才可执行发布流程中的 stop/disable。

## 切流与观察证据

| 项目 | 实际值 / 证据 |
| --- | --- |
| 记录时间（UTC） | |
| Spark 发布提交 | |
| VNC root action 计划 SHA-256 | |
| 公网 HTTPS 首页、`/api/health`、后台管理员回归 | |
| 必要角色流回归 | |
| 连续稳定观察开始 / 结束（不少于 30 分钟） | |
| 第二次独立公网回归时间 | |
| `vending-public-ingress-rollback-readiness` 成功（计划 SHA 对应归档、无 drift） | |
| 新 API edge、Unix socket、本机静态 edge 在停旧服务前的即时预检 | |

## 旧运行时身份（退役前只读记录）

| 角色 | 精确 user service | MainPID | ExecStart | WorkingDirectory | FragmentPath | cgroup / 管理器 |
| --- | --- | --- | --- | --- | --- | --- |
| 旧 API（仅 `127.0.0.1:4000`） | | | | | | |
| 旧静态（仅 `127.0.0.1:5795`） | | | | | | |

若任一行不是明确的 vending 旧回退服务，或它的恢复路径未知，停止退役；不要用端口、进程名或模糊路径推断身份。

## 停止后的隔离验证

| 检查 | 结果 / 证据 |
| --- | --- |
| 旧 API service 已 `disabled` 且不 active | |
| 旧静态 service 已 `disabled` 且不 active | |
| 静态 handover 后旧静态 service 已禁用，VNC user manager 重启不会争抢 `5795` | |
| `127.0.0.1:4000` 不再监听 | |
| `127.0.0.1:5795` 只属于新静态 edge | |
| API Unix-socket edge 与静态 edge active | |
| Nginx、VNC 和记录列出的其他业务服务仍 active | |
| 公网 HTTPS 首页、API、管理员及必要角色回归 | |

## 回滚资产与保留期

| 项目 | 实际值 / 证据 |
| --- | --- |
| 旧 API unit、checkout、依赖保留位置 | |
| 旧静态 unit、checkout、依赖保留位置 | |
| 旧静态服务在此前 handover 中已成功恢复 / 本机健康的证据 | |
| 最早允许删除时间（至少退役后 7 个自然日） | |
| 回滚演练 / 实际回滚记录（如有） | |

回滚顺序固定为：先 `enable --now` 旧 API 并验证 `127.0.0.1:4000/api/health`，再执行受限 root ingress rollback，随后停止新 API edge；静态则先停止新静态 edge，再 `enable --now` 旧静态 service 并验证 `127.0.0.1:5795`。不得删除上述资产后再尝试 root rollback。
