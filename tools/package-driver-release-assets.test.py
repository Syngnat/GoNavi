#!/usr/bin/env python3

import hashlib
import json
import subprocess
import sys
import tempfile
import unittest
import zipfile
from pathlib import Path


ROOT = Path(__file__).resolve().parent.parent
SCRIPT = ROOT / "tools" / "package-driver-release-assets.py"
sys.path.insert(0, str(ROOT / "tools"))

from driver_bundle_7z import _run, extract_members, list_members  # noqa: E402


def bundle_methods(bundle_path):
    proc = _run(["l", "-slt", str(bundle_path)], bundle_path.parent)
    methods = {}
    path = ""
    for line in proc.stdout.splitlines():
        key, sep, value = line.partition(" = ")
        if not sep:
            continue
        if key == "Path":
            path = value.replace("\\", "/")
        elif key == "Method" and path:
            methods[path] = value
    return methods


class PackageDriverReleaseAssetsTest(unittest.TestCase):
    def test_packages_ci_bundle_and_individual_archives_without_raw_assets(self):
        with tempfile.TemporaryDirectory(prefix="gonavi-driver-assets-test-") as tmp:
            tmpdir = Path(tmp)
            drivers_dir = tmpdir / "drivers"
            output_dir = tmpdir / "driver-release-assets"
            (drivers_dir / "Windows").mkdir(parents=True)
            (drivers_dir / "MacOS").mkdir(parents=True)

            windows_asset = drivers_dir / "Windows" / "clickhouse-driver-agent-windows-amd64.exe"
            darwin_asset = drivers_dir / "MacOS" / "clickhouse-driver-agent-darwin-arm64"
            windows_asset.write_bytes(b"windows-asset")
            darwin_asset.write_bytes(b"darwin-asset")

            proc = subprocess.run(
                ["python3", str(SCRIPT), str(drivers_dir), str(output_dir)],
                cwd=ROOT,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                text=True,
                check=True,
            )

            self.assertIn("created GoNavi-DriverAgents.7z", proc.stdout)
            self.assertTrue((output_dir / "GoNavi-DriverAgents.7z").is_file())
            self.assertFalse((output_dir / "GoNavi-DriverAgents.zip").exists())
            windows_archive = output_dir / "clickhouse-driver-agent-windows-amd64.zip"
            darwin_archive = output_dir / "clickhouse-driver-agent-darwin-arm64.zip"
            self.assertTrue(windows_archive.is_file())
            self.assertTrue(darwin_archive.is_file())
            self.assertFalse((output_dir / windows_asset.name).exists())
            self.assertFalse((output_dir / darwin_asset.name).exists())
            self.assertEqual((output_dir / "LICENSE").read_bytes(), (ROOT / "LICENSE").read_bytes())
            self.assertEqual((output_dir / "NOTICE").read_bytes(), (ROOT / "NOTICE").read_bytes())

            index = json.loads((output_dir / "GoNavi-DriverAgents-Index.json").read_text(encoding="utf-8"))
            self.assertEqual(set(index), {"assets", "assetSha256", "entries"})
            self.assertEqual(
                index["assets"],
                {
                    windows_archive.name: windows_archive.stat().st_size,
                    darwin_archive.name: darwin_archive.stat().st_size,
                },
            )
            self.assertEqual(
                index["assetSha256"],
                {
                    windows_archive.name: hashlib.sha256(windows_archive.read_bytes()).hexdigest(),
                    darwin_archive.name: hashlib.sha256(darwin_archive.read_bytes()).hexdigest(),
                },
            )
            self.assertEqual(
                index["entries"],
                {
                    windows_asset.name: {
                        "archive": windows_archive.name,
                        "path": "Windows/clickhouse-driver-agent-windows-amd64.exe",
                        "size": len(b"windows-asset"),
                        "sha256": hashlib.sha256(b"windows-asset").hexdigest(),
                    },
                    darwin_asset.name: {
                        "archive": darwin_archive.name,
                        "path": "MacOS/clickhouse-driver-agent-darwin-arm64",
                        "size": len(b"darwin-asset"),
                        "sha256": hashlib.sha256(b"darwin-asset").hexdigest(),
                    },
                },
            )
            self.assertNotIn("GoNavi-DriverAgents.7z", index["assets"])
            self.assertNotIn("GoNavi-DriverAgents.7z", index["assetSha256"])

            with zipfile.ZipFile(windows_archive) as zf:
                self.assertEqual(
                    sorted(zf.namelist()),
                    [
                        "LICENSE",
                        "NOTICE",
                        "Windows/clickhouse-driver-agent-windows-amd64.exe",
                    ],
                )
                self.assertEqual(
                    zf.read("Windows/clickhouse-driver-agent-windows-amd64.exe"),
                    b"windows-asset",
                )

            with zipfile.ZipFile(darwin_archive) as zf:
                self.assertEqual(
                    sorted(zf.namelist()),
                    [
                        "LICENSE",
                        "MacOS/clickhouse-driver-agent-darwin-arm64",
                        "NOTICE",
                    ],
                )
                self.assertEqual(
                    zf.read("MacOS/clickhouse-driver-agent-darwin-arm64"),
                    b"darwin-asset",
                )

            bundle = output_dir / "GoNavi-DriverAgents.7z"
            self.assertEqual(
                sorted(list_members(bundle)),
                [
                    "LICENSE",
                    "MacOS/clickhouse-driver-agent-darwin-arm64",
                    "NOTICE",
                    "Windows/clickhouse-driver-agent-windows-amd64.exe",
                ],
            )
            extracted = tmpdir / "extracted"
            extract_members(bundle, list_members(bundle), extracted)
            self.assertEqual((extracted / "LICENSE").read_bytes(), (ROOT / "LICENSE").read_bytes())
            self.assertEqual((extracted / "NOTICE").read_bytes(), (ROOT / "NOTICE").read_bytes())
            self.assertEqual(
                (extracted / "Windows" / "clickhouse-driver-agent-windows-amd64.exe").read_bytes(),
                b"windows-asset",
            )
            self.assertEqual(
                (extracted / "MacOS" / "clickhouse-driver-agent-darwin-arm64").read_bytes(),
                b"darwin-asset",
            )

            # The app decodes the bundle with github.com/bodgit/sevenzip: x86 BCJ is
            # supported there, the ARM64 branch filter is not.
            methods = bundle_methods(bundle)
            self.assertIn("BCJ", methods["Windows/clickhouse-driver-agent-windows-amd64.exe"])
            for member, method in methods.items():
                self.assertIn("LZMA2", method, member)
                self.assertNotIn("ARM64", method, member)

    def test_rebuilds_duckdb_windows_archive_with_agent_and_library(self):
        with tempfile.TemporaryDirectory(prefix="gonavi-driver-assets-test-") as tmp:
            tmpdir = Path(tmp)
            drivers_dir = tmpdir / "drivers"
            output_dir = tmpdir / "driver-release-assets"
            windows_dir = drivers_dir / "Windows"
            windows_dir.mkdir(parents=True)

            agent = windows_dir / "duckdb-driver-agent-windows-amd64.exe"
            library = windows_dir / "duckdb.dll"
            agent.write_bytes(b"duckdb-agent")
            library.write_bytes(b"duckdb-library")
            (windows_dir / "duckdb-driver.zip").write_bytes(b"stale-source-package")

            subprocess.run(
                ["python3", str(SCRIPT), str(drivers_dir), str(output_dir)],
                cwd=ROOT,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                text=True,
                check=True,
            )

            archive = output_dir / "duckdb-driver-agent-windows-amd64.zip"
            self.assertTrue(archive.is_file())
            self.assertFalse((output_dir / agent.name).exists())
            self.assertFalse((output_dir / library.name).exists())
            index = json.loads((output_dir / "GoNavi-DriverAgents-Index.json").read_text(encoding="utf-8"))
            self.assertEqual(index["assets"], {archive.name: archive.stat().st_size})
            self.assertEqual(
                index["assetSha256"],
                {archive.name: hashlib.sha256(archive.read_bytes()).hexdigest()},
            )
            self.assertEqual(
                index["entries"],
                {
                    agent.name: {
                        "archive": archive.name,
                        "path": "Windows/duckdb-driver-agent-windows-amd64.exe",
                        "size": len(b"duckdb-agent"),
                        "sha256": hashlib.sha256(b"duckdb-agent").hexdigest(),
                    },
                    library.name: {
                        "archive": archive.name,
                        "path": "Windows/duckdb.dll",
                        "size": len(b"duckdb-library"),
                        "sha256": hashlib.sha256(b"duckdb-library").hexdigest(),
                    },
                },
            )

            with zipfile.ZipFile(archive) as zf:
                self.assertEqual(
                    sorted(zf.namelist()),
                    [
                        "LICENSE",
                        "NOTICE",
                        "Windows/duckdb-driver-agent-windows-amd64.exe",
                        "Windows/duckdb.dll",
                    ],
                )
                self.assertEqual(
                    zf.read("Windows/duckdb-driver-agent-windows-amd64.exe"),
                    b"duckdb-agent",
                )
                self.assertEqual(zf.read("Windows/duckdb.dll"), b"duckdb-library")

            bundle_members = list_members(output_dir / "GoNavi-DriverAgents.7z")
            self.assertNotIn("Windows/duckdb-driver.zip", bundle_members)
            self.assertIn("Windows/duckdb.dll", bundle_members)


if __name__ == "__main__":
    unittest.main()
