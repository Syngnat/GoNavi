#!/usr/bin/env python3
"""Tests for the checksum-driven WinGet CLI manifest generator."""

from __future__ import annotations

import importlib.util
import subprocess
import tempfile
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
SCRIPT = ROOT / "tools" / "generate-winget-cli-manifest.py"
SPEC = importlib.util.spec_from_file_location("generate_winget_cli_manifest", SCRIPT)
assert SPEC and SPEC.loader
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)


class WinGetManifestTests(unittest.TestCase):
    version = "1.2.3"

    def _write_checksums(self, directory: Path) -> Path:
        names = [
            f"gonavi-cli_{self.version}_darwin_amd64.tar.gz",
            f"gonavi-cli_{self.version}_darwin_arm64.tar.gz",
            f"gonavi-cli_{self.version}_linux_amd64.tar.gz",
            f"gonavi-cli_{self.version}_linux_arm64.tar.gz",
            f"gonavi-cli_{self.version}_windows_amd64.zip",
            f"gonavi-cli_{self.version}_windows_arm64.zip",
        ]
        path = directory / f"gonavi-cli_{self.version}_checksums.txt"
        path.write_text("".join(f"{'a' * (64 - len(str(i)))}{i}  {name}\n" for i, name in enumerate(names)), encoding="ascii")
        return path

    def test_generates_both_windows_architectures_from_checksums(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            checksums = self._write_checksums(root)
            output = root / "Syngnat.GoNavi.CLI.yaml"
            result = subprocess.run(
                [
                    "python3",
                    str(SCRIPT),
                    "--version",
                    self.version,
                    "--checksums",
                    str(checksums),
                    "--output",
                    str(output),
                ],
                text=True,
                capture_output=True,
                check=False,
            )
            self.assertEqual(result.returncode, 0, result.stderr)
            manifest = output.read_text(encoding="utf-8")
            self.assertIn("PackageIdentifier: Syngnat.GoNavi.CLI", manifest)
            self.assertIn("PackageVersion: 1.2.3", manifest)
            self.assertIn("Architecture: x64", manifest)
            self.assertIn("Architecture: arm64", manifest)
            self.assertIn("gonavi-cli_1.2.3_windows_amd64.zip", manifest)
            self.assertIn("gonavi-cli_1.2.3_windows_arm64.zip", manifest)
            self.assertEqual(manifest.count("InstallerSha256:"), 2)
            self.assertEqual(manifest.count("NestedInstallerType: portable"), 2)
            self.assertIn("NestedInstallerFiles:", manifest)
            self.assertIn("PortableCommandAlias: gonavi", manifest)

    def test_rejects_missing_or_extra_checksum_entries(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            checksums = self._write_checksums(root)
            checksums.write_text(checksums.read_text(encoding="ascii") + f"{'b' * 64}  unexpected.zip\n", encoding="ascii")
            with self.assertRaises(ValueError):
                MODULE.load_checksums(checksums, self.version)


if __name__ == "__main__":
    unittest.main()
