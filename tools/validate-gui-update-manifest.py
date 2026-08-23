#!/usr/bin/env python3
"""Validate a desktop GUI update manifest before it is published or mirrored.

The update manifest shares a GitHub Release namespace with the standalone CLI.
This validator deliberately uses the generator's GUI filename allowlist again
at the publication boundary, so an unexpected non-CLI asset cannot become a
desktop updater candidate.
"""

from __future__ import annotations

import argparse
import hashlib
import importlib.util
import json
import re
import sys
from pathlib import Path
from types import ModuleType
from typing import Any
from urllib.parse import quote, urlsplit


ROOT = Path(__file__).resolve().parents[1]
GENERATOR_PATH = ROOT / "tools" / "generate-update-latest-manifest.py"
SHA256_RE = re.compile(r"^[0-9a-fA-F]{64}$")
TAG_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$")
STABLE_TAG_RE = re.compile(r"^v\d+\.\d+\.\d+$")
DEV_TAG_RE = re.compile(r"^dev-[0-9a-f]{7,40}$")
REPOSITORY_RE = re.compile(r"^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$")
DEFAULT_MIRROR_BASES = {
    "stable": "https://download.syngnat.top/gonavi/releases/download",
    "dev": "https://download.syngnat.top/gonavi/dev/releases/download",
}


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Validate a GoNavi GUI update manifest and its local assets"
    )
    parser.add_argument("--channel", choices=("stable", "dev"), required=True)
    parser.add_argument("--app-tag", required=True)
    parser.add_argument("--app-dir", type=Path, required=True)
    parser.add_argument("--manifest", type=Path, required=True)
    parser.add_argument(
        "--github-repository",
        default="Syngnat/GoNavi",
        help="GitHub owner/repository used for manifest URLs",
    )
    parser.add_argument(
        "--mirror-base",
        default="",
        help="Override the expected mirror download base URL",
    )
    parser.add_argument(
        "--download-dispatcher-url",
        default="",
        help="Expected HTTPS dispatcher endpoint for immutable asset URLs",
    )
    parser.add_argument(
        "--download-path-prefix",
        default="",
        help="Immutable asset path prefix passed to the dispatcher",
    )
    return parser.parse_args()


def fail(message: str) -> None:
    raise ValueError(message)


def load_object(path: Path, label: str) -> dict[str, Any]:
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        fail(f"unable to read {label} {path}: {exc}")
    if not isinstance(value, dict):
        fail(f"{label} must be a JSON object: {path}")
    return value


def load_generator() -> ModuleType:
    spec = importlib.util.spec_from_file_location(
        "gonavi_update_manifest_generator", GENERATOR_PATH
    )
    if spec is None or spec.loader is None:
        fail(f"unable to load GUI asset allowlist from {GENERATOR_PATH}")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def normalize_version(generator: ModuleType, version: str) -> str:
    normalizer = getattr(generator, "normalize_version", None)
    if not callable(normalizer):
        fail("update manifest generator has no version normalizer")
    normalized = normalizer(version)
    if not isinstance(normalized, str) or not normalized:
        fail(f"invalid normalized GUI version: {version!r}")
    return normalized


def gui_patterns_for_version(generator: ModuleType, version: str) -> tuple[re.Pattern[str], ...]:
    raw_patterns = getattr(generator, "GUI_ASSET_PATTERNS", None)
    if not isinstance(raw_patterns, tuple) or not raw_patterns:
        fail("update manifest generator has no GUI asset allowlist")
    escaped_version = re.escape(normalize_version(generator, version))
    placeholder = "[A-Za-z0-9][A-Za-z0-9._-]*"
    patterns: list[re.Pattern[str]] = []
    for raw_pattern in raw_patterns:
        source = getattr(raw_pattern, "pattern", None)
        if not isinstance(source, str) or placeholder not in source:
            fail("update manifest generator has an invalid GUI asset allowlist")
        patterns.append(re.compile(source.replace(placeholder, escaped_version)))
    return tuple(patterns)


def validate_tag(channel: str, value: str) -> str:
    if not TAG_RE.fullmatch(value) or value in {".", ".."}:
        fail(f"invalid app tag: {value!r}")
    if channel == "stable" and not STABLE_TAG_RE.fullmatch(value):
        fail(f"invalid stable app tag: {value!r}")
    if channel == "dev" and not DEV_TAG_RE.fullmatch(value):
        fail(f"invalid dev app tag: {value!r}")
    return value


def validate_repository(value: str) -> str:
    if not REPOSITORY_RE.fullmatch(value):
        fail(f"invalid GitHub repository: {value!r}")
    return value


def validate_https_base(value: str, label: str) -> str:
    base = value.strip().rstrip("/")
    parsed = urlsplit(base)
    if (
        parsed.scheme != "https"
        or not parsed.netloc
        or parsed.query
        or parsed.fragment
    ):
        fail(f"invalid {label}: {value!r}")
    return base


def is_nonnegative_int(value: Any) -> bool:
    return isinstance(value, int) and not isinstance(value, bool) and value >= 0


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    try:
        with path.open("rb") as handle:
            for chunk in iter(lambda: handle.read(1024 * 1024), b""):
                digest.update(chunk)
    except OSError as exc:
        fail(f"unable to read GUI manifest asset {path}: {exc}")
    return digest.hexdigest()


def validate_asset_name(
    name: Any,
    *,
    patterns: tuple[re.Pattern[str], ...],
) -> str:
    if not isinstance(name, str) or not name:
        fail(f"invalid GUI manifest asset name: {name!r}")
    if Path(name).name != name or name in {".", ".."} or "/" in name or "\\" in name:
        fail(f"invalid GUI manifest asset name: {name!r}")
    if not any(pattern.fullmatch(name) for pattern in patterns):
        fail(f"not an allowed GUI release asset: {name}")
    return name


def validate_manifest(
    *,
    channel: str,
    app_tag: str,
    app_dir: Path,
    manifest_name: str,
    manifest: dict[str, Any],
    repository: str,
    mirror_base: str,
    download_dispatcher_url: str = "",
    download_path_prefix: str = "",
) -> int:
    generator = load_generator()
    version = normalize_version(generator, app_tag) if channel == "stable" else app_tag
    expected_channel = "latest" if channel == "stable" else "dev"
    expected_tag_name = app_tag if channel == "stable" else "dev-latest"
    expected_manifest_name = "latest.json" if channel == "stable" else "latest-dev.json"

    if manifest_name != expected_manifest_name:
        fail(f"{channel} GUI manifest must be named {expected_manifest_name!r}")

    if manifest.get("schemaVersion") != 1:
        fail("GUI manifest schemaVersion must be 1")
    if manifest.get("component") != "gui":
        fail("manifest component must be 'gui'")
    if manifest.get("channel") != expected_channel:
        if channel == "stable":
            fail("stable GUI manifest channel must be 'latest'")
        fail("dev GUI manifest channel must be 'dev'")
    if manifest.get("tagName") != expected_tag_name:
        fail(f"GUI manifest tagName must be {expected_tag_name!r}")
    if manifest.get("version") != version:
        fail(f"GUI manifest version must be {version!r}")

    expected_html_url = f"https://github.com/{repository}/releases/tag/{expected_tag_name}"
    if manifest.get("htmlUrl") != expected_html_url:
        fail("GUI manifest htmlUrl does not match its release tag")

    assets = manifest.get("assets")
    if not isinstance(assets, list) or not assets:
        fail("GUI manifest assets must be a non-empty array")
    if not app_dir.is_dir():
        fail(f"GUI manifest app directory does not exist: {app_dir}")

    patterns = gui_patterns_for_version(generator, version)
    dispatcher_url_builder = getattr(generator, "dispatcher_download_url", None)
    if download_dispatcher_url and not callable(dispatcher_url_builder):
        fail("update manifest generator has no dispatcher URL builder")
    expected_url_prefix = f"{mirror_base}/{quote(app_tag, safe='')}/"
    expected_api_url_prefix = (
        f"https://github.com/{repository}/releases/download/"
        f"{quote(expected_tag_name, safe='')}/"
    )
    seen: set[str] = set()
    for entry in assets:
        if not isinstance(entry, dict):
            fail("GUI manifest asset entries must be objects")
        name = validate_asset_name(entry.get("name"), patterns=patterns)
        normalized_name = name.casefold()
        if normalized_name in seen:
            fail(f"duplicate GUI manifest asset: {name}")
        seen.add(normalized_name)

        if download_dispatcher_url:
            expected_url = dispatcher_url_builder(
                download_dispatcher_url,
                download_path_prefix,
                app_tag,
                name,
            )
        else:
            expected_url = expected_url_prefix + quote(name, safe="")
        if entry.get("url") != expected_url:
            fail(f"GUI manifest asset URL is invalid: {name}")
        expected_api_url = expected_api_url_prefix + quote(name, safe="")
        if entry.get("apiUrl") != expected_api_url:
            fail(f"GUI manifest asset API URL is invalid: {name}")

        expected_size = entry.get("size")
        if not is_nonnegative_int(expected_size) or expected_size == 0:
            fail(f"GUI manifest asset size must be positive: {name}")
        expected_sha = entry.get("sha256")
        if not isinstance(expected_sha, str) or not SHA256_RE.fullmatch(expected_sha):
            fail(f"invalid GUI manifest asset sha256: {name}")

        source = app_dir / name
        if not source.is_file():
            fail(f"GUI manifest asset is missing: {name}")
        if source.stat().st_size != expected_size:
            fail(f"GUI manifest asset size mismatch: {name}")
        if sha256_file(source) != expected_sha.lower():
            fail(f"GUI manifest asset sha256 mismatch: {name}")
    return len(assets)


def main() -> int:
    args = parse_args()
    try:
        app_tag = validate_tag(args.channel, args.app_tag)
        repository = validate_repository(args.github_repository)
        if args.mirror_base and args.download_dispatcher_url:
            fail("choose either --mirror-base or --download-dispatcher-url")
        if args.download_dispatcher_url and not args.download_path_prefix.strip():
            fail("--download-path-prefix is required with --download-dispatcher-url")
        dispatcher_url = ""
        download_path_prefix = ""
        if args.download_dispatcher_url:
            dispatcher_url = validate_https_base(
                args.download_dispatcher_url,
                "download dispatcher URL",
            )
            download_path_prefix = "/" + args.download_path_prefix.strip().strip("/")
        mirror_base = validate_https_base(
            args.mirror_base or DEFAULT_MIRROR_BASES[args.channel],
            "mirror base URL",
        )
        manifest = load_object(args.manifest, "GUI manifest")
        asset_count = validate_manifest(
            channel=args.channel,
            app_tag=app_tag,
            app_dir=args.app_dir,
            manifest_name=args.manifest.name,
            manifest=manifest,
            repository=repository,
            mirror_base=mirror_base,
            download_dispatcher_url=dispatcher_url,
            download_path_prefix=download_path_prefix,
        )
    except ValueError as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 1
    print(
        f"validated {asset_count} GUI manifest asset(s) for "
        f"{args.channel} {args.app_tag}"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
