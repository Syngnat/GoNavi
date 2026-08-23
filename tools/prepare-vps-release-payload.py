#!/usr/bin/env python3
"""Build a verified filesystem payload for the GoNavi download mirror."""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import shutil
import sys
from pathlib import Path
from typing import Any


TAG_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$")
SHA256_RE = re.compile(r"^[0-9a-fA-F]{64}$")
WINDOWS_ABSOLUTE_PATH_RE = re.compile(r"^[A-Za-z]:/")
DRIVER_CI_BUNDLE_NAME = "GoNavi-DriverAgents.zip"
DRIVER_MUTABLE_INDEX_FIELDS = frozenset(("tagName", "mirrorTagName"))


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--channel", choices=("stable", "dev"), required=True)
    parser.add_argument("--app-tag", required=True)
    parser.add_argument("--app-dir", type=Path, required=True)
    parser.add_argument("--app-manifest", type=Path, required=True)
    parser.add_argument("--driver-tag", default="")
    parser.add_argument("--driver-dir", type=Path)
    parser.add_argument("--driver-version-index", type=Path)
    parser.add_argument("--driver-latest-index", type=Path)
    parser.add_argument(
        "--generation",
        default="",
        help="Globally unique publication generation shared by every edge node",
    )
    parser.add_argument("--output", type=Path, required=True)
    return parser.parse_args()


def fail(message: str) -> None:
    raise ValueError(message)


def validate_tag(value: str, label: str) -> str:
    if not TAG_RE.fullmatch(value) or value in {".", ".."}:
        fail(f"invalid {label}: {value!r}")
    return value


def load_object(path: Path, label: str) -> dict[str, Any]:
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        fail(f"unable to read {label} {path}: {exc}")
    if not isinstance(value, dict):
        fail(f"{label} must be a JSON object: {path}")
    return value


def validate_asset_name(value: Any, label: str) -> str:
    if not isinstance(value, str) or not value or Path(value).name != value:
        fail(f"invalid {label} asset name: {value!r}")
    if value in {".", ".."} or "/" in value or "\\" in value:
        fail(f"invalid {label} asset name: {value!r}")
    return value


def is_nonnegative_int(value: Any) -> bool:
    return isinstance(value, int) and not isinstance(value, bool) and value >= 0


def validate_sha256(value: Any, label: str) -> str:
    if not isinstance(value, str) or not SHA256_RE.fullmatch(value):
        fail(f"invalid {label} sha256: {value!r}")
    return value.lower()


def validate_driver_entry_path(value: Any, label: str) -> str:
    if not isinstance(value, str) or not value or "\\" in value:
        fail(f"invalid {label} path: {value!r}")
    parts = value.split("/")
    if (
        value.startswith("/")
        or WINDOWS_ABSOLUTE_PATH_RE.match(value)
        or any(part in {"", ".", ".."} for part in parts)
    ):
        fail(f"invalid {label} path: {value!r}")
    return value


def validate_driver_index(index: dict[str, Any], label: str) -> None:
    assets = index.get("assets")
    asset_sha256 = index.get("assetSha256")
    entries = index.get("entries")
    if not isinstance(assets, dict) or not assets:
        fail(f"{label} assets must be a non-empty object")
    if not isinstance(asset_sha256, dict) or not asset_sha256:
        fail(f"{label} assetSha256 must be a non-empty object")
    if not isinstance(entries, dict) or not entries:
        fail(f"{label} entries must be a non-empty object")
    if set(asset_sha256) != set(assets):
        fail(f"{label} assets and assetSha256 reference different archives")

    archive_names: set[str] = set()
    for raw_name, expected_size in sorted(assets.items()):
        name = validate_asset_name(raw_name, f"{label} driver")
        if name == DRIVER_CI_BUNDLE_NAME:
            fail(f"driver CI bundle must not be mirrored: {name}")
        if Path(name).suffix.lower() != ".zip":
            fail(f"driver mirror asset must be a zip archive: {name}")
        if not is_nonnegative_int(expected_size):
            fail(f"invalid driver asset size for {name}")
        validate_sha256(asset_sha256.get(name), f"driver asset {name}")
        archive_names.add(name)

    referenced_archives: set[str] = set()
    for raw_name, raw_entry in sorted(entries.items()):
        name = validate_asset_name(raw_name, f"{label} driver entry")
        if not isinstance(raw_entry, dict):
            fail(f"invalid {label} driver entry metadata for {name}")
        archive = validate_asset_name(
            raw_entry.get("archive"),
            f"{label} driver entry archive",
        )
        if archive not in archive_names:
            fail(f"driver entry references an unknown archive: {name} -> {archive}")
        validate_driver_entry_path(
            raw_entry.get("path"),
            f"{label} driver entry {name}",
        )
        if not is_nonnegative_int(raw_entry.get("size")):
            fail(f"invalid {label} driver entry size for {name}")
        validate_sha256(
            raw_entry.get("sha256"),
            f"{label} driver entry {name}",
        )
        referenced_archives.add(archive)

    if referenced_archives != archive_names:
        fail(f"{label} entries do not cover every driver archive")


def normalized_driver_index(index: dict[str, Any]) -> dict[str, Any]:
    return {
        key: value
        for key, value in index.items()
        if key not in DRIVER_MUTABLE_INDEX_FIELDS
    }


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def copy_file(source: Path, destination: Path) -> None:
    destination.parent.mkdir(parents=True, exist_ok=True)
    shutil.copyfile(source, destination)
    os.chmod(destination, 0o644)


def verify_and_copy_app_assets(
    app_dir: Path,
    manifest: dict[str, Any],
    destination: Path,
) -> None:
    assets = manifest.get("assets")
    if not isinstance(assets, list) or not assets:
        fail("app manifest assets must be a non-empty array")

    seen: set[str] = set()
    for entry in assets:
        if not isinstance(entry, dict):
            fail("app manifest asset entries must be objects")
        name = validate_asset_name(entry.get("name"), "app")
        if name in seen:
            fail(f"duplicate app asset: {name}")
        seen.add(name)

        expected_size = entry.get("size")
        expected_sha = entry.get("sha256")
        if not isinstance(expected_size, int) or expected_size < 0:
            fail(f"invalid app asset size for {name}")
        if not isinstance(expected_sha, str) or not SHA256_RE.fullmatch(expected_sha):
            fail(f"invalid app asset sha256 for {name}")

        source = app_dir / name
        if not source.is_file():
            fail(f"app asset is missing: {source}")
        if source.stat().st_size != expected_size:
            fail(f"app asset size mismatch: {name}")
        if sha256_file(source) != expected_sha.lower():
            fail(f"app asset sha256 mismatch: {name}")
        copy_file(source, destination / name)


def verify_and_copy_driver_assets(
    driver_dir: Path,
    index: dict[str, Any],
    destination: Path,
) -> None:
    assets = index["assets"]
    asset_sha256 = index["assetSha256"]

    for raw_name, expected_size in sorted(assets.items()):
        name = validate_asset_name(raw_name, "driver")
        source = driver_dir / name
        if not source.is_file():
            fail(f"driver asset is missing: {source}")
        if source.stat().st_size != expected_size:
            fail(f"driver asset size mismatch: {name}")
        if sha256_file(source) != asset_sha256[name].lower():
            fail(f"driver asset sha256 mismatch: {name}")
        copy_file(source, destination / name)


def app_layout(channel: str, tag: str) -> tuple[Path, Path]:
    if channel == "stable":
        return (
            Path("gonavi/releases/download") / tag,
            Path("gonavi/releases/latest/latest.json"),
        )
    return (
        Path("gonavi/dev/releases/download") / tag,
        Path("gonavi/dev/releases/latest/latest-dev.json"),
    )


def driver_layout(channel: str, tag: str) -> tuple[Path, Path]:
    if channel == "stable":
        return (
            Path("drivers/releases/download") / tag,
            Path("drivers/releases/latest/GoNavi-DriverAgents-Index.json"),
        )
    return (
        Path("drivers/dev/releases/download") / tag,
        Path("drivers/dev/releases/latest/GoNavi-DriverAgents-Index.json"),
    )


def write_checksums(payload_dir: Path, output: Path) -> tuple[int, int]:
    files = sorted(path for path in payload_dir.rglob("*") if path.is_file())
    lines: list[str] = []
    total_bytes = 0
    for path in files:
        relative = path.relative_to(payload_dir).as_posix()
        lines.append(f"{sha256_file(path)}  {relative}\n")
        total_bytes += path.stat().st_size
    output.write_text("".join(lines), encoding="ascii")
    os.chmod(output, 0o644)
    return len(files), total_bytes


def build(args: argparse.Namespace) -> dict[str, Any]:
    app_tag = validate_tag(args.app_tag, "app tag")
    generation = validate_tag(
        args.generation.strip() or f"{args.channel}-{app_tag}",
        "generation",
    )
    if args.output.exists():
        fail(f"output path already exists: {args.output}")

    manifest = load_object(args.app_manifest, "app manifest")
    if args.channel == "stable":
        if manifest.get("tagName") != app_tag:
            fail("stable app manifest tagName does not match --app-tag")
    elif manifest.get("channel") != "dev" or manifest.get("version") != app_tag:
        fail("dev app manifest channel/version does not match --app-tag")

    payload_dir = args.output / "payload"
    version_dir, latest_path = app_layout(args.channel, app_tag)
    verify_and_copy_app_assets(args.app_dir, manifest, payload_dir / version_dir)
    copy_file(args.app_manifest, payload_dir / version_dir / args.app_manifest.name)
    copy_file(args.app_manifest, payload_dir / latest_path)

    driver_enabled = False
    driver_tag = ""
    driver_inputs = (
        args.driver_dir,
        args.driver_version_index,
        args.driver_latest_index,
    )
    if any(value is not None for value in driver_inputs):
        if not all(value is not None for value in driver_inputs):
            fail("driver dir, version index, and latest index must be provided together")
        driver_tag = validate_tag(args.driver_tag, "driver tag")
        version_index = load_object(args.driver_version_index, "driver version index")
        latest_index = load_object(args.driver_latest_index, "driver latest index")
        validate_driver_index(version_index, "driver version index")
        validate_driver_index(latest_index, "driver latest index")
        if normalized_driver_index(version_index) != normalized_driver_index(latest_index):
            fail("driver version and latest indexes differ outside tag metadata")

        driver_version_dir, driver_latest_path = driver_layout(args.channel, driver_tag)
        verify_and_copy_driver_assets(
            args.driver_dir,
            version_index,
            payload_dir / driver_version_dir,
        )
        copy_file(
            args.driver_version_index,
            payload_dir / driver_version_dir / "GoNavi-DriverAgents-Index.json",
        )
        copy_file(args.driver_latest_index, payload_dir / driver_latest_path)
        driver_enabled = True
    elif args.driver_tag:
        fail("--driver-tag requires driver inputs")

    args.output.mkdir(parents=True, exist_ok=True)
    file_count, payload_bytes = write_checksums(payload_dir, args.output / "SHA256SUMS")
    probe_asset = max(
        manifest["assets"],
        key=lambda entry: int(entry["size"]),
    )
    metadata = {
        "schemaVersion": 2,
        "generation": generation,
        "channel": args.channel,
        "appTag": app_tag,
        "driverEnabled": driver_enabled,
        "driverTag": driver_tag,
        "fileCount": file_count,
        "payloadBytes": payload_bytes,
        "probePath": (version_dir / probe_asset["name"]).as_posix(),
        "probeSize": probe_asset["size"],
        "probeSha256": probe_asset["sha256"].lower(),
    }
    (args.output / "deployment.json").write_text(
        json.dumps(metadata, ensure_ascii=True, sort_keys=True) + "\n",
        encoding="ascii",
    )
    os.chmod(args.output / "deployment.json", 0o644)
    return metadata


def main() -> int:
    try:
        metadata = build(parse_args())
    except ValueError as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 1
    print(json.dumps(metadata, ensure_ascii=True, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
