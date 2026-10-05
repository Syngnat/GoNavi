"""7-Zip helpers for the GoNavi driver bundle (GoNavi-DriverAgents.7z).

The deflate ZIP bundle grew past GitHub's 2 GiB release asset limit. LZMA2 with a
large dictionary lets agents of the same platform share their Go runtime and
library code across files. The fast preset (-mx=1, hash-chain match finder) keeps
that cross-file gain while staying faster than the former single-threaded ZIP
bundle: on the real windows-amd64 agents with 4 threads it wrote 31% of the
deflate size in 23s versus 89s for the ZIP; -mx=9 only reached 25% and took 245s.
A 128 MiB dictionary compresses as well as 256 MiB and halves decoder memory.

The GoNavi app reads the bundle with github.com/bodgit/sevenzip, so the filters
used here must stay within what that reader decodes: x86 BCJ is supported, the
ARM64 branch filter that newer 7-Zip versions pick automatically is not. Filters
are therefore always passed explicitly instead of relying on auto-detection.
"""

import os
import re
import shutil
import subprocess
import tempfile
from pathlib import Path


BUNDLE_NAME = "GoNavi-DriverAgents.7z"
LEGACY_BUNDLE_NAME = "GoNavi-DriverAgents.zip"
SEVEN_ZIP_ENV = "GONAVI_7Z"
SEVEN_ZIP_CANDIDATES = ("7zz", "7z", "7za", "7zr")
COMPRESSION_ARGS = ("-t7z", "-m0=lzma2", "-mx=1", "-md=128m", "-ms=on", "-mmt=on")
FILTER_BY_ARCH = {"amd64": "BCJ", "arm64": "off"}
ARCH_RE = re.compile(r"-(amd64|arm64)(?:\.exe)?$", re.IGNORECASE)
WINDOWS_AMD64_SUPPORT_FILES = {"duckdb.dll"}


def find_seven_zip():
    override = os.environ.get(SEVEN_ZIP_ENV, "").strip()
    if override:
        return override
    for name in SEVEN_ZIP_CANDIDATES:
        found = shutil.which(name)
        if found:
            return found
    raise RuntimeError(
        f"7-Zip command not found; install 7zip (or p7zip-full) or set {SEVEN_ZIP_ENV}"
    )


def _run(args, cwd):
    return subprocess.run(
        [find_seven_zip(), *args],
        cwd=cwd,
        check=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        encoding="utf-8",
        errors="replace",
    )


def _run_with_list_file(args, members, cwd):
    with tempfile.TemporaryDirectory(prefix="gonavi-7z-list-") as tmp:
        list_file = Path(tmp) / "members.txt"
        list_file.write_text("".join(f"{member}\n" for member in members), encoding="utf-8")
        return _run([*args, "-scsUTF-8", f"@{list_file}"], cwd)


def asset_arch(name):
    if name.lower() in WINDOWS_AMD64_SUPPORT_FILES:
        return "amd64"
    match = ARCH_RE.search(name)
    return match.group(1).lower() if match else ""


def create_bundle(output_path, drivers_dir, members, legal_files):
    """Write one solid block per platform/arch group, then the legal files.

    members are paths relative to drivers_dir (POSIX separators). Splitting the
    blocks keeps a single-entry extraction from decoding the whole bundle.
    """
    output_path = Path(output_path).resolve()
    groups = {}
    for member in members:
        platform = member.split("/", 1)[0] if "/" in member else ""
        groups.setdefault((platform, asset_arch(Path(member).name)), []).append(member)
    for (_platform, arch), group in sorted(groups.items()):
        filter_name = FILTER_BY_ARCH.get(arch, "off")
        _run_with_list_file(
            ["a", *COMPRESSION_ARGS, f"-mf={filter_name}", "-bd", str(output_path)],
            sorted(group),
            Path(drivers_dir),
        )
    for legal_file in legal_files:
        legal_file = Path(legal_file)
        _run(
            ["a", *COMPRESSION_ARGS, "-mf=off", "-bd", str(output_path), legal_file.name],
            legal_file.parent,
        )


def list_members(bundle_path):
    """Return the file paths stored in a 7z archive (directories excluded)."""
    proc = _run(["l", "-slt", str(Path(bundle_path).resolve())], Path(bundle_path).resolve().parent)
    members = set()
    in_entries = False
    current = {}

    def flush():
        path = current.get("Path", "")
        if path and not current.get("Attributes", "").startswith("D"):
            members.add(path.replace("\\", "/"))

    for line in proc.stdout.splitlines():
        if line.startswith("----------"):
            in_entries = True
            continue
        if not in_entries:
            continue
        if not line.strip():
            flush()
            current = {}
            continue
        key, sep, value = line.partition(" = ")
        if sep:
            current[key.strip()] = value
    flush()
    return members


def extract_members(bundle_path, members, target_root):
    """Extract members (archive paths) under target_root, keeping their paths."""
    if not members:
        return
    target_root = Path(target_root).resolve()
    target_root.mkdir(parents=True, exist_ok=True)
    _run_with_list_file(
        ["x", str(Path(bundle_path).resolve()), f"-o{target_root}", "-y", "-aos"],
        sorted(members),
        target_root,
    )
