#!/usr/bin/env python3

from __future__ import annotations

import hashlib
import json
import subprocess
import sys
import tempfile
import unittest
import zipfile
from pathlib import Path


SCRIPT = Path(__file__).with_name("prepare-vps-release-payload.py")
PUBLISH_SCRIPT = SCRIPT.parents[1] / "tools/publish-edge-release.sh"
DEV_WORKFLOW = SCRIPT.parents[1] / ".github/workflows/dev-build.yml"
PUBLISH_RELEASE_WORKFLOW = SCRIPT.parents[1] / ".github/workflows/publish-release.yml"


def sha256(value: bytes) -> str:
    return hashlib.sha256(value).hexdigest()


def write_driver_archive(path: Path, entry_path: str, value: bytes) -> bytes:
    with zipfile.ZipFile(path, "w", compression=zipfile.ZIP_DEFLATED) as archive:
        archive.writestr(entry_path, value)
    return path.read_bytes()


def driver_index(
    archive_name: str,
    archive_bytes: bytes,
    entry_name: str,
    entry_path: str,
    entry_bytes: bytes,
) -> dict[str, object]:
    return {
        "assets": {archive_name: len(archive_bytes)},
        "assetSha256": {archive_name: sha256(archive_bytes)},
        "entries": {
            entry_name: {
                "archive": archive_name,
                "path": entry_path,
                "size": len(entry_bytes),
                "sha256": sha256(entry_bytes),
            }
        },
    }


class PrepareVPSReleasePayloadTest(unittest.TestCase):
    def run_script(self, *args: str) -> subprocess.CompletedProcess[str]:
        return subprocess.run(
            [sys.executable, str(SCRIPT), *args],
            check=False,
            capture_output=True,
            text=True,
        )

    def test_builds_stable_app_and_driver_payload(self) -> None:
        with tempfile.TemporaryDirectory() as temporary_directory:
            root = Path(temporary_directory)
            app_dir = root / "app"
            driver_dir = root / "driver"
            app_dir.mkdir()
            driver_dir.mkdir()

            app_bytes = b"portable zip"
            (app_dir / "GoNavi.zip").write_bytes(app_bytes)
            app_manifest = app_dir / "latest.json"
            app_manifest.write_text(
                json.dumps(
                    {
                        "tagName": "v1.2.3",
                        "assets": [
                            {
                                "name": "GoNavi.zip",
                                "size": len(app_bytes),
                                "sha256": sha256(app_bytes),
                            }
                        ],
                    }
                ),
                encoding="utf-8",
            )

            driver_entry_bytes = b"driver binary"
            driver_entry_name = "mysql-driver-agent-windows-amd64.exe"
            driver_entry_path = f"Windows/{driver_entry_name}"
            driver_name = "mysql-driver-agent-windows-amd64.zip"
            driver_bytes = write_driver_archive(
                driver_dir / driver_name,
                driver_entry_path,
                driver_entry_bytes,
            )
            (driver_dir / "mysql-driver-agent-windows-amd64.exe").write_bytes(b"raw driver")
            (driver_dir / "GoNavi-DriverAgents.zip").write_bytes(b"CI bundle")
            index = driver_index(
                driver_name,
                driver_bytes,
                driver_entry_name,
                driver_entry_path,
                driver_entry_bytes,
            )
            version_index = driver_dir / "version-index.json"
            latest_index = driver_dir / "latest-index.json"
            version_index.write_text(
                json.dumps({**index, "tagName": "v1.2.3"}),
                encoding="utf-8",
            )
            latest_index.write_text(
                json.dumps(
                    {
                        **index,
                        "tagName": "latest",
                        "mirrorTagName": "v1.2.3",
                    }
                ),
                encoding="utf-8",
            )

            output = root / "output"
            result = self.run_script(
                "--channel",
                "stable",
                "--app-tag",
                "v1.2.3",
                "--app-dir",
                str(app_dir),
                "--app-manifest",
                str(app_manifest),
                "--driver-tag",
                "v1.2.3",
                "--driver-dir",
                str(driver_dir),
                "--driver-version-index",
                str(version_index),
                "--driver-latest-index",
                str(latest_index),
                "--output",
                str(output),
            )
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertTrue(
                (output / "payload/gonavi/releases/download/v1.2.3/GoNavi.zip").is_file()
            )
            self.assertTrue(
                (output / "payload/gonavi/releases/latest/latest.json").is_file()
            )
            self.assertTrue(
                (
                    output
                    / f"payload/drivers/releases/download/v1.2.3/{driver_name}"
                ).is_file()
            )
            self.assertFalse(
                (
                    output
                    / "payload/drivers/releases/download/v1.2.3/mysql-driver-agent-windows-amd64.exe"
                ).exists()
            )
            self.assertFalse(
                (
                    output
                    / "payload/drivers/releases/download/v1.2.3/GoNavi-DriverAgents.zip"
                ).exists()
            )
            self.assertTrue(
                (
                    output
                    / "payload/drivers/releases/latest/GoNavi-DriverAgents-Index.json"
                ).is_file()
            )
            metadata = json.loads((output / "deployment.json").read_text())
            self.assertTrue(metadata["driverEnabled"])
            self.assertGreater(metadata["payloadBytes"], 0)
            self.assertEqual(
                len((output / "SHA256SUMS").read_text().splitlines()),
                metadata["fileCount"],
            )

    def test_rejects_non_zip_driver_asset_in_index(self) -> None:
        with tempfile.TemporaryDirectory() as temporary_directory:
            root = Path(temporary_directory)
            app_dir = root / "app"
            driver_dir = root / "driver"
            app_dir.mkdir()
            driver_dir.mkdir()

            app_bytes = b"portable zip"
            (app_dir / "GoNavi.zip").write_bytes(app_bytes)
            app_manifest = app_dir / "latest.json"
            app_manifest.write_text(
                json.dumps(
                    {
                        "tagName": "v1.2.3",
                        "assets": [
                            {
                                "name": "GoNavi.zip",
                                "size": len(app_bytes),
                                "sha256": sha256(app_bytes),
                            }
                        ],
                    }
                ),
                encoding="utf-8",
            )

            raw_name = "mysql-driver-agent-windows-amd64.exe"
            raw_bytes = b"raw driver"
            (driver_dir / raw_name).write_bytes(raw_bytes)
            index = {
                "assets": {raw_name: len(raw_bytes)},
                "assetSha256": {raw_name: sha256(raw_bytes)},
                "entries": {
                    raw_name: {
                        "archive": raw_name,
                        "path": f"Windows/{raw_name}",
                        "size": len(raw_bytes),
                        "sha256": sha256(raw_bytes),
                    }
                },
            }
            version_index = driver_dir / "version-index.json"
            latest_index = driver_dir / "latest-index.json"
            version_index.write_text(json.dumps(index), encoding="utf-8")
            latest_index.write_text(json.dumps(index), encoding="utf-8")

            result = self.run_script(
                "--channel",
                "stable",
                "--app-tag",
                "v1.2.3",
                "--app-dir",
                str(app_dir),
                "--app-manifest",
                str(app_manifest),
                "--driver-tag",
                "v1.2.3",
                "--driver-dir",
                str(driver_dir),
                "--driver-version-index",
                str(version_index),
                "--driver-latest-index",
                str(latest_index),
                "--output",
                str(root / "output"),
            )

            self.assertNotEqual(result.returncode, 0)
            self.assertIn("driver mirror asset must be a zip archive", result.stderr)

    def test_rejects_driver_archive_sha256_mismatch(self) -> None:
        with tempfile.TemporaryDirectory() as temporary_directory:
            root = Path(temporary_directory)
            app_dir = root / "app"
            driver_dir = root / "driver"
            app_dir.mkdir()
            driver_dir.mkdir()

            app_bytes = b"portable zip"
            (app_dir / "GoNavi.zip").write_bytes(app_bytes)
            app_manifest = app_dir / "latest.json"
            app_manifest.write_text(
                json.dumps(
                    {
                        "tagName": "v1.2.3",
                        "assets": [
                            {
                                "name": "GoNavi.zip",
                                "size": len(app_bytes),
                                "sha256": sha256(app_bytes),
                            }
                        ],
                    }
                ),
                encoding="utf-8",
            )

            entry_name = "mysql-driver-agent-windows-amd64.exe"
            entry_path = f"Windows/{entry_name}"
            archive_name = "mysql-driver-agent-windows-amd64.zip"
            entry_bytes = b"driver binary"
            archive_bytes = write_driver_archive(
                driver_dir / archive_name,
                entry_path,
                entry_bytes,
            )
            index = driver_index(
                archive_name,
                archive_bytes,
                entry_name,
                entry_path,
                entry_bytes,
            )
            index["assetSha256"] = {archive_name: "0" * 64}
            version_index = driver_dir / "version-index.json"
            latest_index = driver_dir / "latest-index.json"
            version_index.write_text(json.dumps(index), encoding="utf-8")
            latest_index.write_text(json.dumps(index), encoding="utf-8")

            result = self.run_script(
                "--channel",
                "stable",
                "--app-tag",
                "v1.2.3",
                "--app-dir",
                str(app_dir),
                "--app-manifest",
                str(app_manifest),
                "--driver-tag",
                "v1.2.3",
                "--driver-dir",
                str(driver_dir),
                "--driver-version-index",
                str(version_index),
                "--driver-latest-index",
                str(latest_index),
                "--output",
                str(root / "output"),
            )

            self.assertNotEqual(result.returncode, 0)
            self.assertIn("driver asset sha256 mismatch", result.stderr)

    def test_rejects_driver_index_metadata_drift_outside_tags(self) -> None:
        with tempfile.TemporaryDirectory() as temporary_directory:
            root = Path(temporary_directory)
            app_dir = root / "app"
            driver_dir = root / "driver"
            app_dir.mkdir()
            driver_dir.mkdir()

            app_bytes = b"portable zip"
            (app_dir / "GoNavi.zip").write_bytes(app_bytes)
            app_manifest = app_dir / "latest.json"
            app_manifest.write_text(
                json.dumps(
                    {
                        "tagName": "v1.2.3",
                        "assets": [
                            {
                                "name": "GoNavi.zip",
                                "size": len(app_bytes),
                                "sha256": sha256(app_bytes),
                            }
                        ],
                    }
                ),
                encoding="utf-8",
            )

            entry_name = "mysql-driver-agent-windows-amd64.exe"
            entry_path = f"Windows/{entry_name}"
            archive_name = "mysql-driver-agent-windows-amd64.zip"
            entry_bytes = b"driver binary"
            archive_bytes = write_driver_archive(
                driver_dir / archive_name,
                entry_path,
                entry_bytes,
            )
            version_payload = driver_index(
                archive_name,
                archive_bytes,
                entry_name,
                entry_path,
                entry_bytes,
            )
            latest_payload = json.loads(json.dumps(version_payload))
            latest_payload["entries"][entry_name]["path"] = f"Linux/{entry_name}"
            version_index = driver_dir / "version-index.json"
            latest_index = driver_dir / "latest-index.json"
            version_index.write_text(
                json.dumps({**version_payload, "tagName": "v1.2.3"}),
                encoding="utf-8",
            )
            latest_index.write_text(
                json.dumps(
                    {
                        **latest_payload,
                        "tagName": "latest",
                        "mirrorTagName": "v1.2.3",
                    }
                ),
                encoding="utf-8",
            )

            result = self.run_script(
                "--channel",
                "stable",
                "--app-tag",
                "v1.2.3",
                "--app-dir",
                str(app_dir),
                "--app-manifest",
                str(app_manifest),
                "--driver-tag",
                "v1.2.3",
                "--driver-dir",
                str(driver_dir),
                "--driver-version-index",
                str(version_index),
                "--driver-latest-index",
                str(latest_index),
                "--output",
                str(root / "output"),
            )

            self.assertNotEqual(result.returncode, 0)
            self.assertIn("driver version and latest indexes differ outside tag metadata", result.stderr)

    def test_rejects_windows_drive_absolute_driver_entry_path(self) -> None:
        with tempfile.TemporaryDirectory() as temporary_directory:
            root = Path(temporary_directory)
            app_dir = root / "app"
            driver_dir = root / "driver"
            app_dir.mkdir()
            driver_dir.mkdir()

            app_bytes = b"portable zip"
            (app_dir / "GoNavi.zip").write_bytes(app_bytes)
            app_manifest = app_dir / "latest.json"
            app_manifest.write_text(
                json.dumps(
                    {
                        "tagName": "v1.2.3",
                        "assets": [
                            {
                                "name": "GoNavi.zip",
                                "size": len(app_bytes),
                                "sha256": sha256(app_bytes),
                            }
                        ],
                    }
                ),
                encoding="utf-8",
            )

            entry_name = "mysql-driver-agent-windows-amd64.exe"
            entry_path = f"Windows/{entry_name}"
            archive_name = "mysql-driver-agent-windows-amd64.zip"
            entry_bytes = b"driver binary"
            archive_bytes = write_driver_archive(
                driver_dir / archive_name,
                entry_path,
                entry_bytes,
            )
            index = driver_index(
                archive_name,
                archive_bytes,
                entry_name,
                f"C:/{entry_name}",
                entry_bytes,
            )
            version_index = driver_dir / "version-index.json"
            latest_index = driver_dir / "latest-index.json"
            version_index.write_text(json.dumps(index), encoding="utf-8")
            latest_index.write_text(json.dumps(index), encoding="utf-8")

            result = self.run_script(
                "--channel",
                "stable",
                "--app-tag",
                "v1.2.3",
                "--app-dir",
                str(app_dir),
                "--app-manifest",
                str(app_manifest),
                "--driver-tag",
                "v1.2.3",
                "--driver-dir",
                str(driver_dir),
                "--driver-version-index",
                str(version_index),
                "--driver-latest-index",
                str(latest_index),
                "--output",
                str(root / "output"),
            )

            self.assertNotEqual(result.returncode, 0)
            self.assertIn("invalid driver version index driver entry", result.stderr)

    def test_rejects_manifest_path_traversal(self) -> None:
        with tempfile.TemporaryDirectory() as temporary_directory:
            root = Path(temporary_directory)
            app_dir = root / "app"
            app_dir.mkdir()
            app_manifest = app_dir / "latest-dev.json"
            app_manifest.write_text(
                json.dumps(
                    {
                        "channel": "dev",
                        "version": "dev-abc123",
                        "assets": [
                            {
                                "name": "../GoNavi.zip",
                                "size": 0,
                                "sha256": sha256(b""),
                            }
                        ],
                    }
                ),
                encoding="utf-8",
            )
            result = self.run_script(
                "--channel",
                "dev",
                "--app-tag",
                "dev-abc123",
                "--app-dir",
                str(app_dir),
                "--app-manifest",
                str(app_manifest),
                "--output",
                str(root / "output"),
            )
            self.assertNotEqual(result.returncode, 0)
            self.assertIn("invalid app asset name", result.stderr)

    def test_publish_script_reads_remote_capacity_with_posix_df(self) -> None:
        source = PUBLISH_SCRIPT.read_text(encoding="utf-8")

        self.assertIn("df -Pk '${root}'", source)
        self.assertNotIn("--output=avail", source)
        self.assertIn("available_kib", source)
        self.assertIn("available_kib * 1024", source)

    def test_publish_script_requires_explicit_driver_mode_and_controlled_staging(self) -> None:
        source = PUBLISH_SCRIPT.read_text(encoding="utf-8")

        self.assertIn("PUB_DRIVER_ENABLED", source)
        self.assertIn('case "${PUB_DRIVER_ENABLED}"', source)
        self.assertIn("trap cleanup EXIT", source)
        self.assertIn(".gonavi-mirror-root", source)
        self.assertIn("gonavi-edge-transaction", source)

    def test_publish_script_only_requires_driver_parity_for_driver_releases(self) -> None:
        source = PUBLISH_SCRIPT.read_text(encoding="utf-8")

        self.assertIn(
            'if [[ "${PUB_DRIVER_ENABLED}" == true && "${cst_driver_tag}" != "${bero_driver_tag}" ]]; then',
            source,
        )
        self.assertIn(
            'if [[ "${PUB_DRIVER_ENABLED}" == true && "${cst_driver_tag}" != "${PUB_DRIVER_TAG}" ]]; then',
            source,
        )

    def test_workflows_pass_explicit_driver_mode(self) -> None:
        dev_source = DEV_WORKFLOW.read_text(encoding="utf-8")
        stable_source = PUBLISH_RELEASE_WORKFLOW.read_text(encoding="utf-8")

        self.assertIn(
            "driver-enabled: ${{ steps.driver_assets.outputs.has_driver_assets }}",
            dev_source,
        )
        self.assertIn("id: mirror_payload", stable_source)
        self.assertIn(
            'echo "has_driver_release=${has_driver_release}" >> "$GITHUB_OUTPUT"',
            stable_source,
        )
        self.assertIn(
            "driver-enabled: ${{ steps.mirror_payload.outputs.has_driver_release }}",
            stable_source,
        )


if __name__ == "__main__":
    unittest.main()
