# Spark 本机受控公网 App 验收运行器

该运行器用于从 Spark VNC 本机终端，以固定 HTTPS 业务入口验证管理员权限、人工验证码单次消费和预约闭环。它不提供公开入口、不接受参数、不读取业务环境变量、不直接访问运行数据，也不操作库存、支付或柜机。

生产运行器固定安装到 `/usr/local/lib/vending-public-app-acceptance/v1`，固定 root 启动器为 `/usr/local/sbin/vending-public-app-acceptance-root`。运行时要求：运行器目录为 `root:root 0700`、全部模块和 manifest 为 `root:root 0600`、每个模块 SHA-256 与 root-only manifest 一致，且只能使用 root 管理的 `/usr/bin/node`。启动器会以净化环境执行，先验证完整性并加载全部 root-private 业务模块，再降权为固定 Spark 服务用户，最后才核验本地图形终端并读取不回显输入。

## 安装边界

`install-root-owned-runtime.sh` 只能由 root 在**root-owned、已核验的 Git checkout**中零参数执行。用于安装的 checkout 必须位于 root 可控路径，例如 `/root/vending-release`；现有 `/home/fivegogogo/vending/current` 仅用于 Git-only 服务发布，不能作为安装源。安装器会拒绝 VNC 用户可写路径、拒绝覆盖已有 `v1`、启动器或 sudo 规则；它只新增 root-private 运行器、固定启动器和一条零参数 sudo 规则，不会修改 Spark 服务、环境、数据平面、柜机、库存或支付。

root 安装窗口应先把目标发布提交检出到 `/root/vending-release`，确认该 checkout 的 `git status --porcelain` 为空、所有目录链为 `root:root` 且不可被组或其他用户写入，再从其中执行安装器。发布记录必须同时保存该 checkout 的精确提交号；不要从 `/home/fivegogogo` 复制文件、不要借用该用户的 SSH/NVM/环境变量，也不要把业务密码、手机号或验证码传入安装过程。若 root 主机无法直接取得该 Git 提交，应由管理员先通过已核验的 root-owned 发布包建立同等来源，而不是放宽到用户可写工作树。

安装前系统必须已有 root 管理的 Node.js 18+：`/usr/bin/node` 为普通文件、`root:root`、不可被组或其他用户写入。不得使用 `~/.nvm/.../node`。

安装完成后，固定 sudo 规则只允许 `fivegogogo` 在 Spark 本地图形终端以零参数启动 `/usr/local/sbin/vending-public-app-acceptance-root`。root bootstrap 在读取任何业务输入前降权为该服务用户；SSH、管道、非图形会话、参数、未净化环境、非固定路径、文件哈希不匹配或目录权限漂移都会失败关闭。输入仅在通过这些门禁和公网只读预检后以不回显方式读取。

运行成功时，业务路径是：公网配置预检 → 管理员登录与权限核验 → 读取现有在线模拟库存 → 创建专用特殊群体夹具与个人预约规则 → 签发 6 位、5 分钟单次人工码 → App 登录与预约 → 重放拒绝 → 取消预约 → 删除夹具。操作审计、已取消预约和已消费验证码留痕会按系统规则保留；如网络中断导致创建状态无法确认，运行器只输出非敏感运行参考号并保留夹具，不能直接重跑同一手机号。
