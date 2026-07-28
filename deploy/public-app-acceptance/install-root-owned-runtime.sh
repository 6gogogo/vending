#!/bin/sh
# 仅供 root-owned、已核验的 Git checkout 中的 root 管理员执行；不从 VNC 用户可写目录运行。
set -eu
PATH=/usr/sbin:/usr/bin:/sbin:/bin
export PATH
umask 077

if [ "$#" -ne 0 ]; then
  /usr/bin/printf '%s\n' '安装器不接受任何参数。' >&2
  exit 64
fi

if [ "$(/usr/bin/id -u)" -ne 0 ]; then
  /usr/bin/printf '%s\n' '必须由 root 安装已封存的公网 App 验收运行器。' >&2
  exit 1
fi

SOURCE_DIR=$(CDPATH= cd -- "$(/usr/bin/dirname -- "$0")" && pwd -P)
REPOSITORY_ROOT=$(CDPATH= cd -- "$SOURCE_DIR/../.." && pwd -P)
INSTALL_PARENT=/usr/local/lib/vending-public-app-acceptance
INSTALL_ROOT=$INSTALL_PARENT/v1
WRAPPER_PATH=/usr/local/sbin/vending-public-app-acceptance-root
SUDOERS_PATH=/etc/sudoers.d/vending-public-app-acceptance
STAGING_ROOT=$INSTALL_PARENT/.v1.$$
STAGING_WRAPPER=/usr/local/sbin/.vending-public-app-acceptance-root.$$
STAGING_SUDOERS=/etc/sudoers.d/.vending-public-app-acceptance.$$

assert_root_controlled_directory_chain() {
  current_path=$1
  while :; do
    [ -d "$current_path" ] && [ ! -L "$current_path" ] || {
      /usr/bin/printf '%s\n' '目录链不是普通目录。' >&2
      exit 1
    }
    [ "$(/usr/bin/stat -c '%u:%g' -- "$current_path")" = '0:0' ] || {
      /usr/bin/printf '%s\n' '目录链不受 root 控制。' >&2
      exit 1
    }
    mode=$(/usr/bin/stat -c '%a' -- "$current_path")
    [ $((0$mode & 022)) -eq 0 ] || {
      /usr/bin/printf '%s\n' '目录链可被组或其他用户写入。' >&2
      exit 1
    }
    parent_path=$(/usr/bin/dirname -- "$current_path")
    [ "$parent_path" = "$current_path" ] && return
    current_path=$parent_path
  done
}

assert_root_regular_file() {
  file_path=$1
  expected_mode=$2
  assert_root_controlled_directory_chain "$(/usr/bin/dirname -- "$file_path")"
  [ -f "$file_path" ] && [ ! -L "$file_path" ] || {
    /usr/bin/printf '%s\n' '安装源包含非普通文件。' >&2
    exit 1
  }
  [ "$(/usr/bin/stat -c '%u:%g' -- "$file_path")" = '0:0' ] || {
    /usr/bin/printf '%s\n' '安装源文件不受 root 控制。' >&2
    exit 1
  }
  [ "$(/usr/bin/stat -c '%a' -- "$file_path")" = "$expected_mode" ] || {
    /usr/bin/printf '%s\n' '安装源文件权限不符合封存要求。' >&2
    exit 1
  }
}

cleanup_staging() {
  case "$STAGING_ROOT" in
    "$INSTALL_PARENT"/.v1.*)
      [ -e "$STAGING_ROOT" ] && /usr/bin/rm -rf -- "$STAGING_ROOT"
      ;;
  esac
  case "$STAGING_WRAPPER" in
    /usr/local/sbin/.vending-public-app-acceptance-root.*)
      [ -e "$STAGING_WRAPPER" ] && /usr/bin/rm -f -- "$STAGING_WRAPPER"
      ;;
  esac
  case "$STAGING_SUDOERS" in
    /etc/sudoers.d/.vending-public-app-acceptance.*)
      [ -e "$STAGING_SUDOERS" ] && /usr/bin/rm -f -- "$STAGING_SUDOERS"
      ;;
  esac
}

rollback_committed_install() {
  if [ "$sudoers_committed" -eq 1 ]; then
    [ ! -e "$SUDOERS_PATH" ] || /usr/bin/rm -f -- "$SUDOERS_PATH"
  fi
  if [ "$wrapper_committed" -eq 1 ]; then
    [ ! -e "$WRAPPER_PATH" ] || /usr/bin/rm -f -- "$WRAPPER_PATH"
  fi
  if [ "$runtime_committed" -eq 1 ]; then
    case "$INSTALL_ROOT" in
      "$INSTALL_PARENT"/v1)
        [ ! -e "$INSTALL_ROOT" ] || /usr/bin/rm -rf -- "$INSTALL_ROOT"
        ;;
    esac
  fi
}

cleanup_on_exit() {
  exit_status=$?
  cleanup_staging
  if [ "$install_completed" -ne 1 ]; then
    rollback_committed_install
  fi
  exit "$exit_status"
}

assert_root_controlled_directory_chain "$REPOSITORY_ROOT"
assert_root_regular_file "$SOURCE_DIR/v1/vending-public-app-acceptance-bootstrap.mjs" 644
assert_root_regular_file "$SOURCE_DIR/v1/vending-public-app-acceptance" 755
assert_root_regular_file "$SOURCE_DIR/v1/vending-public-app-acceptance.sudoers" 644
assert_root_regular_file "$REPOSITORY_ROOT/scripts/run-public-app-acceptance.mjs" 644
assert_root_regular_file "$REPOSITORY_ROOT/scripts/public-app-acceptance.mjs" 644
assert_root_regular_file "$REPOSITORY_ROOT/scripts/vnc-local-session.mjs" 644
assert_root_regular_file "$REPOSITORY_ROOT/scripts/first-backoffice-password-maintenance.mjs" 644

source_status=$(/usr/bin/git -C "$REPOSITORY_ROOT" status --porcelain --untracked-files=no)
[ -z "$source_status" ] || {
  /usr/bin/printf '%s\n' 'root 安装源存在已跟踪变更，拒绝封存。' >&2
  exit 1
}
source_commit=$(/usr/bin/git -C "$REPOSITORY_ROOT" rev-parse --verify HEAD)
/usr/bin/printf '%s' "$source_commit" | /usr/bin/grep -Eq '^[a-f0-9]{40,64}$' || {
  /usr/bin/printf '%s\n' 'root 安装源提交标识无效。' >&2
  exit 1
}

[ -x /usr/bin/node ] && [ ! -L /usr/bin/node ] || {
  /usr/bin/printf '%s\n' '必须先安装 root 管理的 /usr/bin/node。' >&2
  exit 1
}
[ "$(/usr/bin/stat -c '%u:%g' /usr/bin/node)" = '0:0' ] || {
  /usr/bin/printf '%s\n' '/usr/bin/node 不受 root 控制。' >&2
  exit 1
}
[ $((0$(/usr/bin/stat -c '%a' /usr/bin/node) & 022)) -eq 0 ] || {
  /usr/bin/printf '%s\n' '/usr/bin/node 可被组或其他用户写入。' >&2
  exit 1
}

node_major=$(/usr/bin/env -i PATH=/usr/bin:/bin LANG=C LC_ALL=C /usr/bin/node --no-addons --eval 'process.stdout.write(process.versions.node.split(".")[0])')
[ "$node_major" -ge 18 ] 2>/dev/null || {
  /usr/bin/printf '%s\n' '/usr/bin/node 必须为支持 fetch 的 Node.js 18 或更高版本。' >&2
  exit 1
}

[ ! -e "$INSTALL_ROOT" ] && [ ! -L "$INSTALL_ROOT" ] || {
  /usr/bin/printf '%s\n' '目标运行器版本已存在，拒绝覆盖。' >&2
  exit 1
}
[ ! -e "$WRAPPER_PATH" ] && [ ! -L "$WRAPPER_PATH" ] || {
  /usr/bin/printf '%s\n' '固定启动器路径已存在，拒绝覆盖。' >&2
  exit 1
}
[ ! -e "$SUDOERS_PATH" ] && [ ! -L "$SUDOERS_PATH" ] || {
  /usr/bin/printf '%s\n' '固定 sudo 规则已存在，拒绝覆盖。' >&2
  exit 1
}

/usr/bin/install -d -o root -g root -m 700 "$INSTALL_PARENT"
assert_root_controlled_directory_chain "$INSTALL_PARENT"
assert_root_controlled_directory_chain /usr/local/sbin
assert_root_controlled_directory_chain /etc/sudoers.d
runtime_committed=0
wrapper_committed=0
sudoers_committed=0
install_completed=0
trap cleanup_on_exit EXIT
trap 'exit 1' HUP INT TERM
/usr/bin/install -d -o root -g root -m 700 "$STAGING_ROOT"

/usr/bin/install -o root -g root -m 600 "$SOURCE_DIR/v1/vending-public-app-acceptance-bootstrap.mjs" "$STAGING_ROOT/vending-public-app-acceptance-bootstrap.mjs"
/usr/bin/install -o root -g root -m 600 "$REPOSITORY_ROOT/scripts/run-public-app-acceptance.mjs" "$STAGING_ROOT/run-public-app-acceptance.mjs"
/usr/bin/install -o root -g root -m 600 "$REPOSITORY_ROOT/scripts/public-app-acceptance.mjs" "$STAGING_ROOT/public-app-acceptance.mjs"
/usr/bin/install -o root -g root -m 600 "$REPOSITORY_ROOT/scripts/vnc-local-session.mjs" "$STAGING_ROOT/vnc-local-session.mjs"
/usr/bin/install -o root -g root -m 600 "$REPOSITORY_ROOT/scripts/first-backoffice-password-maintenance.mjs" "$STAGING_ROOT/first-backoffice-password-maintenance.mjs"
/usr/bin/install -o root -g root -m 750 "$SOURCE_DIR/v1/vending-public-app-acceptance" "$STAGING_WRAPPER"
/usr/bin/install -o root -g root -m 440 "$SOURCE_DIR/v1/vending-public-app-acceptance.sudoers" "$STAGING_SUDOERS"
/usr/sbin/visudo -cf "$STAGING_SUDOERS" >/dev/null

bootstrap_hash=$(/usr/bin/sha256sum "$STAGING_ROOT/vending-public-app-acceptance-bootstrap.mjs" | /usr/bin/awk '{print $1}')
run_hash=$(/usr/bin/sha256sum "$STAGING_ROOT/run-public-app-acceptance.mjs" | /usr/bin/awk '{print $1}')
flow_hash=$(/usr/bin/sha256sum "$STAGING_ROOT/public-app-acceptance.mjs" | /usr/bin/awk '{print $1}')
session_hash=$(/usr/bin/sha256sum "$STAGING_ROOT/vnc-local-session.mjs" | /usr/bin/awk '{print $1}')
logind_hash=$(/usr/bin/sha256sum "$STAGING_ROOT/first-backoffice-password-maintenance.mjs" | /usr/bin/awk '{print $1}')

/usr/bin/printf '%s\n' "{\"schema\":\"vending-public-app-acceptance-runtime/v1\",\"version\":\"v1\",\"sourceCommit\":\"$source_commit\",\"runtimeRoot\":\"/usr/local/lib/vending-public-app-acceptance/v1\",\"entrypoint\":\"vending-public-app-acceptance-bootstrap.mjs\",\"files\":{\"vending-public-app-acceptance-bootstrap.mjs\":\"$bootstrap_hash\",\"run-public-app-acceptance.mjs\":\"$run_hash\",\"public-app-acceptance.mjs\":\"$flow_hash\",\"vnc-local-session.mjs\":\"$session_hash\",\"first-backoffice-password-maintenance.mjs\":\"$logind_hash\"}}" >"$STAGING_ROOT/manifest.json"
/usr/bin/chmod 600 "$STAGING_ROOT/manifest.json"
/usr/bin/chown root:root "$STAGING_ROOT/manifest.json"
/usr/bin/sha256sum "$STAGING_ROOT/manifest.json" | /usr/bin/awk '{print $1}' >"$STAGING_ROOT/manifest.sha256"
/usr/bin/chmod 600 "$STAGING_ROOT/manifest.sha256"
/usr/bin/chown root:root "$STAGING_ROOT/manifest.sha256"

runtime_committed=1
if ! /usr/bin/mv -- "$STAGING_ROOT" "$INSTALL_ROOT"; then
  /usr/bin/printf '%s\n' '封存运行器目录落位失败。' >&2
  exit 1
fi
wrapper_committed=1
if ! /usr/bin/mv -- "$STAGING_WRAPPER" "$WRAPPER_PATH"; then
  /usr/bin/printf '%s\n' '固定启动器落位失败，已回滚。' >&2
  exit 1
fi
sudoers_committed=1
if ! /usr/bin/mv -- "$STAGING_SUDOERS" "$SUDOERS_PATH"; then
  /usr/bin/printf '%s\n' '固定 sudo 规则落位失败，已回滚。' >&2
  exit 1
fi

install_completed=1
trap - EXIT HUP INT TERM
/usr/bin/printf '%s\n' '已安装已封存的公网 App 验收运行器；仅可在 Spark VNC 本机终端通过固定 sudo 规则以零参数启动。'
