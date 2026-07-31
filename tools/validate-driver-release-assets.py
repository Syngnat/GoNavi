#!/usr/bin/env python3

import argparse
import hashlib
import json
import os
import platform
import shutil
import stat
import subprocess
import sys
import tempfile
import urllib.error
import urllib.parse
import urllib.request
import zipfile
from pathlib import Path


MANIFEST_ASSET_NAME = "GoNavi-DriverAgents-Manifest.json"
INDEX_ASSET_NAME = "GoNavi-DriverAgents-Index.json"
CI_BUNDLE_ASSET_NAME = "GoNavi-DriverAgents.zip"
DUCKDB_WINDOWS_AGENT_NAME = "duckdb-driver-agent-windows-amd64.exe"
DUCKDB_WINDOWS_LIBRARY_NAME = "duckdb.dll"

# 校验失败会让 CI 判定已发布资产不可信并退化为全量驱动重建，
# 因此网络类瞬时故障（5xx / 连接中断）需要有限退避重试。
RETRY_ATTEMPTS = 3
RETRY_BACKOFF_SECONDS = 3


def _sleep_before_retry(reason, attempt):
    wait = RETRY_BACKOFF_SECONDS * attempt
    print(
        f"warning: transient GitHub API failure ({reason}); "
        f"retry {attempt}/{RETRY_ATTEMPTS - 1} in {wait}s",
        file=sys.stderr,
    )
    time.sleep(wait)


def github_headers(binary: bool = False):
    headers = {
        "Accept": "application/octet-stream" if binary else "application/vnd.github+json",
        "User-Agent": "GoNavi-CI",
    }
    token = os.environ.get("DRIVER_RELEASE_TOKEN") or os.environ.get("GITHUB_TOKEN")
    if token:
        headers["Authorization"] = f"Bearer {token}"
    return headers


def fetch_json(url: str):
    req = urllib.request.Request(url, headers=github_headers(False))
    with urllib.request.urlopen(req, timeout=30) as resp:
        return json.loads(resp.read().decode("utf-8"))


def download_url(url: str, destination: Path):
    for attempt in range(1, RETRY_ATTEMPTS + 1):
        try:
            req = urllib.request.Request(url, headers=github_headers(False))
            with urllib.request.urlopen(req, timeout=120) as resp, open(destination, "wb") as out:
                shutil.copyfileobj(resp, out)
            return
        except urllib.error.HTTPError as exc:
            if exc.code < 500 or attempt == RETRY_ATTEMPTS:
                raise
            _sleep_before_retry(f"HTTP {exc.code}", attempt)
        except urllib.error.URLError as exc:
            if attempt == RETRY_ATTEMPTS:
                raise
            _sleep_before_retry(exc.reason, attempt)


def load_release(repo: str, tag: str):
    owner_repo = repo.strip()
    if not owner_repo:
        raise ValueError("repo is required")
    if tag == "latest":
        url = f"https://api.github.com/repos/{owner_repo}/releases/latest"
    else:
        url = f"https://api.github.com/repos/{owner_repo}/releases/tags/{urllib.parse.quote(tag, safe='')}"
    return fetch_json(url)


def asset_map(release: dict):
    result = {}
    for asset in release.get("assets", []):
        name = str(asset.get("name") or "").strip()
        if name:
            result[name] = asset
    return result


def asset_sha256_digest(asset: dict):
    digest = str(asset.get("digest") or "").strip().lower()
    prefix = "sha256:"
    if digest.startswith(prefix):
        value = digest[len(prefix) :].strip()
        if value:
            return value
    return ""


def infer_asset_path(name: str):
    trimmed = str(name or "").strip()
    if not trimmed:
        return None
    if trimmed == "duckdb.dll":
        return "Windows/duckdb.dll"
    if trimmed == "duckdb-driver.zip":
        return None
    if (
        trimmed.endswith("-driver-agent-windows-amd64.exe")
        or trimmed.endswith("-driver-agent-windows-arm64.exe")
        or trimmed.endswith("-driver-agent-v1-windows-amd64.exe")
        or trimmed.endswith("-driver-agent-v1-windows-arm64.exe")
        or trimmed.endswith("-driver-agent-v2-windows-amd64.exe")
        or trimmed.endswith("-driver-agent-v2-windows-arm64.exe")
    ):
        return f"Windows/{trimmed}"
    if (
        trimmed.endswith("-driver-agent-darwin-amd64")
        or trimmed.endswith("-driver-agent-darwin-arm64")
        or trimmed.endswith("-driver-agent-v1-darwin-amd64")
        or trimmed.endswith("-driver-agent-v1-darwin-arm64")
        or trimmed.endswith("-driver-agent-v2-darwin-amd64")
        or trimmed.endswith("-driver-agent-v2-darwin-arm64")
    ):
        return f"MacOS/{trimmed}"
    if (
        trimmed.endswith("-driver-agent-linux-amd64")
        or trimmed.endswith("-driver-agent-linux-arm64")
        or trimmed.endswith("-driver-agent-v1-linux-amd64")
        or trimmed.endswith("-driver-agent-v1-linux-arm64")
        or trimmed.endswith("-driver-agent-v2-linux-amd64")
        or trimmed.endswith("-driver-agent-v2-linux-arm64")
    ):
        return f"Linux/{trimmed}"
    return None


def infer_driver_zip_asset_name(name: str):
    trimmed = str(name or "").strip()
    if not trimmed or infer_asset_path(trimmed) is None or "-driver-agent-" not in trimmed:
        return None
    if trimmed.lower().endswith(".exe"):
        trimmed = trimmed[:-4]
    return f"{trimmed}.zip"


def extract_zip_entry(zip_path: Path, entry_name: str, destination: Path):
    expected = str(entry_name or "").strip().replace("\\", "/")
    if not expected:
        return False
    with zipfile.ZipFile(zip_path) as archive:
        entry = None
        for candidate in archive.infolist():
            normalized = candidate.filename.replace("\\", "/")
            while normalized.startswith("./"):
                normalized = normalized[2:]
            if not candidate.is_dir() and normalized == expected:
                entry = candidate
                break
        if entry is None:
            return False
        destination.parent.mkdir(parents=True, exist_ok=True)
        with archive.open(entry) as source, open(destination, "wb") as output:
            shutil.copyfileobj(source, output)
    return True


def normalize_machine(value: str):
    machine = str(value or "").strip().lower()
    if machine in {"x86_64", "amd64"}:
        return "amd64"
    if machine in {"aarch64", "arm64"}:
        return "arm64"
    return machine


def current_runtime_platform():
    system = platform.system().lower()
    if system == "darwin":
        goos = "darwin"
    elif system == "windows":
        goos = "windows"
    elif system == "linux":
        goos = "linux"
    else:
        return ""
    goarch = normalize_machine(platform.machine())
    if not goarch:
        return ""
    return f"{goos}/{goarch}"


def sha256_file(path: Path):
    h = hashlib.sha256()
    with open(path, "rb") as fh:
        for chunk in iter(lambda: fh.read(1024 * 1024), b""):
            if not chunk:
                break
            h.update(chunk)
    return h.hexdigest()


def probe_metadata_revision(path: Path):
    current_mode = path.stat().st_mode
    path.chmod(current_mode | stat.S_IXUSR)
    proc = subprocess.run(
        [str(path)],
        input=b'{"id":1,"method":"metadata"}\n',
        capture_output=True,
        timeout=20,
        check=True,
    )
    if not proc.stdout:
        raise RuntimeError(f"{path.name}: metadata output is empty")
    payload = json.loads(proc.stdout.decode("utf-8"))
    return str(((payload.get("data") or {}).get("agentRevision") or "")).strip()


def _validate_legacy_release_assets(release: dict, manifest: dict, runtime_platform=None):
    assets = asset_map(release)
    manifest_assets = manifest.get("assets") or {}
    if not isinstance(manifest_assets, dict) or not manifest_assets:
        raise RuntimeError("manifest assets is empty")

    if runtime_platform is None:
        runtime_platform = current_runtime_platform()
    runtime_platform = str(runtime_platform or "").strip().lower()

    mismatches = []
    skipped = []
    with tempfile.TemporaryDirectory(prefix="gonavi-release-assets-") as tmp:
        tmp_root = Path(tmp)
        for name, meta in sorted(manifest_assets.items()):
            if name == MANIFEST_ASSET_NAME:
                continue
            path_hint = infer_asset_path(name)
            zip_asset_name = infer_driver_zip_asset_name(name)
            zip_asset = assets.get(zip_asset_name) if zip_asset_name else None
            legacy_asset = assets.get(name)
            if zip_asset is None and legacy_asset is None:
                mismatches.append((name, "missing_release_asset", "", "present in manifest"))
                continue

            expected_sha = str(meta.get("sha256") or "").strip().lower()
            expected_revision = str(meta.get("revision") or "").strip()
            asset_platform = str(meta.get("platform") or "").strip().lower()

            local_path = None
            actual_sha = ""
            if zip_asset is not None:
                archive_path = tmp_root / "archives" / zip_asset_name
                archive_path.parent.mkdir(parents=True, exist_ok=True)
                download_url(str(zip_asset.get("browser_download_url") or "").strip(), archive_path)
                local_path = tmp_root / "extracted" / name
                try:
                    found_entry = extract_zip_entry(archive_path, path_hint, local_path)
                except zipfile.BadZipFile as exc:
                    mismatches.append((name, "zip", str(exc), "valid zip archive"))
                    continue
                if not found_entry:
                    mismatches.append((name, "zip_entry", "", path_hint or name))
                    continue
                actual_sha = sha256_file(local_path).lower()
            else:
                actual_sha = asset_sha256_digest(legacy_asset)
                if expected_sha and not actual_sha:
                    local_path = tmp_root / name
                    download_url(str(legacy_asset.get("browser_download_url") or "").strip(), local_path)
                    actual_sha = sha256_file(local_path).lower()
            if expected_sha and actual_sha != expected_sha:
                mismatches.append((name, "sha256", actual_sha, expected_sha))
                continue

            if path_hint is None:
                skipped.append(name)
                continue

            if expected_revision and asset_platform == runtime_platform:
                if local_path is None:
                    local_path = tmp_root / name
                    download_url(str(legacy_asset.get("browser_download_url") or "").strip(), local_path)
                actual_revision = probe_metadata_revision(local_path)
                if actual_revision != expected_revision:
                    mismatches.append((name, "revision", actual_revision, expected_revision))

    return mismatches, skipped


def is_nonnegative_int(value):
    return isinstance(value, int) and not isinstance(value, bool) and value >= 0


def is_sha256(value):
    normalized = str(value or "").strip().lower()
    return len(normalized) == 64 and all(char in "0123456789abcdef" for char in normalized)


def is_basename(value):
    normalized = str(value or "").strip()
    return normalized not in {"", ".", ".."} and "/" not in normalized and "\\" not in normalized


def is_safe_archive_entry_path(value):
    normalized = str(value or "").strip().replace("\\", "/")
    if not normalized or normalized.startswith("/"):
        return False
    if len(normalized) >= 3 and normalized[0].isalpha() and normalized[1:3] == ":/":
        return False
    parts = normalized.split("/")
    return all(part not in {"", ".", ".."} for part in parts)


def indexed_release_maps(release_index):
    if release_index is None:
        return None
    if not isinstance(release_index, dict):
        raise RuntimeError("release index must be an object")
    if "entries" not in release_index and "assetSha256" not in release_index:
        return None

    result = []
    for key in ("assets", "assetSha256", "entries"):
        value = release_index.get(key)
        if not isinstance(value, dict) or not value:
            raise RuntimeError(f"release index {key} must be a non-empty object")
        result.append(value)
    return tuple(result)


def _validate_indexed_release_assets(
    release: dict,
    manifest: dict,
    runtime_platform: str,
    index_assets: dict,
    index_asset_sha256: dict,
    index_entries: dict,
):
    release_assets = asset_map(release)
    manifest_assets = manifest.get("assets") or {}
    if not isinstance(manifest_assets, dict) or not manifest_assets:
        raise RuntimeError("manifest assets is empty")

    mismatches = []
    skipped = []
    archive_metadata_valid = {}

    for archive_name, expected_size in sorted(index_assets.items()):
        archive = str(archive_name or "").strip()
        valid = True
        if not is_basename(archive):
            mismatches.append((archive, "index_asset_name", archive, "archive basename"))
            archive_metadata_valid[archive] = False
            continue
        if archive == CI_BUNDLE_ASSET_NAME:
            mismatches.append((archive, "index_ci_bundle", "present in assets", "absent"))
            valid = False
        if not is_nonnegative_int(expected_size):
            mismatches.append((archive, "index_archive_size", expected_size, "non-negative integer"))
            valid = False

        expected_sha = str(index_asset_sha256.get(archive) or "").strip().lower()
        if not is_sha256(expected_sha):
            mismatches.append((archive, "index_archive_sha256", expected_sha, "sha256"))
            valid = False

        release_asset = release_assets.get(archive)
        if release_asset is None:
            mismatches.append((archive, "missing_release_asset", "", "present in release index"))
            archive_metadata_valid[archive] = False
            continue

        actual_size = release_asset.get("size")
        if actual_size != expected_size:
            mismatches.append((archive, "archive_size", actual_size, expected_size))
            valid = False
        actual_sha = asset_sha256_digest(release_asset)
        if actual_sha != expected_sha:
            mismatches.append((archive, "archive_sha256", actual_sha, expected_sha))
            valid = False
        archive_metadata_valid[archive] = valid

    for archive_name in sorted(index_asset_sha256):
        if archive_name == CI_BUNDLE_ASSET_NAME:
            mismatches.append((archive_name, "index_ci_bundle_sha256", "present in assetSha256", "absent"))
        if archive_name not in index_assets:
            mismatches.append((archive_name, "index_asset", "assetSha256", "assets"))

    normalized_entries = {}
    entry_metadata_valid = {}
    for raw_name, raw_entry in sorted(index_entries.items(), key=lambda item: str(item[0])):
        name = str(raw_name or "").strip()
        valid = True
        if not is_basename(name):
            mismatches.append((name, "index_entry_name", name, "basename"))
            entry_metadata_valid[name] = False
            continue
        if not isinstance(raw_entry, dict):
            mismatches.append((name, "index_entry", type(raw_entry).__name__, "object"))
            entry_metadata_valid[name] = False
            continue

        archive = str(raw_entry.get("archive") or "").strip()
        entry_path = str(raw_entry.get("path") or "").strip().replace("\\", "/")
        entry_size = raw_entry.get("size")
        entry_sha = str(raw_entry.get("sha256") or "").strip().lower()
        normalized_entries[name] = {
            "archive": archive,
            "path": entry_path,
            "size": entry_size,
            "sha256": entry_sha,
        }

        if not is_basename(archive):
            mismatches.append((name, "index_archive", archive, "archive basename"))
            valid = False
        elif archive == CI_BUNDLE_ASSET_NAME:
            mismatches.append((name, "index_ci_bundle_entry", archive, "individual driver archive"))
            valid = False
        if archive not in index_assets:
            mismatches.append((name, "index_asset", archive, "present in assets"))
            valid = False
        if archive not in index_asset_sha256:
            mismatches.append((name, "index_asset_sha256", archive, "present in assetSha256"))
            valid = False
        if not is_safe_archive_entry_path(entry_path):
            mismatches.append((name, "index_entry_path", entry_path, "safe relative archive path"))
            valid = False
        expected_path = infer_asset_path(name)
        if expected_path is not None and entry_path != expected_path:
            mismatches.append((name, "index_path", entry_path, expected_path))
            valid = False
        if not is_nonnegative_int(entry_size):
            mismatches.append((name, "index_entry_size", entry_size, "non-negative integer"))
            valid = False
        if not is_sha256(entry_sha):
            mismatches.append((name, "index_entry_sha256", entry_sha, "sha256"))
            valid = False
        if name == DUCKDB_WINDOWS_LIBRARY_NAME:
            expected_archive = infer_driver_zip_asset_name(DUCKDB_WINDOWS_AGENT_NAME)
            if archive != expected_archive:
                mismatches.append((name, "index_archive", archive, expected_archive))
                valid = False
        entry_metadata_valid[name] = valid

    if DUCKDB_WINDOWS_AGENT_NAME in normalized_entries and DUCKDB_WINDOWS_LIBRARY_NAME not in normalized_entries:
        mismatches.append(
            (
                DUCKDB_WINDOWS_LIBRARY_NAME,
                "index_entry",
                "",
                f"present with {DUCKDB_WINDOWS_AGENT_NAME}",
            )
        )

    runtime_manifest_entries = []
    for name, meta in sorted(manifest_assets.items()):
        if name == MANIFEST_ASSET_NAME:
            continue
        if not isinstance(meta, dict):
            mismatches.append((name, "manifest_entry", type(meta).__name__, "object"))
            continue

        path_hint = infer_asset_path(name)
        archive_hint = infer_driver_zip_asset_name(name)
        if path_hint is None or archive_hint is None:
            skipped.append(name)
            continue

        entry = normalized_entries.get(name)
        if entry is None:
            mismatches.append((name, "index_entry", "", "present in release index"))
            continue

        entry_valid = entry_metadata_valid.get(name, False)
        indexed_archive = entry["archive"]
        indexed_path = entry["path"]
        indexed_size = entry.get("size")
        indexed_sha = entry["sha256"]
        manifest_size = meta.get("size")
        manifest_sha = str(meta.get("sha256") or "").strip().lower()

        if indexed_archive != archive_hint:
            mismatches.append((name, "index_archive", indexed_archive, archive_hint))
            entry_valid = False
        if indexed_path != path_hint:
            mismatches.append((name, "index_path", indexed_path, path_hint))
            entry_valid = False
        if not is_nonnegative_int(manifest_size):
            mismatches.append((name, "manifest_size", manifest_size, "non-negative integer"))
            entry_valid = False
        elif indexed_size != manifest_size:
            mismatches.append((name, "index_size", indexed_size, manifest_size))
            entry_valid = False
        if not is_sha256(manifest_sha):
            mismatches.append((name, "manifest_sha256", manifest_sha, "sha256"))
            entry_valid = False
        elif indexed_sha != manifest_sha:
            mismatches.append((name, "index_sha256", indexed_sha, manifest_sha))
            entry_valid = False
        asset_platform = str(meta.get("platform") or "").strip().lower()
        if entry_valid and asset_platform == runtime_platform and archive_metadata_valid.get(indexed_archive, False):
            runtime_manifest_entries.append((name, meta, indexed_archive))

    runtime_by_archive = {}
    for name, meta, archive in runtime_manifest_entries:
        runtime_by_archive.setdefault(archive, []).append((name, meta))

    with tempfile.TemporaryDirectory(prefix="gonavi-release-assets-") as tmp:
        tmp_root = Path(tmp)
        for archive, manifest_entries in sorted(runtime_by_archive.items()):
            release_asset = release_assets[archive]
            archive_path = tmp_root / "archives" / archive
            archive_path.parent.mkdir(parents=True, exist_ok=True)
            download_url(str(release_asset.get("browser_download_url") or "").strip(), archive_path)

            expected_archive_size = index_assets[archive]
            actual_archive_size = archive_path.stat().st_size
            if actual_archive_size != expected_archive_size:
                mismatches.append((archive, "download_size", actual_archive_size, expected_archive_size))
                continue
            expected_archive_sha = str(index_asset_sha256[archive]).strip().lower()
            actual_archive_sha = sha256_file(archive_path).lower()
            if actual_archive_sha != expected_archive_sha:
                mismatches.append((archive, "download_sha256", actual_archive_sha, expected_archive_sha))
                continue

            archive_entries = {
                raw_name: entry
                for raw_name, entry in normalized_entries.items()
                if entry_metadata_valid.get(raw_name, False) and entry["archive"] == archive
            }
            extracted = {}
            try:
                for raw_name, entry in sorted(archive_entries.items()):
                    entry_path = entry["path"]
                    entry_size = entry.get("size")
                    entry_sha = entry["sha256"]
                    local_path = tmp_root / "extracted" / archive / raw_name
                    if not extract_zip_entry(archive_path, entry_path, local_path):
                        mismatches.append((raw_name, "zip_entry", "", entry_path))
                        continue
                    actual_size = local_path.stat().st_size
                    if actual_size != entry_size:
                        mismatches.append((raw_name, "entry_size", actual_size, entry_size))
                        continue
                    actual_sha = sha256_file(local_path).lower()
                    if actual_sha != entry_sha:
                        mismatches.append((raw_name, "entry_sha256", actual_sha, entry_sha))
                        continue
                    extracted[raw_name] = local_path
            except zipfile.BadZipFile as exc:
                mismatches.append((archive, "zip", str(exc), "valid zip archive"))
                continue

            for name, meta in manifest_entries:
                local_path = extracted.get(name)
                if local_path is None:
                    continue
                expected_revision = str(meta.get("revision") or "").strip()
                if not expected_revision:
                    continue
                actual_revision = probe_metadata_revision(local_path)
                if actual_revision != expected_revision:
                    mismatches.append((name, "revision", actual_revision, expected_revision))

    return mismatches, skipped


def validate_release_assets(release: dict, manifest: dict, runtime_platform=None, release_index=None):
    if runtime_platform is None:
        runtime_platform = current_runtime_platform()
    normalized_runtime = str(runtime_platform or "").strip().lower()
    index_maps = indexed_release_maps(release_index)
    if index_maps is None:
        return _validate_legacy_release_assets(release, manifest, normalized_runtime)
    return _validate_indexed_release_assets(
        release,
        manifest,
        normalized_runtime,
        *index_maps,
    )


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--repo", default="Syngnat/GoNavi-DriverAgents")
    parser.add_argument("--tag", required=True)
    args = parser.parse_args()

    release = load_release(args.repo, args.tag)
    assets = asset_map(release)
    manifest_asset = assets.get(MANIFEST_ASSET_NAME)
    if manifest_asset is None:
        raise SystemExit(f"release {args.repo}@{args.tag} missing {MANIFEST_ASSET_NAME}")
    index_asset = assets.get(INDEX_ASSET_NAME)

    with tempfile.TemporaryDirectory(prefix="gonavi-release-manifest-") as tmp:
        metadata_root = Path(tmp)
        manifest_path = metadata_root / MANIFEST_ASSET_NAME
        download_url(str(manifest_asset.get("browser_download_url") or "").strip(), manifest_path)
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
        release_index = None
        if index_asset is not None:
            index_path = metadata_root / INDEX_ASSET_NAME
            download_url(str(index_asset.get("browser_download_url") or "").strip(), index_path)
            release_index = json.loads(index_path.read_text(encoding="utf-8"))

    mismatches, skipped = validate_release_assets(release, manifest, release_index=release_index)
    if mismatches:
        print("published driver release assets mismatch manifest:", file=sys.stderr)
        for name, field, actual, expected in mismatches:
            print(f"  - {name} [{field}] actual={actual or '<empty>'} expected={expected or '<empty>'}", file=sys.stderr)
        raise SystemExit(1)

    checked = len((manifest.get("assets") or {})) - len(skipped)
    print(f"driver release assets validation passed: checked={checked} skipped={len(skipped)}")
    if skipped:
        print("skipped assets: " + ", ".join(sorted(skipped)))
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except urllib.error.HTTPError as exc:
        print(f"http error: {exc.code}", file=sys.stderr)
        raise
