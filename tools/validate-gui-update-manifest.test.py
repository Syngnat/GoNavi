#!/usr/bin/env python3

from __future__ import annotations

import hashlib
import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from urllib.parse import urlencode


ROOT = Path(__file__).resolve().parents[1]
SCRIPT = ROOT / "tools" / "validate-gui-update-manifest.py"
PUBLISH_WORKFLOW = ROOT / ".github" / "workflows" / "publish-release.yml"
DEV_WORKFLOW = ROOT / ".github" / "workflows" / "dev-build.yml"
MIRROR_ACTION = ROOT / ".github" / "actions" / "publish-vps-mirror" / "action.yml"
MIRROR_BASES = {
    "stable": "https://download.syngnat.top/gonavi/releases/download",
    "dev": "https://download.syngnat.top/gonavi/dev/releases/download",
}
GITHUB_BASE = "https://github.com/Syngnat/GoNavi/releases/download"


def sha256(value: bytes) -> str:
    return hashlib.sha256(value).hexdigest()


class ValidateGUIUpdateManifestTest(unittest.TestCase):
    def write_manifest(
        self,
        root: Path,
        *,
        channel: str,
        app_tag: str,
        asset_name: str,
        asset_bytes: bytes,
        dispatcher: bool = False,
    ) -> tuple[Path, Path]:
        app_dir = root / "app-assets"
        app_dir.mkdir()
        (app_dir / asset_name).write_bytes(asset_bytes)

        if channel == "stable":
            manifest_channel = "latest"
            tag_name = app_tag
            version = app_tag.removeprefix("v")
        else:
            manifest_channel = "dev"
            tag_name = "dev-latest"
            version = app_tag

        asset_url = f"{MIRROR_BASES[channel]}/{app_tag}/{asset_name}"
        if dispatcher:
            prefix = "/gonavi/releases/download" if channel == "stable" else "/gonavi/dev/releases/download"
            asset_url = (
                "https://download-dispatch.syngnat.top/v1/resolve?"
                + urlencode({"path": f"{prefix}/{app_tag}/{asset_name}"})
            )
        manifest = {
            "schemaVersion": 1,
            "component": "gui",
            "channel": manifest_channel,
            "tagName": tag_name,
            "version": version,
            "htmlUrl": f"https://github.com/Syngnat/GoNavi/releases/tag/{tag_name}",
            "assets": [
                {
                    "name": asset_name,
                    "url": asset_url,
                    "apiUrl": f"{GITHUB_BASE}/{tag_name}/{asset_name}",
                    "size": len(asset_bytes),
                    "sha256": sha256(asset_bytes),
                }
            ],
        }
        manifest_path = root / ("latest.json" if channel == "stable" else "latest-dev.json")
        manifest_path.write_text(json.dumps(manifest), encoding="utf-8")
        return app_dir, manifest_path

    def run_validator(
        self,
        *,
        channel: str,
        app_tag: str,
        app_dir: Path,
        manifest_path: Path,
        dispatcher: bool = False,
    ) -> subprocess.CompletedProcess[str]:
        command = [
                sys.executable,
                str(SCRIPT),
                "--channel",
                channel,
                "--app-tag",
                app_tag,
                "--app-dir",
                str(app_dir),
                "--manifest",
                str(manifest_path),
                "--github-repository",
                "Syngnat/GoNavi",
            ]
        if dispatcher:
            prefix = "/gonavi/releases/download" if channel == "stable" else "/gonavi/dev/releases/download"
            command.extend(
                [
                    "--download-dispatcher-url",
                    "https://download-dispatch.syngnat.top/v1/resolve",
                    "--download-path-prefix",
                    prefix,
                ]
            )
        return subprocess.run(
            command,
            cwd=str(ROOT),
            check=False,
            capture_output=True,
            text=True,
        )

    def test_accepts_stable_gui_manifest(self) -> None:
        with tempfile.TemporaryDirectory() as temporary_directory:
            root = Path(temporary_directory)
            app_dir, manifest_path = self.write_manifest(
                root,
                channel="stable",
                app_tag="v1.2.3",
                asset_name="GoNavi-1.2.3-MacOS-Arm64.dmg",
                asset_bytes=b"signed-dmg",
            )

            result = self.run_validator(
                channel="stable",
                app_tag="v1.2.3",
                app_dir=app_dir,
                manifest_path=manifest_path,
            )

            self.assertEqual(result.returncode, 0, result.stderr)

    def test_accepts_stable_gui_manifest_with_dispatcher(self) -> None:
        with tempfile.TemporaryDirectory() as temporary_directory:
            root = Path(temporary_directory)
            app_dir, manifest_path = self.write_manifest(
                root,
                channel="stable",
                app_tag="v1.2.3",
                asset_name="GoNavi-1.2.3-Windows-Amd64-Portable.exe",
                asset_bytes=b"signed-portable",
                dispatcher=True,
            )

            result = self.run_validator(
                channel="stable",
                app_tag="v1.2.3",
                app_dir=app_dir,
                manifest_path=manifest_path,
                dispatcher=True,
            )

            self.assertEqual(result.returncode, 0, result.stderr)

    def test_accepts_dev_gui_manifest(self) -> None:
        with tempfile.TemporaryDirectory() as temporary_directory:
            root = Path(temporary_directory)
            app_dir, manifest_path = self.write_manifest(
                root,
                channel="dev",
                app_tag="dev-a1b2c3d",
                asset_name="GoNavi-dev-a1b2c3d-Linux-Amd64.tar.gz",
                asset_bytes=b"linux-tarball",
            )

            result = self.run_validator(
                channel="dev",
                app_tag="dev-a1b2c3d",
                app_dir=app_dir,
                manifest_path=manifest_path,
            )

            self.assertEqual(result.returncode, 0, result.stderr)

    def test_rejects_stable_manifest_without_latest_channel(self) -> None:
        with tempfile.TemporaryDirectory() as temporary_directory:
            root = Path(temporary_directory)
            app_dir, manifest_path = self.write_manifest(
                root,
                channel="stable",
                app_tag="v1.2.3",
                asset_name="GoNavi-1.2.3-MacOS-Amd64.dmg",
                asset_bytes=b"signed-dmg",
            )
            manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
            manifest["channel"] = "dev"
            manifest_path.write_text(json.dumps(manifest), encoding="utf-8")

            result = self.run_validator(
                channel="stable",
                app_tag="v1.2.3",
                app_dir=app_dir,
                manifest_path=manifest_path,
            )

            self.assertNotEqual(result.returncode, 0)
            self.assertIn("stable GUI manifest channel must be 'latest'", result.stderr)

    def test_rejects_non_cli_asset_outside_gui_allowlist(self) -> None:
        with tempfile.TemporaryDirectory() as temporary_directory:
            root = Path(temporary_directory)
            app_dir, manifest_path = self.write_manifest(
                root,
                channel="stable",
                app_tag="v1.2.3",
                asset_name="GoNavi-1.2.3-SupportBundle.tar.gz",
                asset_bytes=b"not-a-desktop-package",
            )

            result = self.run_validator(
                channel="stable",
                app_tag="v1.2.3",
                app_dir=app_dir,
                manifest_path=manifest_path,
            )

            self.assertNotEqual(result.returncode, 0)
            self.assertIn("not an allowed GUI release asset", result.stderr)

    def test_rejects_local_asset_hash_mismatch(self) -> None:
        with tempfile.TemporaryDirectory() as temporary_directory:
            root = Path(temporary_directory)
            app_dir, manifest_path = self.write_manifest(
                root,
                channel="stable",
                app_tag="v1.2.3",
                asset_name="GoNavi-1.2.3-Windows-Amd64-Portable.exe",
                asset_bytes=b"original-binary",
            )
            (app_dir / "GoNavi-1.2.3-Windows-Amd64-Portable.exe").write_bytes(
                b"tampered-binary"
            )

            result = self.run_validator(
                channel="stable",
                app_tag="v1.2.3",
                app_dir=app_dir,
                manifest_path=manifest_path,
            )

            self.assertNotEqual(result.returncode, 0)
            self.assertIn("GUI manifest asset sha256 mismatch", result.stderr)

    def test_release_and_mirror_paths_run_the_validator(self) -> None:
        publish = PUBLISH_WORKFLOW.read_text(encoding="utf-8")
        dev = DEV_WORKFLOW.read_text(encoding="utf-8")
        mirror = MIRROR_ACTION.read_text(encoding="utf-8")

        self.assertIn("tools/validate-gui-update-manifest.py", publish)
        self.assertIn("--channel stable", publish)
        self.assertIn("tools/validate-gui-update-manifest.py", dev)
        self.assertIn("--channel dev", dev)
        self.assertIn("tools/validate-gui-update-manifest.py", mirror)
        self.assertIn('--channel "${PUB_CHANNEL}"', mirror)
        self.assertIn("--download-dispatcher-url", publish)
        self.assertIn("--download-dispatcher-url", dev)
        self.assertIn("--download-dispatcher-url", mirror)


if __name__ == "__main__":
    unittest.main()
