#!/bin/sh
# 仅升级已经由本项目 v1 安装的封存运行器；保留 v1，原子切换固定启动器至 v2。
set -eu
PATH=/usr/sbin:/usr/bin:/sbin:/bin
export PATH
umask 077

if [ "$#" -ne 0 ]; then
  /usr/bin/printf '%s\n' '升级器不接受任何参数。' >&2
  exit 64
fi

if [ "$(/usr/bin/id -u)" -ne 0 ]; then
  /usr/bin/printf '%s\n' '必须由 root 升级已封存的公网 App 验收运行器。' >&2
  exit 1
fi

SOURCE_DIR=$(CDPATH= cd -- "$(/usr/bin/dirname -- "$0")" && pwd -P)
REPOSITORY_ROOT=$(CDPATH= cd -- "$SOURCE_DIR/../.." && pwd -P)
INSTALL_PARENT=/usr/local/lib/vending-public-app-acceptance
V1_ROOT=$INSTALL_PARENT/v1
V2_ROOT=$INSTALL_PARENT/v2
WRAPPER_PATH=/usr/local/sbin/vending-public-app-acceptance-root
WRAPPER_BACKUP=$INSTALL_PARENT/v1-wrapper-before-v2
SUDOERS_PATH=/etc/sudoers.d/vending-public-app-acceptance
STAGING_ROOT=$INSTALL_PARENT/.v2.$$
STAGING_WRAPPER=/usr/local/sbin/.vending-public-app-acceptance-root.v2.$$

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
    /usr/bin/printf '%s\n' '封存源或既有运行器包含非普通文件。' >&2
    exit 1
  }
  [ "$(/usr/bin/stat -c '%u:%g' -- "$file_path")" = '0:0' ] || {
    /usr/bin/printf '%s\n' '封存源或既有运行器文件不受 root 控制。' >&2
    exit 1
  }
  [ "$(/usr/bin/stat -c '%a' -- "$file_path")" = "$expected_mode" ] || {
    /usr/bin/printf '%s\n' '封存源或既有运行器文件权限不符合要求。' >&2
    exit 1
  }
}

assert_root_private_runtime_directory() {
  directory_path=$1
  assert_root_controlled_directory_chain "$directory_path"
  [ "$(/usr/bin/stat -c '%a' -- "$directory_path")" = '700' ] || {
    /usr/bin/printf '%s\n' '既有封存运行器目录权限不符合要求。' >&2
    exit 1
  }
}

cleanup_staging() {
  case "$STAGING_ROOT" in
    "$INSTALL_PARENT"/.v2.*)
      [ -e "$STAGING_ROOT" ] && /usr/bin/rm -rf -- "$STAGING_ROOT"
      ;;
  esac
  case "$STAGING_WRAPPER" in
    /usr/local/sbin/.vending-public-app-acceptance-root.v2.*)
      [ -e "$STAGING_WRAPPER" ] && /usr/bin/rm -f -- "$STAGING_WRAPPER"
      ;;
  esac
}

rollback_committed_upgrade() {
  if [ "$wrapper_committed" -eq 1 ]; then
    [ ! -e "$WRAPPER_PATH" ] || /usr/bin/rm -f -- "$WRAPPER_PATH"
  fi
  if [ "$previous_wrapper_moved" -eq 1 ] && [ -f "$WRAPPER_BACKUP" ]; then
    /usr/bin/mv -- "$WRAPPER_BACKUP" "$WRAPPER_PATH" || {
      /usr/bin/printf '%s\n' '固定启动器回滚失败，需要 root 管理员处理。' >&2
      return 1
    }
  fi
  if [ "$runtime_committed" -eq 1 ]; then
    case "$V2_ROOT" in
      "$INSTALL_PARENT"/v2)
        [ ! -e "$V2_ROOT" ] || /usr/bin/rm -rf -- "$V2_ROOT"
        ;;
    esac
  fi
}

cleanup_on_exit() {
  exit_status=$?
  cleanup_staging
  if [ "$upgrade_completed" -ne 1 ]; then
    rollback_committed_upgrade || exit_status=1
  fi
  exit "$exit_status"
}

assert_root_controlled_directory_chain "$REPOSITORY_ROOT"
assert_root_regular_file "$SOURCE_DIR/v1/vending-public-app-acceptance-bootstrap.mjs" 644
assert_root_regular_file "$SOURCE_DIR/v1/vending-public-app-acceptance" 755
assert_root_regular_file "$SOURCE_DIR/v2/vending-public-app-acceptance" 755
assert_root_regular_file "$REPOSITORY_ROOT/scripts/run-public-app-acceptance.mjs" 644
assert_root_regular_file "$REPOSITORY_ROOT/scripts/public-app-acceptance.mjs" 644
assert_root_regular_file "$REPOSITORY_ROOT/scripts/vnc-local-session.mjs" 644
assert_root_regular_file "$REPOSITORY_ROOT/scripts/first-backoffice-password-maintenance.mjs" 644

source_status=$(/usr/bin/git -C "$REPOSITORY_ROOT" status --porcelain --untracked-files=no)
[ -z "$source_status" ] || {
  /usr/bin/printf '%s\n' 'root 升级源存在已跟踪变更，拒绝封存。' >&2
  exit 1
}
source_commit=$(/usr/bin/git -C "$REPOSITORY_ROOT" rev-parse --verify HEAD)
/usr/bin/printf '%s' "$source_commit" | /usr/bin/grep -Eq '^[a-f0-9]{40,64}$' || {
  /usr/bin/printf '%s\n' 'root 升级源提交标识无效。' >&2
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

assert_root_private_runtime_directory "$V1_ROOT"
assert_root_regular_file "$V1_ROOT/vending-public-app-acceptance-bootstrap.mjs" 600
assert_root_regular_file "$V1_ROOT/run-public-app-acceptance.mjs" 600
assert_root_regular_file "$V1_ROOT/public-app-acceptance.mjs" 600
assert_root_regular_file "$V1_ROOT/vnc-local-session.mjs" 600
assert_root_regular_file "$V1_ROOT/first-backoffice-password-maintenance.mjs" 600
assert_root_regular_file "$V1_ROOT/manifest.json" 600
assert_root_regular_file "$V1_ROOT/manifest.sha256" 600
assert_root_regular_file "$WRAPPER_PATH" 750
assert_root_regular_file "$SUDOERS_PATH" 440

expected_wrapper_hash=$(/usr/bin/sha256sum "$SOURCE_DIR/v1/vending-public-app-acceptance" | /usr/bin/awk '{print $1}')
actual_wrapper_hash=$(/usr/bin/sha256sum "$WRAPPER_PATH" | /usr/bin/awk '{print $1}')
[ "$actual_wrapper_hash" = "$expected_wrapper_hash" ] || {
  /usr/bin/printf '%s\n' '既有固定启动器不是受支持的 v1，拒绝替换。' >&2
  exit 1
}
expected_sudoers_hash=$(/usr/bin/sha256sum "$SOURCE_DIR/v1/vending-public-app-acceptance.sudoers" | /usr/bin/awk '{print $1}')
actual_sudoers_hash=$(/usr/bin/sha256sum "$SUDOERS_PATH" | /usr/bin/awk '{print $1}')
[ "$actual_sudoers_hash" = "$expected_sudoers_hash" ] || {
  /usr/bin/printf '%s\n' '既有固定 sudo 规则不是受支持的 v1，拒绝替换。' >&2
  exit 1
}

[ ! -e "$V2_ROOT" ] && [ ! -L "$V2_ROOT" ] || {
  /usr/bin/printf '%s\n' 'v2 封存运行器已存在，拒绝覆盖。' >&2
  exit 1
}
[ ! -e "$WRAPPER_BACKUP" ] && [ ! -L "$WRAPPER_BACKUP" ] || {
  /usr/bin/printf '%s\n' '既有固定启动器备份已存在，拒绝覆盖。' >&2
  exit 1
}

assert_root_private_runtime_directory "$INSTALL_PARENT"
assert_root_controlled_directory_chain /usr/local/sbin
runtime_committed=0
previous_wrapper_moved=0
wrapper_committed=0
upgrade_completed=0
trap cleanup_on_exit EXIT
trap 'exit 1' HUP INT TERM
/usr/bin/install -d -o root -g root -m 700 "$STAGING_ROOT"

/usr/bin/install -o root -g root -m 600 "$SOURCE_DIR/v1/vending-public-app-acceptance-bootstrap.mjs" "$STAGING_ROOT/vending-public-app-acceptance-bootstrap.mjs"
/usr/bin/install -o root -g root -m 600 "$REPOSITORY_ROOT/scripts/run-public-app-acceptance.mjs" "$STAGING_ROOT/run-public-app-acceptance.mjs"
/usr/bin/install -o root -g root -m 600 "$REPOSITORY_ROOT/scripts/public-app-acceptance.mjs" "$STAGING_ROOT/public-app-acceptance.mjs"
/usr/bin/install -o root -g root -m 600 "$REPOSITORY_ROOT/scripts/vnc-local-session.mjs" "$STAGING_ROOT/vnc-local-session.mjs"
/usr/bin/install -o root -g root -m 600 "$REPOSITORY_ROOT/scripts/first-backoffice-password-maintenance.mjs" "$STAGING_ROOT/first-backoffice-password-maintenance.mjs"
/usr/bin/install -o root -g root -m 750 "$SOURCE_DIR/v2/vending-public-app-acceptance" "$STAGING_WRAPPER"

bootstrap_hash=$(/usr/bin/sha256sum "$STAGING_ROOT/vending-public-app-acceptance-bootstrap.mjs" | /usr/bin/awk '{print $1}')
run_hash=$(/usr/bin/sha256sum "$STAGING_ROOT/run-public-app-acceptance.mjs" | /usr/bin/awk '{print $1}')
flow_hash=$(/usr/bin/sha256sum "$STAGING_ROOT/public-app-acceptance.mjs" | /usr/bin/awk '{print $1}')
session_hash=$(/usr/bin/sha256sum "$STAGING_ROOT/vnc-local-session.mjs" | /usr/bin/awk '{print $1}')
logind_hash=$(/usr/bin/sha256sum "$STAGING_ROOT/first-backoffice-password-maintenance.mjs" | /usr/bin/awk '{print $1}')

/usr/bin/printf '%s\n' "{\"schema\":\"vending-public-app-acceptance-runtime/v2\",\"version\":\"v2\",\"sourceCommit\":\"$source_commit\",\"runtimeRoot\":\"/usr/local/lib/vending-public-app-acceptance/v2\",\"entrypoint\":\"vending-public-app-acceptance-bootstrap.mjs\",\"files\":{\"vending-public-app-acceptance-bootstrap.mjs\":\"$bootstrap_hash\",\"run-public-app-acceptance.mjs\":\"$run_hash\",\"public-app-acceptance.mjs\":\"$flow_hash\",\"vnc-local-session.mjs\":\"$session_hash\",\"first-backoffice-password-maintenance.mjs\":\"$logind_hash\"}}" >"$STAGING_ROOT/manifest.json"
/usr/bin/chmod 600 "$STAGING_ROOT/manifest.json"
/usr/bin/chown root:root "$STAGING_ROOT/manifest.json"
/usr/bin/sha256sum "$STAGING_ROOT/manifest.json" | /usr/bin/awk '{print $1}' >"$STAGING_ROOT/manifest.sha256"
/usr/bin/chmod 600 "$STAGING_ROOT/manifest.sha256"
/usr/bin/chown root:root "$STAGING_ROOT/manifest.sha256"

if ! /usr/bin/mv -- "$STAGING_ROOT" "$V2_ROOT"; then
  /usr/bin/printf '%s\n' 'v2 封存运行器目录落位失败。' >&2
  exit 1
fi
runtime_committed=1
if ! /usr/bin/mv -- "$WRAPPER_PATH" "$WRAPPER_BACKUP"; then
  /usr/bin/printf '%s\n' '固定启动器备份失败，已回滚。' >&2
  exit 1
fi
previous_wrapper_moved=1
if ! /usr/bin/mv -- "$STAGING_WRAPPER" "$WRAPPER_PATH"; then
  /usr/bin/printf '%s\n' 'v2 固定启动器落位失败，已回滚。' >&2
  exit 1
fi
wrapper_committed=1

upgrade_completed=1
trap - EXIT HUP INT TERM
/usr/bin/printf '%s\n' '已升级已封存的公网 App 验收运行器至 v2；v1 和原固定启动器备份均已保留，仍只允许 Spark VNC 本机零参数启动。'
