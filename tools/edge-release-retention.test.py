#!/usr/bin/env python3

from __future__ import annotations

import importlib.util
import json
import os
import tempfile
import unittest
from pathlib import Path


SCRIPT = Path(__file__).with_name("edge-release-retention.py")
SPEC = importlib.util.spec_from_file_location("edge_release_retention", SCRIPT)
assert SPEC and SPEC.loader
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)


class EdgeReleaseRetentionTest(unittest.TestCase):
    def test_default_retention_age_prunes_immediately(self) -> None:
        self.assertEqual(MODULE.DEFAULT_MIN_AGE_SECONDS, 0)

    def test_preserves_channel_without_publication_state(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            old = root / "gonavi/dev/releases/download/dev-old"
            old.mkdir(parents=True)
            (old / "asset.bin").write_bytes(b"x")
            os.utime(old, (100, 100))

            selected = MODULE.select_prunable_directories(root, 100, now=1000)

            self.assertEqual(selected, [])

    def test_only_selects_old_unreferenced_release_directories(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            (root / ".state/channels").mkdir(parents=True)
            (root / ".state/channels/stable.json").write_text(json.dumps({
                "channel": "stable",
                "appTag": "v2",
                "driverTag": "v2",
            }), encoding="utf-8")
            old = root / "gonavi/releases/download/v1"
            current = root / "gonavi/releases/download/v2"
            fresh = root / "gonavi/releases/download/v3"
            for path in (old, current, fresh):
                path.mkdir(parents=True)
                (path / "asset.bin").write_bytes(b"x")
            os.utime(old, (100, 100))
            os.utime(current, (100, 100))
            os.utime(fresh, (950, 950))

            selected = MODULE.select_prunable_directories(root, 100, now=1000)

            self.assertEqual(selected, [old])

    def test_zero_retention_age_selects_fresh_unreferenced_directories(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            (root / ".state/channels").mkdir(parents=True)
            (root / ".state/channels/dev.json").write_text(json.dumps({
                "channel": "dev",
                "appTag": "dev-current",
                "driverTag": "dev-current",
            }), encoding="utf-8")
            old = root / "gonavi/dev/releases/download/dev-old"
            current = root / "gonavi/dev/releases/download/dev-current"
            for path in (old, current):
                path.mkdir(parents=True)
                (path / "asset.bin").write_bytes(b"x")
            os.utime(old, (999, 999))

            selected = MODULE.select_prunable_directories(root, 0, now=1000)

            self.assertEqual(selected, [old])

    def test_driver_latest_and_previous_release_survive_broken_empty_channel_state(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            (root / ".state/channels").mkdir(parents=True)
            (root / ".state/channels/dev.json").write_text(json.dumps({
                "channel": "dev",
                "appTag": "dev-current-app",
                "driverTag": "",
            }), encoding="utf-8")
            latest = root / "drivers/dev/releases/latest/GoNavi-DriverAgents-Index.json"
            latest.parent.mkdir(parents=True)
            latest.write_text(json.dumps({
                "tagName": "dev-latest",
                "mirrorTagName": "dev-current-driver",
            }), encoding="utf-8")
            driver_root = root / "drivers/dev/releases/download"
            current = driver_root / "dev-current-driver"
            previous = driver_root / "dev-previous-driver"
            stale = driver_root / "dev-stale-driver"
            for path, modified_at in ((current, 900), (previous, 800), (stale, 700)):
                path.mkdir(parents=True)
                (path / "asset.zip").write_bytes(b"driver")
                os.utime(path, (modified_at, modified_at))

            selected = MODULE.select_prunable_directories(root, 0, now=1000)

            self.assertEqual(selected, [stale])

    def test_rejects_invalid_state_before_selecting_deletions(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            (root / ".state/channels").mkdir(parents=True)
            (root / ".state/channels/dev.json").write_text(
                json.dumps({"channel": "stable", "appTag": "dev-old"}),
                encoding="utf-8",
            )
            with self.assertRaisesRegex(ValueError, "invalid channel state"):
                MODULE.select_prunable_directories(root, 0)


if __name__ == "__main__":
    unittest.main()
