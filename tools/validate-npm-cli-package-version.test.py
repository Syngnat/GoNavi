#!/usr/bin/env python3
"""Tests for the stable tag/npm CLI package version contract."""

from __future__ import annotations

import importlib.util
import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
SCRIPT = ROOT / "tools" / "validate-npm-cli-package-version.py"
SPEC = importlib.util.spec_from_file_location("validate_npm_cli_package_version", SCRIPT)
assert SPEC and SPEC.loader
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)


class ValidateNpmCLIPackageVersionTests(unittest.TestCase):
    def test_current_package_matches_the_first_stable_cli_tag(self) -> None:
        package_json = ROOT / "npm" / "gonavi-cli" / "package.json"
        self.assertEqual(MODULE.validate_package_version("v0.9.6", package_json), "0.9.6")

    def test_rejects_version_drift(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            package_json = Path(temporary) / "package.json"
            package_json.write_text(
                json.dumps({"name": MODULE.PACKAGE_NAME, "version": "0.9.5"}),
                encoding="utf-8",
            )
            with self.assertRaisesRegex(ValueError, "does not match stable tag"):
                MODULE.validate_package_version("v0.9.6", package_json)

    def test_rejects_non_stable_tags(self) -> None:
        with self.assertRaisesRegex(ValueError, "stable tag must match"):
            MODULE.validate_package_version("dev-a1b2c3d", ROOT / "npm" / "gonavi-cli" / "package.json")

    def test_cli_reports_failure_for_invalid_tag(self) -> None:
        result = subprocess.run(
            [sys.executable, str(SCRIPT), "--tag", "v0.9.6-rc1"],
            text=True,
            capture_output=True,
            check=False,
        )
        self.assertEqual(result.returncode, 2)
        self.assertIn("stable tag must match", result.stderr)


if __name__ == "__main__":
    unittest.main()
