#!/usr/bin/env python3

import argparse
import json
import os
import shutil
import sys
import tempfile
import urllib.error
import urllib.parse
import urllib.request
import zipfile
from pathlib import Path


DRIVERS = [
    "mariadb",
    "oceanbase",
    "doris",
    "starrocks",
    "sphinx",
    "sqlserver",
    "sqlite",
    "duckdb",
    "dameng",
    "kingbase",
    "highgo",
    "vastbase",
    "opengauss",
    "gaussdb",
    "iris",
    "mongodb",
    "tdengine",
    "iotdb",
    "clickhouse",
    "elasticsearch",
    "trino",
]

BUNDLE_NAME = "GoNavi-DriverAgents.zip"


def asset_download_url(asset):
    """Prefer the public release URL over the API asset endpoint.

    GitHub's asset API endpoint is subject to REST quota and can reject an
    otherwise public release asset. The public URL redirects directly to the
    short-lived release object URL without consuming that API request.
    """
    public_url = str(asset.get("browser_download_url") or "").strip()
    if public_url:
        return public_url
    return str(asset.get("url") or "").strip()


def required_assets():
    assets = []
    for driver in DRIVERS:
        assets.extend(
            [
                ("Windows", f"{driver}-driver-agent-windows-amd64.exe"),
                ("MacOS", f"{driver}-driver-agent-darwin-amd64"),
                ("MacOS", f"{driver}-driver-agent-darwin-arm64"),
                ("Linux", f"{driver}-driver-agent-linux-amd64"),
                ("Linux", f"{driver}-driver-agent-linux-arm64"),
            ]
        )
        if driver == "duckdb":
            assets.append(("Windows", "duckdb.dll"))
        else:
            assets.append(("Windows", f"{driver}-driver-agent-windows-arm64.exe"))
    return assets


def github_headers():
    headers = {
        "Accept": "application/vnd.github+json",
        "User-Agent": "GoNavi-CI",
    }
    token = os.environ.get("DRIVER_RELEASE_TOKEN") or os.environ.get("GITHUB_TOKEN")
    if token:
        headers["Authorization"] = f"Bearer {token}"
    return headers


def fetch_json(url):
    req = urllib.request.Request(url, headers=github_headers())
    with urllib.request.urlopen(req, timeout=30) as resp:
        return json.loads(resp.read().decode("utf-8"))


def download_asset(asset, destination):
    url = asset_download_url(asset)
    if not url:
        raise ValueError(f"release asset is missing a download URL: {asset.get('name', '<unnamed>')}")
    headers = {"User-Agent": "GoNavi-CI"}
    if url == str(asset.get("url") or "").strip():
        headers = github_headers()
        headers["Accept"] = "application/octet-stream"
    req = urllib.request.Request(url, headers=headers)
    with urllib.request.urlopen(req, timeout=120) as resp:
        with open(destination, "wb") as out:
            shutil.copyfileobj(resp, out)


def load_release(repo, source):
    owner_repo = repo.strip()
    if not owner_repo:
        raise ValueError("repo is required")
    if source == "latest":
        api_url = f"https://api.github.com/repos/{owner_repo}/releases/latest"
    else:
        api_url = f"https://api.github.com/repos/{owner_repo}/releases/tags/{urllib.parse.quote(source, safe='')}"
    try:
        return fetch_json(api_url)
    except urllib.error.HTTPError as exc:
        if exc.code == 404:
            print(f"未找到上一版 driver release：{source}", file=sys.stderr)
            return None
        raise


def asset_map(release):
    result = {}
    for asset in release.get("assets", []):
        name = str(asset.get("name", "")).strip()
        if name:
            result[name] = asset
    return result


def copy_missing_from_bundle(bundle_path, target_root):
    copied = 0
    required = {
        (Path(platform) / file_name).as_posix()
        for platform, file_name in required_assets()
    }
    with zipfile.ZipFile(bundle_path) as zf:
        members = {
            Path(info.filename).as_posix(): info
            for info in zf.infolist()
            if not info.is_dir()
        }
        for item in sorted(required):
            source = members.get(item)
            if not source:
                continue
            relative = Path(item)
            target = target_root / relative
            if target.exists():
                continue
            target.parent.mkdir(parents=True, exist_ok=True)
            with zf.open(source) as src, open(target, "wb") as out:
                shutil.copyfileobj(src, out)
            copied += 1
    return copied


def copy_missing_standalone(release_assets, target_root):
    copied = 0
    with tempfile.TemporaryDirectory(prefix="gonavi-driver-assets-") as tmp:
        tmp_root = Path(tmp)
        for platform, file_name in required_assets():
            target = target_root / platform / file_name
            if target.exists():
                continue
            asset = release_assets.get(file_name)
            if not asset:
                continue
            temp_path = tmp_root / file_name
            download_asset(asset, temp_path)
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(temp_path, target)
            copied += 1
    return copied


def verify_complete(target_root):
    missing = []
    for platform, file_name in required_assets():
        if not (target_root / platform / file_name).is_file():
            missing.append(f"{platform}/{file_name}")
    return missing


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--assets-dir", required=True)
    parser.add_argument("--repo", default="Syngnat/GoNavi-DriverAgents")
    parser.add_argument(
        "--source",
        action="append",
        required=True,
        help="latest or release tag such as dev-latest/v1.0.0; may be passed more than once",
    )
    parser.add_argument("--require-complete", action="store_true")
    args = parser.parse_args()

    assets_dir = Path(args.assets_dir)
    driver_root = assets_dir / "drivers"
    driver_root.mkdir(parents=True, exist_ok=True)

    found_source = False
    total_copied = 0
    for source in args.source:
        release = load_release(args.repo, source)
        if release is None:
            continue
        found_source = True

        releases_assets = asset_map(release)
        copied = 0
        bundle_asset = releases_assets.get(BUNDLE_NAME)
        if bundle_asset:
            with tempfile.TemporaryDirectory(prefix="gonavi-driver-release-") as tmp:
                bundle_path = Path(tmp) / BUNDLE_NAME
                download_asset(bundle_asset, bundle_path)
                copied += copy_missing_from_bundle(bundle_path, driver_root)
        copied += copy_missing_standalone(releases_assets, driver_root)
        total_copied += copied
        print(f"已从 {source} 补齐 driver assets：{copied} 个文件")

        if not verify_complete(driver_root):
            break

    if not found_source:
        print("未找到可补齐的上一版 driver release。", file=sys.stderr)
    else:
        print(f"driver assets 合计补齐：{total_copied} 个文件")

    if args.require_complete:
        missing = verify_complete(driver_root)
        if missing:
            print("driver assets 不完整：", file=sys.stderr)
            for item in missing:
                print(f"  - {item}", file=sys.stderr)
            return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
