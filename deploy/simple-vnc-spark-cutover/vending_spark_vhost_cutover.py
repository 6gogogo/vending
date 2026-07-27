#!/usr/bin/env python3
"""Fixed, root-only cutover for the vending HTTPS vhost.

This program deliberately has no configurable target, upstream, or vhost path.
The two zero-argument wrappers in this directory select its only two actions:
apply and rollback.  It is intended to be installed as a root-owned file before
either wrapper is used; running a checkout copy as root is intentionally
rejected.
"""

from __future__ import annotations

import hashlib
import json
import os
import re
import stat
import subprocess
import sys
import tempfile
from datetime import datetime, timezone
from pathlib import Path


VHOST = Path("/etc/nginx/sites-available/vending.5gogogo.top")
ENABLED_VHOST = Path("/etc/nginx/sites-enabled/vending.5gogogo.top")
EXPECTED_VHOST_SHA256 = "3b9c64f5bc394ff2b79ff7dd56076267ded9e772e25b547523d3025063ceaab5"
SPARK_BASE_URL = "http://10.66.66.2:5795"
STATE_DIR = Path("/var/lib/vending-spark-vhost-cutover")
MANIFEST = STATE_DIR / "current.json"
INSTALLED_PROGRAM = Path(
    "/usr/local/lib/vending-spark-vhost-cutover/vending_spark_vhost_cutover.py"
)
NGINX = "/usr/sbin/nginx"
SYSTEMCTL = "/usr/bin/systemctl"


class CutoverError(RuntimeError):
    """An expected, non-secret operational refusal."""


def sha256_bytes(content: bytes) -> str:
    return hashlib.sha256(content).hexdigest()


def ensure_root() -> None:
    if os.geteuid() != 0:
        raise CutoverError("root is required")


def assert_root_owned_regular(path: Path) -> os.stat_result:
    try:
        details = path.lstat()
    except FileNotFoundError as error:
        raise CutoverError("required file is absent") from error

    if not stat.S_ISREG(details.st_mode):
        raise CutoverError("required path is not a regular file")
    if details.st_uid != 0 or details.st_gid != 0:
        raise CutoverError("required file is not root owned")
    if details.st_mode & 0o022:
        raise CutoverError("required file is writable by group or others")
    return details


def assert_root_owned_directory_chain(path: Path) -> None:
    """Reject a root program or target that sits below a writable directory."""
    current = path.parent
    while True:
        try:
            details = current.lstat()
        except FileNotFoundError as error:
            raise CutoverError("required directory is absent") from error
        if (
            not stat.S_ISDIR(details.st_mode)
            or details.st_uid != 0
            or details.st_gid != 0
            or details.st_mode & 0o022
        ):
            raise CutoverError("required directory chain is not root controlled")
        if current == current.parent:
            return
        current = current.parent


def assert_enabled_vhost_target() -> None:
    try:
        if not ENABLED_VHOST.is_symlink() or ENABLED_VHOST.resolve(strict=True) != VHOST:
            raise CutoverError("enabled vending vhost does not point to the fixed target")
    except OSError as error:
        raise CutoverError("enabled vending vhost cannot be verified") from error


def assert_secure_installation() -> None:
    actual = Path(__file__).resolve()
    if actual != INSTALLED_PROGRAM:
        raise CutoverError("program is not running from its fixed installed path")
    assert_root_owned_directory_chain(INSTALLED_PROGRAM)
    assert_root_owned_regular(INSTALLED_PROGRAM)


def ensure_state_dir() -> None:
    STATE_DIR.mkdir(mode=0o700, parents=True, exist_ok=True)
    details = STATE_DIR.lstat()
    if not stat.S_ISDIR(details.st_mode) or details.st_uid != 0 or details.st_gid != 0:
        raise CutoverError("state directory is not a root-owned directory")
    if details.st_mode & 0o077:
        raise CutoverError("state directory has unsafe permissions")


def sync_directory(directory: Path) -> None:
    descriptor = os.open(directory, os.O_RDONLY)
    try:
        os.fsync(descriptor)
    finally:
        os.close(descriptor)


def write_atomic(path: Path, content: bytes, *, uid: int, gid: int, mode: int) -> None:
    descriptor, temporary_name = tempfile.mkstemp(prefix=f".{path.name}.", dir=path.parent)
    temporary_path = Path(temporary_name)
    try:
        with os.fdopen(descriptor, "wb") as temporary:
            temporary.write(content)
            temporary.flush()
            os.fsync(temporary.fileno())
        os.chown(temporary_path, uid, gid)
        os.chmod(temporary_path, mode)
        os.replace(temporary_path, path)
        sync_directory(path.parent)
    except BaseException:
        try:
            temporary_path.unlink(missing_ok=True)
        except OSError:
            pass
        raise


def find_matching_brace(text: str, opening_brace: int) -> int:
    depth = 0
    quote: str | None = None
    escaped = False
    comment = False

    for index in range(opening_brace, len(text)):
        character = text[index]
        if comment:
            if character in "\r\n":
                comment = False
            continue
        if quote:
            if escaped:
                escaped = False
            elif character == "\\":
                escaped = True
            elif character == quote:
                quote = None
            continue
        if character == "#":
            comment = True
        elif character in "'\"":
            quote = character
        elif character == "{":
            depth += 1
        elif character == "}":
            depth -= 1
            if depth == 0:
                return index
            if depth < 0:
                break

    raise CutoverError("location block has no matching closing brace")


def brace_depth_at(text: str, end: int) -> int:
    depth = 0
    quote: str | None = None
    escaped = False
    comment = False

    for character in text[:end]:
        if comment:
            if character in "\r\n":
                comment = False
            continue
        if quote:
            if escaped:
                escaped = False
            elif character == "\\":
                escaped = True
            elif character == quote:
                quote = None
            continue
        if character == "#":
            comment = True
        elif character in "'\"":
            quote = character
        elif character == "{":
            depth += 1
        elif character == "}":
            depth -= 1
    return depth


def locate_single_location(text: str, pattern: re.Pattern[str]) -> tuple[int, int]:
    matches = list(pattern.finditer(text))
    if len(matches) != 1:
        raise CutoverError("required location is not unique")
    match = matches[0]
    opening_brace = text.find("{", match.start(), match.end())
    if opening_brace < 0:
        raise CutoverError("location header has no opening brace")
    return opening_brace, find_matching_brace(text, opening_brace)


DIRECT_PROXY_PASS = re.compile(r"(?m)^(?P<indent>[ \t]*)proxy_pass[ \t]+[^;\r\n]*;")
API_LOCATION = re.compile(r"(?m)^[ \t]*location[ \t]+\^~[ \t]+/api/[ \t]*\{")
ROOT_LOCATION = re.compile(r"(?m)^[ \t]*location[ \t]+/[ \t]*\{")


def direct_proxy_pass_span(text: str, body_start: int, body_end: int) -> tuple[int, int, str]:
    body = text[body_start:body_end]
    candidates = [
        match
        for match in DIRECT_PROXY_PASS.finditer(body)
        if brace_depth_at(body, match.start()) == 0
    ]
    if len(candidates) != 1:
        raise CutoverError("location does not have exactly one direct proxy_pass")
    candidate = candidates[0]
    return (
        body_start + candidate.start(),
        body_start + candidate.end(),
        candidate.group("indent"),
    )


def transform_vhost(text: str) -> str:
    """Replace only the direct proxy_pass line in the two fixed locations."""
    locations = [
        locate_single_location(text, API_LOCATION),
        locate_single_location(text, ROOT_LOCATION),
    ]
    replacements: list[tuple[int, int, str]] = []
    for opening_brace, closing_brace in locations:
        start, end, indentation = direct_proxy_pass_span(text, opening_brace + 1, closing_brace)
        replacements.append((start, end, f"{indentation}proxy_pass {SPARK_BASE_URL};"))

    result = text
    for start, end, replacement in sorted(replacements, reverse=True):
        result = f"{result[:start]}{replacement}{result[end:]}"

    for pattern in (API_LOCATION, ROOT_LOCATION):
        opening_brace, closing_brace = locate_single_location(result, pattern)
        _start, _end, _indentation = direct_proxy_pass_span(result, opening_brace + 1, closing_brace)
        if result[_start:_end].strip() != f"proxy_pass {SPARK_BASE_URL};":
            raise CutoverError("rewritten location has an unexpected proxy_pass")
    return result


def request_is_200(path: str) -> bool:
    completed = subprocess.run(
        [
            "/usr/bin/curl",
            "--connect-timeout",
            "3",
            "--max-time",
            "5",
            "--silent",
            "--show-error",
            "--output",
            "/dev/null",
            "--write-out",
            "%{http_code}",
            f"{SPARK_BASE_URL}{path}",
        ],
        check=False,
        stderr=subprocess.DEVNULL,
        stdout=subprocess.PIPE,
    )
    return completed.returncode == 0 and completed.stdout.decode("ascii", "ignore") == "200"


def assert_spark_is_ready() -> None:
    if not request_is_200("/"):
        raise CutoverError("Spark root health check did not return 200")
    if not request_is_200("/api/health"):
        raise CutoverError("Spark API health check did not return 200")


def nginx_test() -> bool:
    return (
        subprocess.run(
            [NGINX, "-t"],
            check=False,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
        ).returncode
        == 0
    )


def nginx_reload() -> bool:
    return (
        subprocess.run(
            [SYSTEMCTL, "reload", "nginx"],
            check=False,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
        ).returncode
        == 0
    )


def write_manifest(content: dict[str, object]) -> None:
    serialized = (json.dumps(content, sort_keys=True, separators=(",", ":")) + "\n").encode("utf-8")
    write_atomic(MANIFEST, serialized, uid=0, gid=0, mode=0o600)


def read_manifest() -> dict[str, object]:
    assert_root_owned_regular(MANIFEST)
    if MANIFEST.stat().st_mode & 0o077:
        raise CutoverError("manifest has unsafe permissions")
    try:
        content = json.loads(MANIFEST.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as error:
        raise CutoverError("manifest is invalid") from error
    if not isinstance(content, dict):
        raise CutoverError("manifest is invalid")
    return content


def backup_vhost(source: bytes, details: os.stat_result) -> tuple[Path, int]:
    timestamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    backup = STATE_DIR / f"vhost-before-spark-{timestamp}.conf"
    if backup.exists():
        raise CutoverError("backup path already exists")
    mode = stat.S_IMODE(details.st_mode)
    write_atomic(backup, source, uid=0, gid=0, mode=0o600)
    return backup, mode


def restore_content(content: bytes, *, mode: int) -> None:
    write_atomic(VHOST, content, uid=0, gid=0, mode=mode)


def attempt_restore(content: bytes, *, mode: int) -> bool:
    try:
        restore_content(content, mode=mode)
        tested = nginx_test()
        reloaded = nginx_reload() if tested else False
        return tested and reloaded
    except OSError:
        return False


def apply() -> None:
    ensure_root()
    assert_secure_installation()
    ensure_state_dir()
    assert_root_owned_directory_chain(VHOST)
    assert_enabled_vhost_target()
    details = assert_root_owned_regular(VHOST)
    original = VHOST.read_bytes()
    if sha256_bytes(original) != EXPECTED_VHOST_SHA256:
        raise CutoverError("vhost hash does not match the reviewed preimage")
    if MANIFEST.exists():
        raise CutoverError("a cutover state already exists")

    try:
        rewritten = transform_vhost(original.decode("utf-8"))
    except UnicodeDecodeError as error:
        raise CutoverError("vhost is not valid UTF-8 text") from error
    replacement = rewritten.encode("utf-8")
    if replacement == original:
        raise CutoverError("vhost replacement has no effect")

    print("stage=spark-health result=starting")
    assert_spark_is_ready()
    print("stage=spark-health result=ok")

    backup, original_mode = backup_vhost(original, details)
    backup_hash = sha256_bytes(original)
    print("stage=backup result=ok")

    replaced = False
    try:
        restore_content(replacement, mode=original_mode)
        replaced = True
        print("stage=replace result=ok")
        if not nginx_test():
            raise CutoverError("nginx configuration test failed")
        print("stage=nginx-test result=ok")
        if not nginx_reload():
            raise CutoverError("nginx reload failed")
        print("stage=nginx-reload result=ok")
        write_manifest(
            {
                "backup": backup.name,
                "backup_sha256": backup_hash,
                "cutover_sha256": sha256_bytes(replacement),
                "mode": original_mode,
                "schema": "vending-spark-vhost-cutover/v1",
            }
        )
        print("stage=cutover result=ok")
    except BaseException:
        if replaced:
            print("stage=automatic-restore result=starting")
            restored = attempt_restore(original, mode=original_mode)
            print(f"stage=automatic-restore result={'ok' if restored else 'failed'}")
        raise


def rollback() -> None:
    ensure_root()
    assert_secure_installation()
    ensure_state_dir()
    assert_root_owned_directory_chain(VHOST)
    assert_enabled_vhost_target()
    manifest = read_manifest()
    if manifest.get("schema") != "vending-spark-vhost-cutover/v1":
        raise CutoverError("manifest schema is unsupported")
    backup_name = manifest.get("backup")
    backup_hash = manifest.get("backup_sha256")
    cutover_hash = manifest.get("cutover_sha256")
    original_mode = manifest.get("mode")
    if (
        not isinstance(backup_name, str)
        or not re.fullmatch(r"vhost-before-spark-[0-9]{8}T[0-9]{6}Z\.conf", backup_name)
        or not isinstance(backup_hash, str)
        or not isinstance(cutover_hash, str)
        or not isinstance(original_mode, int)
    ):
        raise CutoverError("manifest fields are invalid")
    backup = STATE_DIR / backup_name
    if backup.parent != STATE_DIR or not backup.exists():
        raise CutoverError("backup is unavailable")
    assert_root_owned_regular(backup)
    original = backup.read_bytes()
    if sha256_bytes(original) != backup_hash:
        raise CutoverError("backup hash does not match the manifest")
    current_details = assert_root_owned_regular(VHOST)
    current = VHOST.read_bytes()
    if sha256_bytes(current) != cutover_hash:
        raise CutoverError("vhost has drifted since cutover")
    current_mode = stat.S_IMODE(current_details.st_mode)

    replaced = False
    try:
        restore_content(original, mode=original_mode)
        replaced = True
        print("stage=rollback-replace result=ok")
        if not nginx_test():
            raise CutoverError("nginx configuration test failed")
        print("stage=rollback-nginx-test result=ok")
        if not nginx_reload():
            raise CutoverError("nginx reload failed")
        print("stage=rollback-nginx-reload result=ok")
        print("stage=rollback result=ok")
    except BaseException:
        if replaced:
            print("stage=automatic-restore result=starting")
            restored = attempt_restore(current, mode=current_mode)
            print(f"stage=automatic-restore result={'ok' if restored else 'failed'}")
        raise


def main(arguments: list[str]) -> int:
    try:
        if arguments == ["apply"]:
            apply()
        elif arguments == ["rollback"]:
            rollback()
        else:
            raise CutoverError("unsupported action")
    except (CutoverError, OSError, subprocess.SubprocessError):
        print("stage=cutover result=failed", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
