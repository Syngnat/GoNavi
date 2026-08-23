#!/usr/bin/env python3
"""Safely prune unreferenced immutable releases on a GoNavi edge."""

from __future__ import annotations

import argparse
import json
import os
import shutil
import sys
import time
from pathlib import Path
from typing import Any


MARKER = "gonavi-download-mirror-v1"
DEFAULT_MIN_AGE_SECONDS = 0
RELEASE_ROOTS = {
    "stable": {
        "app": Path("gonavi/releases/download"),
        "driver": Path("drivers/releases/download"),
    },
    "dev": {
        "app": Path("gonavi/dev/releases/download"),
        "driver": Path("drivers/dev/releases/download"),
    },
}


def load_references(root: Path) -> dict[Path, set[str]]:
    references: dict[Path, set[str]] = {}
    for channel in RELEASE_ROOTS:
        state_path = root / ".state" / "channels" / f"{channel}.json"
        if not state_path.is_file():
            # Missing state is not evidence that a channel is unreferenced.
            # Preserve its immutable directories until a valid state exists.
            continue
        value: Any = json.loads(state_path.read_text(encoding="utf-8"))
        if not isinstance(value, dict) or value.get("channel") != channel:
            raise ValueError(f"invalid channel state: {state_path}")
        for relative in RELEASE_ROOTS[channel].values():
            references[relative] = set()
        app_tag = value.get("appTag")
        driver_tag = value.get("driverTag")
        if isinstance(app_tag, str) and app_tag:
            references[RELEASE_ROOTS[channel]["app"]].add(app_tag)
        if isinstance(driver_tag, str) and driver_tag:
            references[RELEASE_ROOTS[channel]["driver"]].add(driver_tag)
    return references


def select_prunable_directories(root: Path, min_age_seconds: int, now: float | None = None) -> list[Path]:
    if min_age_seconds < 0:
        raise ValueError("minimum retention age must not be negative")
    references = load_references(root)
    cutoff = (time.time() if now is None else now) - min_age_seconds
    selected: list[Path] = []
    for relative_root, keep_tags in references.items():
        release_root = root / relative_root
        if not release_root.is_dir():
            continue
        for candidate in release_root.iterdir():
            if candidate.name in keep_tags or candidate.is_symlink() or not candidate.is_dir():
                continue
            if candidate.stat().st_mtime <= cutoff:
                selected.append(candidate)
    return sorted(selected)


def tree_bytes(root: Path) -> int:
    return sum(path.stat().st_size for path in root.rglob("*") if path.is_file() and not path.is_symlink())


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root", type=Path, required=True)
    parser.add_argument("--min-age-seconds", type=int, default=DEFAULT_MIN_AGE_SECONDS)
    parser.add_argument("--max-bytes", type=int, required=True)
    parser.add_argument("--min-free-bytes", type=int, default=2_000_000_000)
    parser.add_argument("--dry-run", action="store_true")
    args = parser.parse_args()
    try:
        root = args.root.resolve()
        if root == Path(root.anchor) or not root.is_dir():
            raise ValueError("edge root must be an existing absolute non-root directory")
        marker = root / ".gonavi-mirror-root"
        if marker.read_text(encoding="utf-8", errors="replace").strip() != MARKER:
            raise ValueError("edge root marker is missing or invalid")
        if args.max_bytes <= 0 or args.min_free_bytes < 0:
            raise ValueError("edge disk budget is invalid")
        selected = select_prunable_directories(root, args.min_age_seconds)
        reclaimed = sum(tree_bytes(path) for path in selected)
        if not args.dry_run:
            for path in selected:
                resolved = path.resolve()
                resolved.relative_to(root)
                shutil.rmtree(resolved)
        retained = tree_bytes(root)
        free_bytes = shutil.disk_usage(root).free
        print(json.dumps({
            "deletedDirectories": len(selected),
            "reclaimedBytes": reclaimed,
            "retainedBytes": retained,
            "maxBytes": args.max_bytes,
            "freeBytes": free_bytes,
            "minFreeBytes": args.min_free_bytes,
            "dryRun": args.dry_run,
        }, separators=(",", ":")))
        return 3 if retained > args.max_bytes or free_bytes < args.min_free_bytes else 0
    except (OSError, ValueError, json.JSONDecodeError) as error:
        print(str(error), file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
