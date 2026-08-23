#!/usr/bin/env python3
"""Generate GoNavi static update manifest (latest.json / latest-dev.json).

The client prefers this file over GitHub REST API so end users are not subject
to unauthenticated api.github.com rate limits (60/hour/IP).

Usage:
  python3 tools/generate-update-latest-manifest.py \\
    --assets-dir dist \\
    --version 1.2.3 \\
    --tag v1.2.3 \\
    --channel latest \\
    --output dist/latest.json

  # dev channel
  python3 tools/generate-update-latest-manifest.py \\
    --assets-dir dist \\
    --version dev-a1b2c3d \\
    --tag dev-latest \\
    --channel dev \\
    --output dist/latest-dev.json
"""

from __future__ import annotations

import argparse
import json
import re
import sys
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import quote, urlencode, urlsplit

REPO = "Syngnat/GoNavi"
SCHEMA_VERSION = 1
# 客户端静态清单体积保护：超过则截断并附 GitHub 完整日志提示。
RELEASE_NOTES_MAX_BYTES = 64 * 1024
RELEASE_NOTES_TRUNCATE_SUFFIX = (
    "\n\n---\n\n> 更新日志过长，已截断。完整内容请查看 GitHub Release 页面。\n"
)
SKIP_NAMES = {
    "SHA256SUMS",
    "LICENSE",
    "NOTICE",
    "latest.json",
    "latest-dev.json",
    ".DS_Store",
}

# GitHub release assets share one flat namespace.  Keep the desktop updater's
# manifest deliberately narrow so headless CLI archives cannot become update
# candidates merely because they were uploaded beside the GUI packages.
GUI_ASSET_PATTERNS = (
    re.compile(r"^GoNavi-[A-Za-z0-9][A-Za-z0-9._-]*-MacOS-(?:Amd64|Arm64)\.dmg$"),
    re.compile(
        r"^GoNavi-[A-Za-z0-9][A-Za-z0-9._-]*-Windows-"
        r"(?:Amd64|Arm64)-(?:Installer\.msi|Portable\.(?:exe|zip))$"
    ),
    re.compile(
        r"^GoNavi-[A-Za-z0-9][A-Za-z0-9._-]*-Linux-"
        r"(?:Amd64(?:-WebKit41)?\.(?:tar\.gz|AppImage)|Arm64\.tar\.gz)$"
    ),
)
CLI_ASSET_PATTERNS = (
    re.compile(
        r"^gonavi-cli_[A-Za-z0-9][A-Za-z0-9.-]*_(?:darwin|linux)_(?:amd64|arm64)\.tar\.gz$"
    ),
    re.compile(r"^gonavi-cli_[A-Za-z0-9][A-Za-z0-9.-]*_windows_(?:amd64|arm64)\.zip$"),
)


def load_release_notes(path: Path | None) -> str:
    if path is None:
        return ""
    if not path.is_file():
        raise SystemExit(f"release notes file not found: {path}")
    text = path.read_text(encoding="utf-8", errors="replace").strip()
    if not text:
        return ""
    encoded = text.encode("utf-8")
    if len(encoded) <= RELEASE_NOTES_MAX_BYTES:
        return text
    # 按字节截断，避免切断多字节 UTF-8 字符
    budget = RELEASE_NOTES_MAX_BYTES - len(RELEASE_NOTES_TRUNCATE_SUFFIX.encode("utf-8"))
    if budget < 0:
        budget = 0
    truncated = encoded[:budget].decode("utf-8", errors="ignore").rstrip()
    return truncated + RELEASE_NOTES_TRUNCATE_SUFFIX


def parse_sha256sums(path: Path) -> dict[str, str]:
    if not path.is_file():
        return {}
    result: dict[str, str] = {}
    for line in path.read_text(encoding="utf-8", errors="replace").splitlines():
        line = line.strip()
        if not line:
            continue
        # "hash  filename" or "hash *filename"
        m = re.match(r"^([0-9a-fA-F]{64})\s+\*?(.+)$", line)
        if not m:
            continue
        digest, name = m.group(1).lower(), m.group(2).strip()
        result[Path(name).name] = digest
    return result


def normalize_version(version: str) -> str:
    v = (version or "").strip()
    if v.lower().startswith("v") and len(v) > 1 and v[1].isdigit():
        return v[1:]
    return v


def browser_download_url(tag: str, asset_name: str) -> str:
    tag = tag.strip()
    name = asset_name.strip()
    return f"https://github.com/{REPO}/releases/download/{tag}/{name}"


def mirror_download_url(base_url: str, tag: str, asset_name: str) -> str:
    base = (base_url or "").strip().rstrip("/")
    return f"{base}/{quote(tag.strip(), safe='')}/{quote(asset_name.strip(), safe='')}"


def dispatcher_download_url(
    dispatcher_url: str,
    path_prefix: str,
    tag: str,
    asset_name: str,
) -> str:
    endpoint = (dispatcher_url or "").strip()
    parsed = urlsplit(endpoint)
    if (
        parsed.scheme != "https"
        or not parsed.netloc
        or parsed.username is not None
        or parsed.password is not None
        or parsed.query
        or parsed.fragment
    ):
        raise SystemExit("download dispatcher URL must be a query-free HTTPS URL")
    prefix = "/" + (path_prefix or "").strip().strip("/")
    asset_path = "/".join((prefix.rstrip("/"), tag.strip(), asset_name.strip()))
    return f"{endpoint}?{urlencode({'path': asset_path})}"


def html_url(tag: str) -> str:
    return f"https://github.com/{REPO}/releases/tag/{tag.strip()}"


def collect_assets(
    assets_dir: Path,
    tag: str,
    hashes: dict[str, str],
    download_base_url: str = "",
    download_tag: str = "",
    component: str = "gui",
    version: str = "",
    download_dispatcher_url: str = "",
    download_path_prefix: str = "",
) -> list[dict]:
    if component not in {"gui", "cli"}:
        raise ValueError(f"unsupported manifest component: {component}")
    # The release directory can contain assets from more than one build or a
    # stale file left by a previous job.  The manifest must only describe the
    # exact version it was generated for, in addition to the component
    # allowlist.
    normalized_version = normalize_version(version) or normalize_version(tag)
    if not normalized_version:
        raise ValueError("manifest asset version is required")
    escaped_version = re.escape(normalized_version)
    if component == "gui":
        patterns = tuple(
            re.compile(pattern.pattern.replace("[A-Za-z0-9][A-Za-z0-9._-]*", escaped_version))
            for pattern in GUI_ASSET_PATTERNS
        )
    else:
        patterns = tuple(
            re.compile(pattern.pattern.replace("[A-Za-z0-9][A-Za-z0-9.-]*", escaped_version))
            for pattern in CLI_ASSET_PATTERNS
        )
    assets: list[dict] = []
    for path in sorted(assets_dir.iterdir()):
        if not path.is_file():
            continue
        name = path.name
        if name in SKIP_NAMES:
            continue
        if name.startswith("."):
            continue
        if not any(pattern.fullmatch(name) for pattern in patterns):
            continue
        github_url = browser_download_url(tag, name)
        primary_url = github_url
        if download_dispatcher_url:
            primary_url = dispatcher_download_url(
                download_dispatcher_url,
                download_path_prefix,
                download_tag or tag,
                name,
            )
        elif download_base_url:
            primary_url = mirror_download_url(download_base_url, download_tag or tag, name)
        item = {
            "name": name,
            "url": primary_url,
            "size": path.stat().st_size,
        }
        if download_base_url or download_dispatcher_url:
            item["apiUrl"] = github_url
        sha = hashes.get(name, "").strip().lower()
        if sha:
            item["sha256"] = sha
        assets.append(item)
    return assets


def build_manifest(
    *,
    channel: str,
    version: str,
    tag: str,
    assets_dir: Path,
    name: str | None,
    published_at: str | None,
    download_base_url: str = "",
    download_tag: str = "",
    download_dispatcher_url: str = "",
    download_path_prefix: str = "",
    release_notes: str = "",
    component: str = "gui",
) -> dict:
    hashes = parse_sha256sums(assets_dir / "SHA256SUMS")
    tag = tag.strip() or f"v{normalize_version(version)}"
    version = normalize_version(version) or normalize_version(tag)
    assets = collect_assets(
        assets_dir,
        tag,
        hashes,
        download_base_url,
        download_tag,
        component,
        version,
        download_dispatcher_url,
        download_path_prefix,
    )
    if not assets:
        raise SystemExit(f"no release assets found under {assets_dir}")

    payload = {
        "schemaVersion": SCHEMA_VERSION,
        "component": component,
        "channel": channel,
        "tagName": tag,
        "version": version,
        "name": (name or tag).strip(),
        "htmlUrl": html_url(tag),
        "publishedAt": (published_at or datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")),
        "assets": assets,
    }
    notes = (release_notes or "").strip()
    if notes:
        payload["releaseNotes"] = notes
    return payload


def main() -> int:
    parser = argparse.ArgumentParser(description="Generate GoNavi latest.json update manifest")
    parser.add_argument("--assets-dir", required=True, help="Directory containing release binaries + SHA256SUMS")
    parser.add_argument("--version", required=True, help="Release version, e.g. 1.2.3 or dev-abc1234")
    parser.add_argument("--tag", default="", help="Git tag, e.g. v1.2.3 (default: v{version})")
    parser.add_argument(
        "--channel",
        choices=("latest", "dev"),
        default="latest",
        help="Update channel (default: latest)",
    )
    parser.add_argument(
        "--component",
        choices=("gui", "cli"),
        default="gui",
        help="Asset component to include (default: gui; CLI is not consumed by the desktop updater)",
    )
    parser.add_argument("--name", default="", help="Release display name")
    parser.add_argument("--published-at", default="", help="ISO8601 published time")
    parser.add_argument(
        "--download-base-url",
        default="",
        help="Primary release download base URL; GitHub is retained in apiUrl as fallback",
    )
    parser.add_argument(
        "--download-tag",
        default="",
        help="Optional tag/path segment for the primary download URL; manifest and GitHub tag stay unchanged",
    )
    parser.add_argument(
        "--download-dispatcher-url",
        default="",
        help="HTTPS JSON/302 dispatcher endpoint used for immutable assets",
    )
    parser.add_argument(
        "--download-path-prefix",
        default="",
        help="Immutable asset path prefix passed to the dispatcher",
    )
    parser.add_argument(
        "--output",
        default="",
        help="Output path (default: <assets-dir>/latest.json or latest-dev.json)",
    )
    parser.add_argument(
        "--release-notes-file",
        default="",
        help="Optional Markdown file embedded into releaseNotes for in-app changelog",
    )
    args = parser.parse_args()

    assets_dir = Path(args.assets_dir).resolve()
    if not assets_dir.is_dir():
        print(f"assets dir not found: {assets_dir}", file=sys.stderr)
        return 2

    tag = args.tag.strip()
    if not tag:
        if args.channel == "dev":
            tag = "dev-latest"
        else:
            ver = normalize_version(args.version)
            tag = f"v{ver}" if ver else ""

    out_name = "latest-dev.json" if args.channel == "dev" else "latest.json"
    output = Path(args.output).resolve() if args.output else assets_dir / out_name
    notes_path = Path(args.release_notes_file).resolve() if args.release_notes_file.strip() else None
    release_notes = load_release_notes(notes_path)
    if args.download_base_url and args.download_dispatcher_url:
        print("choose either --download-base-url or --download-dispatcher-url", file=sys.stderr)
        return 2
    if args.download_dispatcher_url and not args.download_path_prefix.strip():
        print("--download-path-prefix is required with --download-dispatcher-url", file=sys.stderr)
        return 2

    manifest = build_manifest(
        channel=args.channel,
        version=args.version,
        tag=tag,
        assets_dir=assets_dir,
        name=args.name or None,
        published_at=args.published_at or None,
        download_base_url=args.download_base_url,
        download_tag=args.download_tag,
        download_dispatcher_url=args.download_dispatcher_url,
        download_path_prefix=args.download_path_prefix,
        release_notes=release_notes,
        component=args.component,
    )
    output.write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    notes_hint = f", notes={len(manifest.get('releaseNotes', ''))} chars" if manifest.get("releaseNotes") else ""
    print(f"wrote {output} ({len(manifest['assets'])} assets, version={manifest['version']}{notes_hint})")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
