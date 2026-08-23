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
                    "--download-dispatcher-url",
                    "https://download-dispatch.syngnat.top/v1/resolve",
                    "--download-path-prefix",
                    "/gonavi/releases/download",
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
                "https://download-dispatch.syngnat.top/v1/resolve?path=%2Fgonavi%2Freleases%2Fdownload%2Fv1.2.3%2FGoNavi-1.2.3-Windows-Amd64-Portable.exe",
            )
            self.assertEqual(
                portable_asset["apiUrl"],
                "https://github.com/Syngnat/GoNavi/releases/download/v1.2.3/GoNavi-1.2.3-Windows-Amd64-Portable.exe",
            )
            self.assertEqual(portable_asset["sha256"], "a" * 64)
            portable_zip_asset = assets_by_name["GoNavi-1.2.3-Windows-Amd64-Portable.zip"]
            self.assertEqual(
                portable_zip_asset["url"],
                "https://download-dispatch.syngnat.top/v1/resolve?path=%2Fgonavi%2Freleases%2Fdownload%2Fv1.2.3%2FGoNavi-1.2.3-Windows-Amd64-Portable.zip",
            )
            self.assertEqual(
                portable_zip_asset["apiUrl"],
                "https://github.com/Syngnat/GoNavi/releases/download/v1.2.3/GoNavi-1.2.3-Windows-Amd64-Portable.zip",
            )
            self.assertEqual(portable_zip_asset["sha256"], "c" * 64)
            installer_asset = assets_by_name["GoNavi-1.2.3-Windows-Amd64-Installer.msi"]
            self.assertEqual(
                installer_asset["url"],
                "https://download-dispatch.syngnat.top/v1/resolve?path=%2Fgonavi%2Freleases%2Fdownload%2Fv1.2.3%2FGoNavi-1.2.3-Windows-Amd64-Installer.msi",
            )
            self.assertEqual(
                installer_asset["apiUrl"],
                "https://github.com/Syngnat/GoNavi/releases/download/v1.2.3/GoNavi-1.2.3-Windows-Amd64-Installer.msi",
            )
            self.assertEqual(installer_asset["sha256"], "b" * 64)
            self.assertNotIn("SHA256SUMS", [a["name"] for a in data["assets"]])
            self.assertNotIn("LICENSE", [a["name"] for a in data["assets"]])
            self.assertNotIn("NOTICE", [a["name"] for a in data["assets"]])

    def test_gui_manifest_excludes_cli_archives_and_unrecognized_files(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            assets = Path(tmp)
            gui_name = "GoNavi-1.2.3-MacOS-Arm64.dmg"
            cli_name = "gonavi-cli_1.2.3_darwin_arm64.tar.gz"
            unexpected_name = "GoNavi-1.2.3-Linux-Amd64-unknown.bin"
            for name in (gui_name, cli_name, unexpected_name):
                (assets / name).write_bytes(name.encode("ascii"))
            (assets / "SHA256SUMS").write_text(
                f"{'a' * 64}  {gui_name}\n",
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
                    "--component",
                    "gui",
                    "--output",
                    str(out),
                ],
                cwd=str(ROOT),
            )
            data = json.loads(out.read_text(encoding="utf-8"))
            self.assertEqual(data["component"], "gui")
            self.assertEqual([asset["name"] for asset in data["assets"]], [gui_name])
            self.assertEqual(data["assets"][0]["sha256"], "a" * 64)

    def test_gui_manifest_excludes_assets_from_other_versions(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            assets = Path(tmp)
            current = "GoNavi-1.2.3-MacOS-Arm64.dmg"
            stale = "GoNavi-1.2.2-MacOS-Arm64.dmg"
            (assets / current).write_bytes(b"current")
            (assets / stale).write_bytes(b"stale")
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
                    "--output",
                    str(out),
                ],
                cwd=str(ROOT),
            )
            data = json.loads(out.read_text(encoding="utf-8"))
            self.assertEqual(data["component"], "gui")
            self.assertEqual([asset["name"] for asset in data["assets"]], [current])

    def test_cli_manifest_accepts_only_cli_archive_contract(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            assets = Path(tmp)
            cli_names = (
                "gonavi-cli_1.2.3_darwin_amd64.tar.gz",
                "gonavi-cli_1.2.3_windows_arm64.zip",
            )
            for name in cli_names:
                (assets / name).write_bytes(name.encode("ascii"))
            (assets / "gonavi-cli_1.2.3_linux_amd64.exe").write_bytes(b"invalid")
            (assets / "SHA256SUMS").write_text("", encoding="ascii")
            out = assets / "latest-cli.json"
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
                    "--component",
                    "cli",
                    "--output",
                    str(out),
                ],
                cwd=str(ROOT),
            )
            data = json.loads(out.read_text(encoding="utf-8"))
            self.assertEqual(data["component"], "cli")
            self.assertEqual([asset["name"] for asset in data["assets"]], list(cli_names))

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
                    "--download-dispatcher-url",
                    "https://download-dispatch.syngnat.top/v1/resolve",
                    "--download-path-prefix",
                    "/gonavi/dev/releases/download",
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
                f"https://download-dispatch.syngnat.top/v1/resolve?path=%2Fgonavi%2Fdev%2Freleases%2Fdownload%2Fdev-a1b2c3d%2F{asset_name}",
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
