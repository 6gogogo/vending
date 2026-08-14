#!/usr/bin/env bash

set -euo pipefail
umask 077

readonly expected_user="fivegogogo"
readonly api_unit="vending-api-candidate.service"
readonly web_unit="vending-public-web.service"
readonly unit_directory="${HOME}/.config/systemd/user"
readonly script_directory="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
readonly repository_directory="$(cd -- "${script_directory}/../.." && pwd -P)"
readonly source_api_unit="${repository_directory}/deploy/systemd/${api_unit}"
readonly source_web_unit="${repository_directory}/deploy/systemd/${web_unit}"
readonly verifier="${repository_directory}/deploy/scripts/verify-spark-backend-autostart.sh"
readonly backup_root="${HOME}/.local/state/vending/backend-autostart-unit-backups"
readonly backup_directory="${backup_root}/$(date -u +%Y%m%dT%H%M%SZ)-$$"
readonly allowed_api_drop_in="${unit_directory}/${api_unit}.d/90-smartvm-notify-origin.conf"

fail() {
  printf '断电自启安装失败：%s\n' "$1" >&2
  exit 1
}

[[ $# -eq 0 ]] || fail "本脚本不接受参数。"
[[ "$(id -u)" -ne 0 ]] || fail "不得以 root 身份运行。"
[[ "$(id -un)" == "$expected_user" ]] || fail "必须由服务用户 ${expected_user} 执行。"
[[ -f "$source_api_unit" ]] || fail "缺少 API 单元模板。"
[[ -f "$source_web_unit" ]] || fail "缺少公网 Web 单元模板。"
[[ -f "$verifier" ]] || fail "缺少断电自启校验脚本。"
[[ "$(loginctl show-user "$expected_user" -p Linger)" == "Linger=yes" ]] ||
  fail "Linger 未启用；必须先由主机管理员完成一次系统级启用。"

for command_name in awk basename curl install loginctl sed sha256sum stat systemctl; do
  command -v "$command_name" >/dev/null 2>&1 || fail "缺少命令 ${command_name}。"
done

validate_main_unit_environment_contract() {
  local installed_unit="$1"
  local source_unit="$2"
  local installed_hash
  local source_hash

  installed_hash="$(sed -n -E '/^[[:space:]]*(Environment|EnvironmentFile|PassEnvironment|UnsetEnvironment)[[:space:]]*=/p' \
    "$installed_unit" | sha256sum | awk '{print $1}')"
  source_hash="$(sed -n -E '/^[[:space:]]*(Environment|EnvironmentFile|PassEnvironment|UnsetEnvironment)[[:space:]]*=/p' \
    "$source_unit" | sha256sum | awk '{print $1}')"
  [[ "$installed_hash" == "$source_hash" ]] ||
    fail "$(basename -- "$installed_unit") 的运行环境合同与模板不同；拒绝覆盖现有数据平面配置。"
}

validate_drop_ins() {
  local unit="$1"
  local drop_in_paths
  local drop_in_path
  local owner
  local mode
  local -a drop_in_lines

  drop_in_paths="$(systemctl --user show "$unit" -p DropInPaths --value)" ||
    fail "无法读取 ${unit} 的 drop-in 状态。"
  [[ -n "$drop_in_paths" ]] || return 0

  for drop_in_path in $drop_in_paths; do
    if [[ "$unit" != "$api_unit" || "$drop_in_path" != "$allowed_api_drop_in" ]]; then
      fail "${unit} 存在维护或未知 drop-in；请先结束维护流程。"
    fi
    [[ -f "$drop_in_path" && ! -L "$drop_in_path" ]] ||
      fail "允许的 SmartVM 回调来源 drop-in 不是普通文件。"
    owner="$(stat -c '%U:%G' "$drop_in_path")"
    mode="$(stat -c '%a' "$drop_in_path")"
    [[ "$owner" == "${expected_user}:${expected_user}" && "$mode" == "600" ]] ||
      fail "允许的 SmartVM 回调来源 drop-in 属主或权限不安全。"

    mapfile -t drop_in_lines < <(sed '/^[[:space:]]*$/d' "$drop_in_path")
    [[ "${#drop_in_lines[@]}" -eq 2 && "${drop_in_lines[0]}" == "[Service]" ]] ||
      fail "允许的 SmartVM 回调来源 drop-in 结构不符合固定合同。"
    [[ "${drop_in_lines[1]}" =~ ^Environment=SMARTVM_ALLOWED_NOTIFY_ORIGINS=https://[A-Za-z0-9.-]+(:[0-9]{1,5})?/?$ ]] ||
      fail "允许的 SmartVM 回调来源 drop-in 含有非固定指令或非 HTTPS 来源。"
  done
}

read_enabled_state() {
  local unit="$1"
  local state
  state="$(systemctl --user show "$unit" -p UnitFileState --value)" || return 1
  case "$state" in
    enabled | enabled-runtime | disabled) printf '%s\n' "$state" ;;
    *) return 1 ;;
  esac
}

read_active_state() {
  local unit="$1"
  local state
  state="$(systemctl --user show "$unit" -p ActiveState --value)" || return 1
  case "$state" in
    active | inactive) printf '%s\n' "$state" ;;
    *) return 1 ;;
  esac
}

for guarded_unit in "$api_unit" "$web_unit"; do
  installed_unit="${unit_directory}/${guarded_unit}"
  source_unit="${repository_directory}/deploy/systemd/${guarded_unit}"
  [[ -f "$installed_unit" && ! -L "$installed_unit" ]] ||
    fail "${guarded_unit} 当前主单元缺失或不是普通文件；拒绝无基线安装。"
  [[ "$(systemctl --user show "$guarded_unit" -p LoadState --value)" == "loaded" ]] ||
    fail "${guarded_unit} 当前未被用户服务管理器加载。"
  validate_main_unit_environment_contract "$installed_unit" "$source_unit"
  validate_drop_ins "$guarded_unit"
done

mkdir -p -- "$backup_directory"
chmod 700 -- "$backup_root" "$backup_directory"

api_was_enabled="$(read_enabled_state "$api_unit")" || fail "无法读取 API 原启用状态。"
web_was_enabled="$(read_enabled_state "$web_unit")" || fail "无法读取公网 Web 原启用状态。"
api_was_active="$(read_active_state "$api_unit")" || fail "API 不是稳定的 active/inactive 状态，拒绝安装。"
web_was_active="$(read_active_state "$web_unit")" || fail "公网 Web 不是稳定的 active/inactive 状态，拒绝安装。"

api_existed="no"
web_existed="no"
if [[ -f "${unit_directory}/${api_unit}" ]]; then
  cp --preserve=mode,timestamps -- "${unit_directory}/${api_unit}" "${backup_directory}/${api_unit}"
  api_existed="yes"
fi
if [[ -f "${unit_directory}/${web_unit}" ]]; then
  cp --preserve=mode,timestamps -- "${unit_directory}/${web_unit}" "${backup_directory}/${web_unit}"
  web_existed="yes"
fi

installation_started="no"

restore_unit() {
  local unit="$1"
  local existed="$2"
  if [[ "$existed" == "yes" ]]; then
    install -D -m "$(stat -c '%a' "${backup_directory}/${unit}")" \
      "${backup_directory}/${unit}" "${unit_directory}/${unit}"
  else
    rm -f -- "${unit_directory}/${unit}"
  fi
}

restore_runtime_state() {
  local unit="$1"
  local was_enabled="$2"
  local was_active="$3"
  case "$was_enabled" in
    enabled) systemctl --user enable "$unit" >/dev/null || return 1 ;;
    enabled-runtime)
      systemctl --user disable "$unit" >/dev/null || return 1
      systemctl --user enable --runtime "$unit" >/dev/null || return 1
      ;;
    disabled) systemctl --user disable "$unit" >/dev/null || return 1 ;;
    *) return 1 ;;
  esac
  case "$was_active" in
    active) systemctl --user restart "$unit" || return 1 ;;
    inactive) systemctl --user stop "$unit" >/dev/null || return 1 ;;
    *) return 1 ;;
  esac

  [[ "$(read_enabled_state "$unit")" == "$was_enabled" ]] || return 1
  [[ "$(read_active_state "$unit")" == "$was_active" ]] || return 1
}

rollback() {
  local rollback_failed=0
  set +e
  printf '新单元未通过校验，正在恢复原配置。\n' >&2
  restore_unit "$api_unit" "$api_existed" || rollback_failed=1
  restore_unit "$web_unit" "$web_existed" || rollback_failed=1
  systemctl --user daemon-reload || rollback_failed=1
  restore_runtime_state "$api_unit" "$api_was_enabled" "$api_was_active" || rollback_failed=1
  restore_runtime_state "$web_unit" "$web_was_enabled" "$web_was_active" || rollback_failed=1
  if [[ "$rollback_failed" -eq 0 ]]; then
    printf '原配置恢复完成；备份保留在 %s。\n' "$backup_directory" >&2
  else
    printf '原配置回滚不完整；备份保留在 %s，请保留现场。\n' "$backup_directory" >&2
  fi
  set -e
  return "$rollback_failed"
}

on_exit() {
  local exit_code=$?
  trap - EXIT
  if [[ "$exit_code" -ne 0 && "$installation_started" == "yes" ]]; then
    rollback || printf '自动回滚未完整通过，请保留现场并检查用户服务。\n' >&2
  fi
  exit "$exit_code"
}

trap on_exit EXIT

installation_started="yes"
install -D -m 600 -- "$source_api_unit" "${unit_directory}/${api_unit}"
install -D -m 644 -- "$source_web_unit" "${unit_directory}/${web_unit}"

systemctl --user daemon-reload
systemctl --user enable "$api_unit" "$web_unit" >/dev/null
systemctl --user restart "$api_unit"

api_ready="no"
for _ in $(seq 1 30); do
  if curl -fsS --max-time 3 http://127.0.0.1:8100/api/health >/dev/null 2>&1 &&
    curl -fsS --max-time 3 http://127.0.0.1:8100/api/health/production-readiness >/dev/null 2>&1; then
    api_ready="yes"
    break
  fi
  sleep 2
done
[[ "$api_ready" == "yes" ]] || fail "API 在 60 秒内未恢复健康和生产就绪。"

systemctl --user restart "$web_unit"
web_ready="no"
for _ in $(seq 1 30); do
  root_status="$(curl -sS --max-time 3 -o /dev/null -w '%{http_code}' http://10.66.66.2:5795/ || true)"
  api_status="$(curl -sS --max-time 3 -o /dev/null -w '%{http_code}' http://10.66.66.2:5795/api/health || true)"
  if [[ "$root_status" == "200" && "$api_status" == "403" ]]; then
    web_ready="yes"
    break
  fi
  sleep 2
done
[[ "$web_ready" == "yes" ]] || fail "公网 Web 在 60 秒内未恢复或来源门禁异常。"

bash "$verifier"
installation_started="no"
trap - EXIT

printf '断电自启安装完成；原单元备份保留在 %s。\n' "$backup_directory"
