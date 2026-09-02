#!/usr/bin/env python3

from __future__ import annotations

import hashlib
import json
import os
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
PREPARE = ROOT / "tools" / "prepare-vps-release-payload.py"
TRANSACTION = ROOT / "tools" / "edge-release-transaction.py"


class EdgeReleaseTransactionTest(unittest.TestCase):
    def prepare(self, temporary: Path) -> tuple[Path, Path]:
        assets = temporary / "assets"
        assets.mkdir()
        payload = b"verified-edge-asset"
        asset_name = "GoNavi-v1.2.3-Test.zip"
        (assets / asset_name).write_bytes(payload)
        manifest = assets / "latest.json"
        manifest.write_text(json.dumps({
            "schemaVersion": 1,
            "channel": "latest",
            "tagName": "v1.2.3",
            "version": "1.2.3",
            "assets": [{
                "name": asset_name,
                "url": "https://download-dispatch.syngnat.top/v1/resolve?path=test",
                "size": len(payload),
                "sha256": hashlib.sha256(payload).hexdigest(),
            }],
        }), encoding="utf-8")
        root = temporary / "public"
        (root / ".incoming").mkdir(parents=True)
        (root / ".gonavi-mirror-root").write_text("gonavi-download-mirror-v1\n", encoding="utf-8")
        stage = root / ".incoming" / "stable-test-generation"
        subprocess.check_call([
            sys.executable,
            str(PREPARE),
            "--channel", "stable",
            "--app-tag", "v1.2.3",
            "--app-dir", str(assets),
            "--app-manifest", str(manifest),
            "--generation", "stable-test-generation",
            "--output", str(stage),
        ])
        return root, stage

    def run_transaction(self, root: Path, stage: Path, command: str) -> subprocess.CompletedProcess[str]:
        environment = os.environ.copy()
        environment["GONAVI_EDGE_TRANSACTION_ALLOW_NON_ROOT_TEST"] = "1"
        return subprocess.run([
            sys.executable,
            str(TRANSACTION),
            command,
            "--root", str(root),
            "--staging-dir", str(stage),
            "--channel", "stable",
            "--app-tag", "v1.2.3",
            "--generation", "stable-test-generation",
            "--node-id", "test-edge",
        ], text=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE, check=False, env=environment)

    def seed_active_driver_release(self, root: Path, driver_tag: str = "v1.2.2") -> Path:
        driver_dir = root / "drivers/releases/download" / driver_tag
        driver_dir.mkdir(parents=True)
        (driver_dir / "sqlserver-driver-agent-test.zip").write_bytes(b"published-driver")
        latest_index = root / "drivers/releases/latest/GoNavi-DriverAgents-Index.json"
        latest_index.parent.mkdir(parents=True)
        latest_index.write_text(json.dumps({
            "tagName": "latest",
            "mirrorTagName": driver_tag,
            "assets": {"sqlserver-driver-agent-test.zip": len(b"published-driver")},
        }), encoding="utf-8")
        channel_state = root / ".state/channels/stable.json"
        channel_state.parent.mkdir(parents=True)
        channel_state.write_text(json.dumps({
            "schemaVersion": 2,
            "channel": "stable",
            "generation": "stable-previous-generation",
            "appTag": "v1.2.2",
            "driverEnabled": True,
            "driverTag": driver_tag,
            "status": "active",
        }), encoding="utf-8")
        return latest_index

    def test_promotes_immutable_then_mutable_and_ready_health_atomically(self) -> None:
        with tempfile.TemporaryDirectory() as raw_temporary:
            root, stage = self.prepare(Path(raw_temporary))
            for command in ("verify", "promote-immutable", "promote-mutable", "finalize"):
                result = self.run_transaction(root, stage, command)
                self.assertEqual(result.returncode, 0, result.stderr)
            self.assertTrue((root / "gonavi/releases/download/v1.2.3/GoNavi-v1.2.3-Test.zip").is_file())
            self.assertTrue((root / "gonavi/releases/latest/latest.json").is_file())
            health = json.loads((root / "healthz").read_text(encoding="utf-8"))
            self.assertIs(health["ready"], True)
            self.assertEqual(health["channels"]["stable"]["generation"], "stable-test-generation")
            self.assertEqual(health["performance"]["status"], "unknown")
            self.assertFalse(stage.exists())

    def test_app_only_publication_inherits_active_driver_tag_without_rewriting_latest(self) -> None:
        with tempfile.TemporaryDirectory() as raw_temporary:
            root, stage = self.prepare(Path(raw_temporary))
            latest_index = self.seed_active_driver_release(root)
            original_latest = latest_index.read_bytes()

            for command in ("verify", "promote-immutable", "promote-mutable", "finalize"):
                result = self.run_transaction(root, stage, command)
                self.assertEqual(result.returncode, 0, result.stderr)

            state = json.loads((root / ".state/channels/stable.json").read_text(encoding="utf-8"))
            health = json.loads((root / "healthz").read_text(encoding="utf-8"))
            self.assertFalse(state["driverEnabled"])
            self.assertEqual(state["driverTag"], "v1.2.2")
            self.assertEqual(health["channels"]["stable"]["driverTag"], "v1.2.2")
            self.assertEqual(latest_index.read_bytes(), original_latest)

    def test_app_only_publication_repairs_empty_state_from_valid_driver_latest(self) -> None:
        with tempfile.TemporaryDirectory() as raw_temporary:
            root, stage = self.prepare(Path(raw_temporary))
            self.seed_active_driver_release(root)
            state_path = root / ".state/channels/stable.json"
            previous_state = json.loads(state_path.read_text(encoding="utf-8"))
            previous_state["driverTag"] = ""
            state_path.write_text(json.dumps(previous_state), encoding="utf-8")

            for command in ("verify", "promote-immutable", "promote-mutable", "finalize"):
                result = self.run_transaction(root, stage, command)
                self.assertEqual(result.returncode, 0, result.stderr)

            state = json.loads(state_path.read_text(encoding="utf-8"))
            self.assertEqual(state["driverTag"], "v1.2.2")

    def test_checksum_failure_never_promotes_immutable_or_mutable_files(self) -> None:
        with tempfile.TemporaryDirectory() as raw_temporary:
            root, stage = self.prepare(Path(raw_temporary))
            staged_asset = stage / "payload/gonavi/releases/download/v1.2.3/GoNavi-v1.2.3-Test.zip"
            staged_asset.write_bytes(b"tampered")
            result = self.run_transaction(root, stage, "promote-immutable")
            self.assertNotEqual(result.returncode, 0)
            self.assertFalse((root / "gonavi/releases/download/v1.2.3").exists())
            self.assertFalse((root / "gonavi/releases/latest/latest.json").exists())

    def test_unchecksummed_payload_file_never_promotes(self) -> None:
        with tempfile.TemporaryDirectory() as raw_temporary:
            root, stage = self.prepare(Path(raw_temporary))
            extra = stage / "payload/gonavi/releases/download/v1.2.3/untracked.bin"
            extra.write_bytes(b"not listed in SHA256SUMS")

            result = self.run_transaction(root, stage, "promote-immutable")

            self.assertNotEqual(result.returncode, 0)
            self.assertIn("do not exactly match", result.stderr)
            self.assertFalse((root / "gonavi/releases/download/v1.2.3").exists())


if __name__ == "__main__":
    unittest.main()
