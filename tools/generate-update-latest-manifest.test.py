#!/usr/bin/env python3
import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SCRIPT = ROOT / "tools" / "generate-update-latest-manifest.py"


class GenerateUpdateLatestManifestTest(unittest.TestCase):
    def test_generates_manifest_with_sha256(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            assets = Path(tmp)
            exe = assets / "GoNavi-1.2.3-Windows-Amd64-Portable.exe"
            portable_zip = assets / "GoNavi-1.2.3-Windows-Amd64-Portable.zip"
            msi = assets / "GoNavi-1.2.3-Windows-Amd64-Installer.msi"
            exe.write_bytes(b"fake-binary")
            portable_zip.write_bytes(b"fake-portable-zip")
            msi.write_bytes(b"fake-installer")
            (assets / "LICENSE").write_text("license text\n", encoding="utf-8")
            (assets / "NOTICE").write_text("notice text\n", encoding="utf-8")
            (assets / "SHA256SUMS").write_text(
                "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa  GoNavi-1.2.3-Windows-Amd64-Portable.exe\n"
                "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb  GoNavi-1.2.3-Windows-Amd64-Installer.msi\n"
                "cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc  GoNavi-1.2.3-Windows-Amd64-Portable.zip\n",
                encoding="utf-8",
            )
            out = assets / "latest.json"
            subprocess.check_call(
                [
                    sys.executable,
                    str(SCRIPT),
                    "--assets-dir",
                    str(assets),
                    "--version",
                    "1.2.3",
                    "--tag",
                    "v1.2.3",
                    "--channel",
                    "latest",
                    "--download-base-url",
                    "https://download.syngnat.top/gonavi/releases/download/",
                    "--output",
                    str(out),
                ],
                cwd=str(ROOT),
            )
            data = json.loads(out.read_text(encoding="utf-8"))
            self.assertEqual(data["schemaVersion"], 1)
            self.assertEqual(data["channel"], "latest")
            self.assertEqual(data["version"], "1.2.3")
            self.assertEqual(data["tagName"], "v1.2.3")
            assets_by_name = {asset["name"]: asset for asset in data["assets"]}
            self.assertEqual(
                set(assets_by_name),
                {
                    "GoNavi-1.2.3-Windows-Amd64-Portable.exe",
                    "GoNavi-1.2.3-Windows-Amd64-Portable.zip",
                    "GoNavi-1.2.3-Windows-Amd64-Installer.msi",
                },
            )
            portable_asset = assets_by_name["GoNavi-1.2.3-Windows-Amd64-Portable.exe"]
            self.assertEqual(
                portable_asset["url"],
                "https://download.syngnat.top/gonavi/releases/download/v1.2.3/GoNavi-1.2.3-Windows-Amd64-Portable.exe",
            )
            self.assertEqual(
                portable_asset["apiUrl"],
                "https://github.com/Syngnat/GoNavi/releases/download/v1.2.3/GoNavi-1.2.3-Windows-Amd64-Portable.exe",
            )
            self.assertEqual(portable_asset["sha256"], "a" * 64)
            portable_zip_asset = assets_by_name["GoNavi-1.2.3-Windows-Amd64-Portable.zip"]
            self.assertEqual(
                portable_zip_asset["url"],
                "https://download.syngnat.top/gonavi/releases/download/v1.2.3/GoNavi-1.2.3-Windows-Amd64-Portable.zip",
            )
            self.assertEqual(
                portable_zip_asset["apiUrl"],
                "https://github.com/Syngnat/GoNavi/releases/download/v1.2.3/GoNavi-1.2.3-Windows-Amd64-Portable.zip",
            )
            self.assertEqual(portable_zip_asset["sha256"], "c" * 64)
            installer_asset = assets_by_name["GoNavi-1.2.3-Windows-Amd64-Installer.msi"]
            self.assertEqual(
                installer_asset["url"],
                "https://download.syngnat.top/gonavi/releases/download/v1.2.3/GoNavi-1.2.3-Windows-Amd64-Installer.msi",
            )
            self.assertEqual(
                installer_asset["apiUrl"],
                "https://github.com/Syngnat/GoNavi/releases/download/v1.2.3/GoNavi-1.2.3-Windows-Amd64-Installer.msi",
            )
            self.assertEqual(installer_asset["sha256"], "b" * 64)
            self.assertNotIn("SHA256SUMS", [a["name"] for a in data["assets"]])
            self.assertNotIn("LICENSE", [a["name"] for a in data["assets"]])
            self.assertNotIn("NOTICE", [a["name"] for a in data["assets"]])

    def test_dev_manifest_keeps_github_tag_but_uses_unique_mirror_tag(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            assets = Path(tmp)
            asset_name = "GoNavi-dev-a1b2c3d-Windows-Amd64-Portable.zip"
            (assets / asset_name).write_bytes(b"fake-dev-binary")
            (assets / "SHA256SUMS").write_text(
                f"{'c' * 64}  {asset_name}\n",
                encoding="utf-8",
            )
            out = assets / "latest-dev.json"
            subprocess.check_call(
                [
                    sys.executable,
                    str(SCRIPT),
                    "--assets-dir",
                    str(assets),
                    "--version",
                    "dev-a1b2c3d",
                    "--tag",
                    "dev-latest",
                    "--channel",
                    "dev",
                    "--download-base-url",
                    "https://download.syngnat.top/gonavi/dev/releases/download",
                    "--download-tag",
                    "dev-a1b2c3d",
                    "--output",
                    str(out),
                ],
                cwd=str(ROOT),
            )

            data = json.loads(out.read_text(encoding="utf-8"))
            self.assertEqual(data["channel"], "dev")
            self.assertEqual(data["tagName"], "dev-latest")
            self.assertEqual(data["htmlUrl"], "https://github.com/Syngnat/GoNavi/releases/tag/dev-latest")
            self.assertEqual(len(data["assets"]), 1)
            asset = data["assets"][0]
            self.assertEqual(
                asset["url"],
                f"https://download.syngnat.top/gonavi/dev/releases/download/dev-a1b2c3d/{asset_name}",
            )
            self.assertEqual(
                asset["apiUrl"],
                f"https://github.com/Syngnat/GoNavi/releases/download/dev-latest/{asset_name}",
            )

    def test_embeds_release_notes_from_file(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            assets = Path(tmp)
            (assets / "GoNavi-1.2.3-Windows-Amd64-Portable.zip").write_bytes(b"fake")
            (assets / "SHA256SUMS").write_text(
                f"{'d' * 64}  GoNavi-1.2.3-Windows-Amd64-Portable.zip\n",
                encoding="utf-8",
            )
            notes = assets / "changelog.md"
            notes.write_text("## ✨ 新功能\n\n- 示例变更\n", encoding="utf-8")
            out = assets / "latest.json"
            subprocess.check_call(
                [
                    sys.executable,
                    str(SCRIPT),
                    "--assets-dir",
                    str(assets),
                    "--version",
                    "1.2.3",
                    "--tag",
                    "v1.2.3",
                    "--channel",
                    "latest",
                    "--release-notes-file",
                    str(notes),
                    "--output",
                    str(out),
                ],
                cwd=str(ROOT),
            )
            data = json.loads(out.read_text(encoding="utf-8"))
            self.assertIn("releaseNotes", data)
            self.assertIn("示例变更", data["releaseNotes"])


if __name__ == "__main__":
    unittest.main()
