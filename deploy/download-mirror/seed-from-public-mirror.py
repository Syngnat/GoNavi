#!/usr/bin/env python3
"""Seed a VPS mirror from the currently published public mirror."""

from __future__ import annotations

import argparse
import concurrent.futures
import hashlib
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path
from typing import Any


TAG_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$")
USER_AGENT = "GoNavi-VPS-Mirror-Seeder/1"


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--source-base-url", required=True)
    parser.add_argument("--mirror-root", type=Path, required=True)
    parser.add_argument("--prepare-script", type=Path, required=True)
    parser.add_argument("--transaction-script", type=Path, required=True)
    parser.add_argument("--node-id", required=True)
    parser.add_argument("--workers", type=int, default=4)
    return parser.parse_args()


def fetch_json(url: str) -> tuple[dict[str, Any], bytes]:
    separator = "&" if "?" in url else "?"
    request = urllib.request.Request(
        f"{url}{separator}seed={int(time.time())}",
        headers={"User-Agent": USER_AGENT, "Cache-Control": "no-cache"},
    )
    with urllib.request.urlopen(request, timeout=60) as response:
        raw = response.read()
    value = json.loads(raw)
    if not isinstance(value, dict):
        raise ValueError(f"expected JSON object from {url}")
    return value, raw


def validate_tag(value: Any, label: str) -> str:
    if not isinstance(value, str) or not TAG_RE.fullmatch(value):
        raise ValueError(f"invalid {label}: {value!r}")
    return value


def validate_name(value: Any) -> str:
    if not isinstance(value, str) or not value or Path(value).name != value:
        raise ValueError(f"invalid asset name: {value!r}")
    if value in {".", ".."} or "/" in value or "\\" in value:
        raise ValueError(f"invalid asset name: {value!r}")
    return value


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def download_file(
    url: str,
    destination: Path,
    expected_size: int,
    expected_sha256: str | None,
) -> int:
    destination.parent.mkdir(parents=True, exist_ok=True)
    partial = destination.with_name(destination.name + ".part")
    if destination.is_file() and destination.stat().st_size == expected_size:
        if expected_sha256 is None or sha256_file(destination) == expected_sha256:
            return expected_size

    for attempt in range(1, 4):
        offset = partial.stat().st_size if partial.exists() else 0
        if offset > expected_size:
            partial.unlink()
            offset = 0
        headers = {"User-Agent": USER_AGENT}
        if offset:
            headers["Range"] = f"bytes={offset}-"
        request = urllib.request.Request(url, headers=headers)
        try:
            with urllib.request.urlopen(request, timeout=120) as response:
                append = offset > 0 and response.status == 206
                mode = "ab" if append else "wb"
                with partial.open(mode) as output:
                    shutil.copyfileobj(response, output, length=1024 * 1024)
        except (OSError, urllib.error.URLError) as exc:
            if attempt == 3:
                raise RuntimeError(f"download failed after 3 attempts: {url}: {exc}") from exc
            time.sleep(attempt * 2)
            continue

        if partial.stat().st_size != expected_size:
            if attempt == 3:
                raise ValueError(
                    f"download size mismatch for {destination.name}: "
                    f"expected {expected_size}, got {partial.stat().st_size}"
                )
            time.sleep(attempt * 2)
            continue
        if expected_sha256 is not None and sha256_file(partial) != expected_sha256:
            partial.unlink()
            if attempt == 3:
                raise ValueError(f"download sha256 mismatch for {destination.name}")
            continue
        partial.replace(destination)
        os.chmod(destination, 0o644)
        return expected_size
    raise AssertionError("unreachable")


def download_many(
    items: list[tuple[str, Path, int, str | None]],
    workers: int,
    label: str,
) -> None:
    completed_files = 0
    completed_bytes = 0
    lock = threading.Lock()

    def run(item: tuple[str, Path, int, str | None]) -> None:
        nonlocal completed_files, completed_bytes
        size = download_file(*item)
        with lock:
            completed_files += 1
            completed_bytes += size
            if completed_files == len(items) or completed_files % 10 == 0:
                print(
                    f"{label}: {completed_files}/{len(items)} files, "
                    f"{completed_bytes / (1024 ** 3):.2f} GiB",
                    flush=True,
                )

    with concurrent.futures.ThreadPoolExecutor(max_workers=workers) as executor:
        futures = [executor.submit(run, item) for item in items]
        for future in concurrent.futures.as_completed(futures):
            future.result()


def seed_channel(
    source_base_url: str,
    mirror_root: Path,
    prepare_script: Path,
    transaction_script: Path,
    node_id: str,
    workers: int,
    channel: str,
) -> None:
    if channel == "stable":
        app_latest_path = "gonavi/releases/latest/latest.json"
        driver_latest_path = "drivers/releases/latest/GoNavi-DriverAgents-Index.json"
        app_download_root = "gonavi/releases/download"
        driver_download_root = "drivers/releases/download"
    else:
        app_latest_path = "gonavi/dev/releases/latest/latest-dev.json"
        driver_latest_path = "drivers/dev/releases/latest/GoNavi-DriverAgents-Index.json"
        app_download_root = "gonavi/dev/releases/download"
        driver_download_root = "drivers/dev/releases/download"

    app_manifest, app_manifest_raw = fetch_json(f"{source_base_url}/{app_latest_path}")
    driver_index, driver_index_raw = fetch_json(f"{source_base_url}/{driver_latest_path}")
    if channel == "stable":
        app_tag = validate_tag(app_manifest.get("tagName"), "stable app tag")
        driver_tag = validate_tag(driver_index.get("tagName"), "stable driver tag")
    else:
        app_tag = validate_tag(app_manifest.get("version"), "dev app tag")
        driver_tag = validate_tag(driver_index.get("mirrorTagName"), "dev driver tag")

    source_dir = Path(tempfile.mkdtemp(prefix=f".seed-{channel}-", dir=mirror_root))
    app_dir = source_dir / "app"
    driver_dir = source_dir / "driver"
    app_dir.mkdir()
    driver_dir.mkdir()
    app_manifest_path = app_dir / Path(app_latest_path).name
    driver_index_path = driver_dir / "GoNavi-DriverAgents-Index.json"
    app_manifest_path.write_bytes(app_manifest_raw)
    driver_index_path.write_bytes(driver_index_raw)

    app_assets = app_manifest.get("assets")
    if not isinstance(app_assets, list) or not app_assets:
        raise ValueError(f"{channel} app manifest has no assets")
    app_items: list[tuple[str, Path, int, str | None]] = []
    for entry in app_assets:
        if not isinstance(entry, dict):
            raise ValueError("app asset entry must be an object")
        name = validate_name(entry.get("name"))
        size = entry.get("size")
        checksum = entry.get("sha256")
        if not isinstance(size, int) or size < 0:
            raise ValueError(f"invalid app asset size for {name}")
        if not isinstance(checksum, str) or not re.fullmatch(r"[0-9a-fA-F]{64}", checksum):
            raise ValueError(f"invalid app asset sha256 for {name}")
        url = f"{source_base_url}/{app_download_root}/{app_tag}/{urllib.parse.quote(name)}"
        app_items.append((url, app_dir / name, size, checksum.lower()))

    driver_assets = driver_index.get("assets")
    driver_sha256 = driver_index.get("assetSha256")
    if not isinstance(driver_assets, dict) or not driver_assets:
        raise ValueError(f"{channel} driver index has no assets")
    if not isinstance(driver_sha256, dict) or set(driver_sha256) != set(driver_assets):
        raise ValueError(f"{channel} driver index has incomplete SHA256 metadata")
    driver_items: list[tuple[str, Path, int, str | None]] = []
    for raw_name, size in sorted(driver_assets.items()):
        name = validate_name(raw_name)
        if not isinstance(size, int) or size < 0:
            raise ValueError(f"invalid driver asset size for {name}")
        url = f"{source_base_url}/{driver_download_root}/{driver_tag}/{urllib.parse.quote(name)}"
        checksum = driver_sha256.get(name)
        if not isinstance(checksum, str) or not re.fullmatch(r"[0-9a-fA-F]{64}", checksum):
            raise ValueError(f"invalid driver asset sha256 for {name}")
        driver_items.append((url, driver_dir / name, size, checksum.lower()))

    print(f"Seeding {channel} app {app_tag}", flush=True)
    download_many(app_items, workers, f"{channel} app")
    print(f"Seeding {channel} drivers {driver_tag}", flush=True)
    download_many(driver_items, workers, f"{channel} drivers")

    deployment_id = f"seed-{channel}-{int(time.time())}"
    staging_dir = mirror_root / ".incoming" / deployment_id
    subprocess.run(
        [
            sys.executable,
            str(prepare_script),
            "--channel",
            channel,
            "--app-tag",
            app_tag,
            "--app-dir",
            str(app_dir),
            "--app-manifest",
            str(app_manifest_path),
            "--driver-tag",
            driver_tag,
            "--driver-dir",
            str(driver_dir),
            "--driver-version-index",
            str(driver_index_path),
            "--driver-latest-index",
            str(driver_index_path),
            "--generation",
            deployment_id,
            "--output",
            str(staging_dir),
        ],
        check=True,
    )
    transaction_args = [
        sys.executable,
        str(transaction_script),
        "--root", str(mirror_root),
        "--staging-dir", str(staging_dir),
        "--channel", channel,
        "--app-tag", app_tag,
        "--driver-tag", driver_tag,
        "--generation", deployment_id,
        "--node-id", node_id,
    ]
    for command in ("verify", "promote-immutable", "promote-mutable", "finalize"):
        subprocess.run([*transaction_args[:2], command, *transaction_args[2:]], check=True)
    shutil.rmtree(source_dir)


def main() -> int:
    args = parse_args()
    if args.workers < 1 or args.workers > 8:
        print("error: --workers must be between 1 and 8", file=sys.stderr)
        return 2
    source_base_url = args.source_base_url.rstrip("/")
    try:
        for channel in ("stable", "dev"):
            seed_channel(
                source_base_url,
                args.mirror_root,
                args.prepare_script,
                args.transaction_script,
                args.node_id,
                args.workers,
                channel,
            )
    except (OSError, ValueError, RuntimeError, subprocess.CalledProcessError) as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
