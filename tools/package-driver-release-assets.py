#!/usr/bin/env python3

import hashlib
import json
import os
import re
import shutil
import sys
import zipfile
from concurrent.futures import ProcessPoolExecutor
from pathlib import Path

from driver_bundle_7z import BUNDLE_NAME, create_bundle


ROOT = Path(__file__).resolve().parent.parent
LEGAL_FILENAMES = ("LICENSE", "NOTICE")
DRIVER_AGENT_RE = re.compile(
    r"^.+-driver-agent(?:-v[0-9]+)?-(?:darwin|linux|windows)-(?:amd64|arm64)(?:\.exe)?$"
)
DUCKDB_WINDOWS_AGENT = "duckdb-driver-agent-windows-amd64.exe"
DUCKDB_WINDOWS_LIBRARY = "duckdb.dll"


def individual_archive_name(asset_name: str) -> str:
    if asset_name.lower().endswith(".exe"):
        return asset_name[:-4] + ".zip"
    return asset_name + ".zip"


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def write_individual_archive(
    archive_path: Path,
    asset: Path,
    arcname: str,
    legal_files: list[Path],
) -> list[tuple[Path, str]]:
    entries = [(asset, arcname)]
    if asset.name == DUCKDB_WINDOWS_AGENT:
        support_file = asset.with_name(DUCKDB_WINDOWS_LIBRARY)
        if not support_file.is_file():
            raise RuntimeError(
                f"DuckDB Windows runtime dependency not found: {support_file}"
            )
        entries.append(
            (
                support_file,
                (Path(arcname).parent / DUCKDB_WINDOWS_LIBRARY).as_posix(),
            )
        )

    with zipfile.ZipFile(archive_path, "w", compression=zipfile.ZIP_DEFLATED) as zf:
        for source, entry_name in entries:
            zf.write(source, entry_name)
        for legal_file in legal_files:
            zf.write(legal_file, legal_file.name)
    return entries


def build_individual_archive(job):
    """Worker: write one per-driver archive and return its index metadata."""
    archive_path, asset, arcname, legal_files = job
    entries = write_individual_archive(archive_path, asset, arcname, legal_files)
    return (
        archive_path.name,
        archive_path.stat().st_size,
        sha256_file(archive_path),
        [
            (source.name, entry_path, source.stat().st_size, sha256_file(source))
            for source, entry_path in entries
        ],
    )


def main():
    if len(sys.argv) != 3:
        raise SystemExit("usage: package-driver-release-assets.py <drivers-dir> <output-dir>")

    drivers_dir = Path(sys.argv[1]).resolve()
    output_dir = Path(sys.argv[2]).resolve()

    if not drivers_dir.is_dir():
        raise SystemExit(f"drivers dir not found: {drivers_dir}")

    legal_files = [ROOT / filename for filename in LEGAL_FILENAMES]
    missing_legal_files = [path for path in legal_files if not path.is_file()]
    if missing_legal_files:
        missing = ", ".join(str(path) for path in missing_legal_files)
        raise SystemExit(f"legal notice files not found: {missing}")

    out_name = BUNDLE_NAME
    index_name = "GoNavi-DriverAgents-Index.json"
    manifest_name = "GoNavi-DriverAgents-Manifest.json"

    if output_dir.exists():
        shutil.rmtree(output_dir)
    output_dir.mkdir(parents=True, exist_ok=True)

    out_path = output_dir / out_name
    index_path = output_dir / index_name
    manifest_path = output_dir / manifest_name

    size_index = {}
    archive_sha256_index = {}
    entry_index = {}
    individual_archives = []
    source_assets = []
    for asset in sorted(drivers_dir.rglob("*")):
        if not asset.is_file():
            continue
        arcname = asset.relative_to(drivers_dir).as_posix()
        if any(existing.name == asset.name for existing, _ in source_assets):
            raise RuntimeError(f"driver asset name conflict: {asset.name}")
        # Dedicated source packages are regenerated below from their raw
        # agent and support files. Keeping a zip inside the CI bundle only
        # wastes space and is not needed by the completion step.
        if asset.suffix.lower() == ".zip":
            continue
        source_assets.append((asset, arcname))

    for legal_file in legal_files:
        standalone_path = output_dir / legal_file.name
        if standalone_path.exists():
            raise RuntimeError(f"release asset already exists: {standalone_path}")
        shutil.copy2(legal_file, standalone_path)

    jobs = []
    for asset, arcname in source_assets:
        if not DRIVER_AGENT_RE.fullmatch(asset.name):
            continue
        archive_path = output_dir / individual_archive_name(asset.name)
        if archive_path.exists() or any(job[0] == archive_path for job in jobs):
            raise RuntimeError(f"release asset already exists: {archive_path}")
        jobs.append((archive_path, asset, arcname, legal_files))

    # Per-driver archives are independent single-threaded deflate jobs: spread them
    # over all cores and let the multi-threaded 7z bundle run alongside, so the
    # packaging step stays as fast as the former single ZIP bundle.
    with ProcessPoolExecutor(max_workers=os.cpu_count() or 1) as pool:
        futures = [pool.submit(build_individual_archive, job) for job in jobs]
        create_bundle(out_path, drivers_dir, [arcname for _, arcname in source_assets], legal_files)
        results = [future.result() for future in futures]

    for archive_name, archive_size, archive_sha256, archive_entries in results:
        size_index[archive_name] = archive_size
        archive_sha256_index[archive_name] = archive_sha256
        for source_name, entry_path, source_size, source_sha256 in archive_entries:
            if source_name in entry_index:
                raise RuntimeError(f"driver archive entry name conflict: {source_name}")
            entry_index[source_name] = {
                "archive": archive_name,
                "path": entry_path,
                "size": source_size,
                "sha256": source_sha256,
            }
        individual_archives.append(archive_name)

    if not individual_archives:
        raise RuntimeError("no driver agent binaries found")

    index_path.write_text(
        json.dumps(
            {
                "assets": size_index,
                "assetSha256": archive_sha256_index,
                "entries": entry_index,
            },
            ensure_ascii=False,
            indent=2,
            sort_keys=True,
        )
        + "\n",
        encoding="utf-8",
    )

    print(f"created {out_name} size={out_path.stat().st_size} bytes")
    print(f"created {index_name} entries={len(size_index)}")
    print(f"published individual driver archives={len(individual_archives)}")
    print(f"bundled legal files={len(legal_files)}")
    print(f"reserved manifest output path: {manifest_path}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
