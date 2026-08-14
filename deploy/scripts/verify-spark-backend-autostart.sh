#!/usr/bin/env bash

set -euo pipefail

readonly expected_user="fivegogogo"
readonly expected_working_directory="/home/fivegogogo/vending/current"
readonly api_unit="vending-api-candidate.service"
readonly web_unit="vending-public-web.service"
readonly wireguard_unit="wg-quick@wg-mc.service"
readonly unit_directory="${HOME}/.config/systemd/user"
readonly allowed_api_drop_in="${unit_directory}/${api_unit}.d/90-smartvm-notify-origin.conf"

fail() {
  printf '断电自启校验失败：%s\n' "$1" >&2
  exit 1
}

[[ $# -eq 0 ]] || fail "本脚本不接受参数。"
[[ "$(id -un)" == "$expected_user" ]] || fail "必须由服务用户 ${expected_user} 执行。"

for command_name in curl loginctl sed stat systemctl; do
  command -v "$command_name" >/dev/null 2>&1 || fail "缺少命令 ${command_name}。"
done

linger_state="$(loginctl show-user "$expected_user" -p Linger)"
[[ "$linger_state" == "Linger=yes" ]] || fail "Linger 未启用，用户退出或主机重启后服务无法保证启动。"

systemctl is-enabled --quiet "$wireguard_unit" || fail "WireGuard 单元未启用。"
systemctl is-active --quiet "$wireguard_unit" || fail "WireGuard 单元未运行。"

for unit in "$api_unit" "$web_unit"; do
  systemctl --user is-enabled --quiet "$unit" || fail "${unit} 未启用。"
  systemctl --user is-active --quiet "$unit" || fail "${unit} 未运行。"

  restart_policy="$(systemctl --user show "$unit" -p Restart --value)"
  [[ "$restart_policy" == "always" ]] || fail "${unit} 的 Restart 不是 always。"

  working_directory="$(systemctl --user show "$unit" -p WorkingDirectory --value)"
  [[ "$working_directory" == "$expected_working_directory" ]] || fail "${unit} 未指向当前发布入口。"

  start_limit_interval="$(systemctl --user show "$unit" -p StartLimitIntervalUSec --value)"
  case "$start_limit_interval" in
    0 | 0us) ;;
    *) fail "${unit} 的有效启动重试时间窗仍有限。" ;;
  esac

  drop_in_paths="$(systemctl --user show "$unit" -p DropInPaths --value)"
  for drop_in_path in $drop_in_paths; do
    if [[ "$unit" != "$api_unit" || "$drop_in_path" != "$allowed_api_drop_in" ]]; then
      fail "${unit} 存在维护或未知 drop-in。"
    fi
    [[ -f "$drop_in_path" && ! -L "$drop_in_path" ]] ||
      fail "允许的 SmartVM 回调来源 drop-in 不是普通文件。"
    [[ "$(stat -c '%U:%G' "$drop_in_path")" == "${expected_user}:${expected_user}" ]] ||
      fail "允许的 SmartVM 回调来源 drop-in 属主不正确。"
    [[ "$(stat -c '%a' "$drop_in_path")" == "600" ]] ||
      fail "允许的 SmartVM 回调来源 drop-in 权限不正确。"

    mapfile -t drop_in_lines < <(sed '/^[[:space:]]*$/d' "$drop_in_path")
    [[ "${#drop_in_lines[@]}" -eq 2 && "${drop_in_lines[0]}" == "[Service]" ]] ||
      fail "允许的 SmartVM 回调来源 drop-in 结构不符合固定合同。"
    [[ "${drop_in_lines[1]}" =~ ^Environment=SMARTVM_ALLOWED_NOTIFY_ORIGINS=https://[A-Za-z0-9.-]+(:[0-9]{1,5})?/?$ ]] ||
      fail "允许的 SmartVM 回调来源 drop-in 含有非固定指令或非 HTTPS 来源。"
  done
done

curl -fsS --max-time 10 http://127.0.0.1:8100/api/health >/dev/null ||
  fail "API 回环健康检查失败。"
curl -fsS --max-time 10 http://127.0.0.1:8100/api/health/production-readiness >/dev/null ||
  fail "API 生产就绪检查失败。"

web_root_status="$(curl -sS --max-time 10 -o /dev/null -w '%{http_code}' http://10.66.66.2:5795/ || true)"
[[ "$web_root_status" == "200" ]] || fail "Spark 私网静态入口不是 200。"

direct_api_status="$(curl -sS --max-time 10 -o /dev/null -w '%{http_code}' http://10.66.66.2:5795/api/health || true)"
[[ "$direct_api_status" == "403" ]] || fail "Spark 本机直连 API 未按来源门禁返回 403。"

curl -fsS --max-time 15 https://vending.5gogogo.top/api/health >/dev/null ||
  fail "公网 HTTPS 健康检查失败。"
curl -fsS --max-time 15 https://vending.5gogogo.top/api/health/production-readiness >/dev/null ||
  fail "公网 HTTPS 生产就绪检查失败。"

printf '断电自启校验通过：Linger、WireGuard、API、本机来源门禁与公网 HTTPS 生产链路均正常。\n'
