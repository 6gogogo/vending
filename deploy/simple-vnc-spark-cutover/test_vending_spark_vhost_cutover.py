"""Fixture tests for the fixed VNC vhost rewrite, without root or Nginx."""

from __future__ import annotations

import importlib.util
import sys
import unittest
from pathlib import Path
from unittest.mock import patch


sys.dont_write_bytecode = True


DIRECTORY = Path(__file__).resolve().parent
SPEC = importlib.util.spec_from_file_location(
    "vending_spark_vhost_cutover", DIRECTORY / "vending_spark_vhost_cutover.py"
)
assert SPEC and SPEC.loader
CUTOVER = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(CUTOVER)


FIXTURE = """server {
    listen 443 ssl http2;
    server_name vending.5gogogo.top;

    location ^~ /api/ {
        proxy_set_header Host $host;
        proxy_pass http://127.0.0.1:4000;
        proxy_read_timeout 60s;
    }

    location / {
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_pass http://127.0.0.1:5795;
        try_files $uri @fallback;
    }
}
"""


class TransformVhostTests(unittest.TestCase):
    def test_rewrites_only_the_two_direct_upstreams(self) -> None:
        result = CUTOVER.transform_vhost(FIXTURE)

        self.assertEqual(result.count("listen 443 ssl http2;"), 1)
        self.assertEqual(result.count("proxy_pass http://10.66.66.2:5795;"), 2)
        self.assertIn("proxy_set_header Host $host;", result)
        self.assertIn("proxy_read_timeout 60s;", result)
        self.assertIn("proxy_set_header X-Forwarded-Proto $scheme;", result)
        self.assertIn("try_files $uri @fallback;", result)
        self.assertNotIn("proxy_pass http://127.0.0.1:4000;", result)
        self.assertNotIn("proxy_pass http://127.0.0.1:5795;", result)

    def test_rejects_duplicate_required_location(self) -> None:
        duplicate = FIXTURE.replace(
            "    location / {",
            "    location / {\n        proxy_pass http://127.0.0.1:5795;\n    }\n\n    location / {",
            1,
        )
        with self.assertRaises(CUTOVER.CutoverError):
            CUTOVER.transform_vhost(duplicate)

    def test_rejects_missing_direct_proxy_pass(self) -> None:
        missing = FIXTURE.replace("        proxy_pass http://127.0.0.1:4000;\n", "", 1)
        with self.assertRaises(CUTOVER.CutoverError):
            CUTOVER.transform_vhost(missing)

    def test_reviewed_preimage_and_fixed_target_are_pinned(self) -> None:
        self.assertEqual(
            CUTOVER.EXPECTED_VHOST_SHA256,
            "3b9c64f5bc394ff2b79ff7dd56076267ded9e772e25b547523d3025063ceaab5",
        )
        self.assertEqual(
            CUTOVER.VHOST.as_posix(), "/etc/nginx/sites-available/vending.5gogogo.top"
        )
        self.assertEqual(CUTOVER.SPARK_BASE_URL, "http://10.66.66.2:5795")

    def test_rollback_rechecks_the_enabled_target_before_reading_state(self) -> None:
        with (
            patch.object(CUTOVER, "ensure_root") as ensure_root,
            patch.object(CUTOVER, "assert_secure_installation") as assert_secure_installation,
            patch.object(CUTOVER, "ensure_state_dir") as ensure_state_dir,
            patch.object(CUTOVER, "assert_root_owned_directory_chain") as assert_directory_chain,
            patch.object(CUTOVER, "assert_enabled_vhost_target") as assert_enabled_target,
            patch.object(
                CUTOVER,
                "read_manifest",
                side_effect=CUTOVER.CutoverError("stop before filesystem writes"),
            ) as read_manifest,
        ):
            with self.assertRaises(CUTOVER.CutoverError):
                CUTOVER.rollback()

        ensure_root.assert_called_once_with()
        assert_secure_installation.assert_called_once_with()
        ensure_state_dir.assert_called_once_with()
        assert_directory_chain.assert_called_once_with(CUTOVER.VHOST)
        assert_enabled_target.assert_called_once_with()
        read_manifest.assert_called_once_with()


if __name__ == "__main__":
    unittest.main()
