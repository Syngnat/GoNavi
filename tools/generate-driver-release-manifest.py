#!/usr/bin/env python3

import argparse
import hashlib
import json
import os
import shlex
import shutil
import subprocess
import sys
import tempfile
import time
from pathlib import Path


METADATA_PROBE_ATTEMPTS = 3


def parse_args():
    parser = argparse.ArgumentParser()
    parser.add_argument("--assets-dir", required=True, help="driver release staging dir that contains standalone driver assets")
    parser.add_argument("--output", help="release manifest json output path")
    parser.add_argument(
        "--provenance",
        action="append",
        default=[],
        help="manifest/provenance JSON file or directory; may be passed more than once",
    )
    parser.add_argument("--provenance-output", help="write SHA-bound build provenance and exit when --output is omitted")
    parser.add_argument("--revision-file", help="generated driver revision file used by --provenance-output")
    args = parser.parse_args()
    if not args.output and not args.provenance_output:
        parser.error("one of --output or --provenance-output is required")
    return args


def infer_driver_and_platform(file_name: str):
    suffixes = [
        ("-driver-agent-v1-darwin-amd64", "darwin/amd64"),
        ("-driver-agent-v1-darwin-arm64", "darwin/arm64"),
        ("-driver-agent-v1-linux-amd64", "linux/amd64"),
        ("-driver-agent-v1-linux-arm64", "linux/arm64"),
        ("-driver-agent-v1-windows-amd64.exe", "windows/amd64"),
        ("-driver-agent-v1-windows-arm64.exe", "windows/arm64"),
        ("-driver-agent-v2-darwin-amd64", "darwin/amd64"),
        ("-driver-agent-v2-darwin-arm64", "darwin/arm64"),
        ("-driver-agent-v2-linux-amd64", "linux/amd64"),
        ("-driver-agent-v2-linux-arm64", "linux/arm64"),
        ("-driver-agent-v2-windows-amd64.exe", "windows/amd64"),
        ("-driver-agent-v2-windows-arm64.exe", "windows/arm64"),
        ("-driver-agent-darwin-amd64", "darwin/amd64"),
        ("-driver-agent-darwin-arm64", "darwin/arm64"),
        ("-driver-agent-linux-amd64", "linux/amd64"),
        ("-driver-agent-linux-arm64", "linux/arm64"),
        ("-driver-agent-windows-amd64.exe", "windows/amd64"),
        ("-driver-agent-windows-arm64.exe", "windows/arm64"),
    ]
    for suffix, platform in suffixes:
        if file_name.endswith(suffix):
            driver = file_name[: -len(suffix)]
            return driver, platform
    return None, None


def normalize_driver(driver: str):
    value = str(driver or "").strip().lower()
    if value == "doris":
        return "diros"
    return value


def repo_root():
    return Path(__file__).resolve().parent.parent


def resolve_bash_executable():
    env_value = str(os.environ.get("BASH") or "").strip()
    if env_value:
        candidate = Path(env_value)
        if candidate.is_file():
            return str(candidate)

    resolved = shutil.which("bash")
    if resolved:
        return resolved

    if os.name == "nt":
        for candidate in (
            Path(r"C:\msys64\usr\bin\bash.exe"),
            Path(r"C:\Program Files\Git\bin\bash.exe"),
            Path(r"C:\Program Files\Git\usr\bin\bash.exe"),
            Path(r"D:\Work\DevTools\Git\Git\bin\bash.exe"),
            Path(r"D:\Work\DevTools\Git\Git\usr\bin\bash.exe"),
        ):
            if candidate.is_file():
                return str(candidate)

    raise FileNotFoundError("bash executable not found; set BASH or add bash to PATH")


def to_bash_path(path):
    text = str(path)
    if os.name == "nt":
        text = text.replace("\\", "/")
        if len(text) >= 2 and text[1] == ":":
            return f"/{text[0].lower()}{text[2:]}"
    return text


def run_bash_command(bash_executable: str, cwd: Path, command: list[str], **kwargs):
    env = dict(kwargs.pop("env", os.environ.copy()))
    if os.name == "nt":
        env.setdefault("MSYS2_PATH_TYPE", "inherit")
    command_text = " ".join(shlex.quote(str(part)) for part in command)
    bash_command = f"cd {shlex.quote(to_bash_path(cwd))} && {command_text}"
    return subprocess.run([bash_executable, "-lc", bash_command], env=env, **kwargs)


def resolve_head_commit(root: Path):
    proc = subprocess.run(
        ["git", "rev-parse", "HEAD"],
        cwd=root,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        check=True,
    )
    return proc.stdout.strip()


def parse_revision_file(path: Path):
    revisions = {}
    for line in path.read_text(encoding="utf-8").splitlines():
        stripped = line.strip()
        if not stripped.startswith('"'):
            continue
        try:
            driver, revision = stripped.rstrip(",").split(":", 1)
        except ValueError:
            continue
        revisions[driver.strip().strip('"')] = revision.strip().strip('"')
    return revisions


def resolve_host_platform():
    goos = subprocess.run(
        ["go", "env", "GOOS"],
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        check=True,
    ).stdout.strip()
    goarch = subprocess.run(
        ["go", "env", "GOARCH"],
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        check=True,
    ).stdout.strip()
    return f"{goos}/{goarch}"


def probe_agent_metadata_once(asset_path: Path):
    if os.name != "nt":
        os.chmod(asset_path, asset_path.stat().st_mode | 0o111)
    try:
        proc = subprocess.run(
            [str(asset_path)],
            input='{"id":1,"method":"metadata"}\n',
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            timeout=30,
        )
    except subprocess.TimeoutExpired as exc:
        raise RuntimeError(f"{asset_path.name}: metadata probe timed out after 30 seconds") from exc
    except OSError as exc:
        raise RuntimeError(f"{asset_path.name}: metadata probe failed to start: {exc}") from exc
    if proc.returncode != 0:
        detail = proc.stderr.strip() or f"exit code {proc.returncode}"
        raise RuntimeError(f"{asset_path.name}: metadata probe failed: {detail}")
    lines = [line.strip() for line in proc.stdout.splitlines() if line.strip()]
    if not lines:
        raise RuntimeError(f"{asset_path.name}: metadata probe returned no response")
    try:
        response = json.loads(lines[0])
    except json.JSONDecodeError as exc:
        raise RuntimeError(f"{asset_path.name}: metadata probe returned invalid JSON: {exc}") from exc
    if not response.get("success"):
        detail = str(response.get("error") or "metadata request failed").strip()
        raise RuntimeError(f"{asset_path.name}: metadata probe failed: {detail}")
    data = response.get("data") or {}
    driver_type = normalize_driver(data.get("driverType"))
    revision = str(data.get("agentRevision") or "").strip()
    if not driver_type or not revision:
        raise RuntimeError(f"{asset_path.name}: metadata response is missing driverType or agentRevision")
    return driver_type, revision


def probe_upx_unpacked_metadata(asset_path: Path):
    upx = shutil.which("upx")
    if not upx:
        return None

    tested = subprocess.run(
        [upx, "-t", str(asset_path)],
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
    )
    if tested.returncode != 0:
        return None

    with tempfile.TemporaryDirectory(prefix="gonavi-driver-agent-unpacked-") as tmp:
        unpacked_path = Path(tmp) / asset_path.name
        shutil.copy2(asset_path, unpacked_path)
        unpacked = subprocess.run(
            [upx, "-d", str(unpacked_path)],
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
        )
        if unpacked.returncode != 0:
            detail = unpacked.stderr.strip() or f"exit code {unpacked.returncode}"
            print(f"{asset_path.name}: UPX unpack fallback failed: {detail}", file=sys.stderr)
            return None
        try:
            metadata = probe_agent_metadata_once(unpacked_path)
        except RuntimeError as exc:
            print(f"{asset_path.name}: unpacked metadata probe failed: {exc}", file=sys.stderr)
            return None

    print(f"{asset_path.name}: metadata probe recovered from an unpacked UPX copy", file=sys.stderr)
    return metadata


def probe_agent_metadata(asset_path: Path):
    last_error = None
    for attempt in range(1, METADATA_PROBE_ATTEMPTS + 1):
        try:
            return probe_agent_metadata_once(asset_path)
        except RuntimeError as exc:
            last_error = exc
            print(
                f"{asset_path.name}: metadata probe attempt "
                f"{attempt}/{METADATA_PROBE_ATTEMPTS} failed: {exc}",
                file=sys.stderr,
            )
            if attempt < METADATA_PROBE_ATTEMPTS:
                time.sleep(attempt)

    unpacked_metadata = probe_upx_unpacked_metadata(asset_path)
    if unpacked_metadata is not None:
        return unpacked_metadata
    raise last_error


def load_asset_provenance(paths):
    entries = {}
    for raw_path in paths:
        source = Path(raw_path).resolve()
        if source.is_dir():
            files = sorted(source.rglob("*.json"))
        elif source.is_file():
            files = [source]
        else:
            raise RuntimeError(f"binary revision provenance path does not exist: {source}")
        for file_path in files:
            try:
                payload = json.loads(file_path.read_text(encoding="utf-8"))
            except (OSError, json.JSONDecodeError) as exc:
                raise RuntimeError(f"failed to read binary revision provenance {file_path}: {exc}") from exc
            assets = payload.get("assets") or {}
            if not isinstance(assets, dict):
                raise RuntimeError(f"binary revision provenance {file_path} has invalid assets")
            for asset_name, metadata in assets.items():
                if not isinstance(metadata, dict):
                    continue
                name = str(asset_name or "").strip()
                if not name:
                    continue
                entries.setdefault(name, []).append((file_path, metadata))
    return entries


def resolve_asset_provenance(entries, asset_name, driver, platform, sha256, size):
    candidates = entries.get(asset_name) or []
    matching = []
    for source, metadata in candidates:
        recorded_sha = str(metadata.get("sha256") or "").strip().lower()
        if recorded_sha == sha256.lower():
            matching.append((source, metadata))
    if not matching:
        if candidates:
            recorded = sorted(
                {
                    str(metadata.get("sha256") or "<missing>").strip() or "<missing>"
                    for _, metadata in candidates
                }
            )
            raise RuntimeError(
                f"{asset_name}: binary revision provenance SHA256 mismatch: "
                f"asset={sha256} recorded={','.join(recorded)}"
            )
        raise RuntimeError(
            f"{asset_name}: binary revision provenance is required for "
            f"cross-platform asset {platform}"
        )

    revisions = set()
    for source, metadata in matching:
        recorded_driver = normalize_driver(metadata.get("driver") or metadata.get("driverType"))
        recorded_platform = str(metadata.get("platform") or "").strip()
        recorded_revision = str(metadata.get("revision") or "").strip()
        recorded_size = metadata.get("size")
        if recorded_driver != driver or recorded_platform != platform:
            raise RuntimeError(
                f"{asset_name}: binary revision provenance identity mismatch in {source}: "
                f"recorded={recorded_platform}/{recorded_driver} expected={platform}/{driver}"
            )
        if recorded_size is not None and int(recorded_size) != size:
            raise RuntimeError(
                f"{asset_name}: binary revision provenance size mismatch in {source}: "
                f"recorded={recorded_size} expected={size}"
            )
        if not recorded_revision:
            raise RuntimeError(f"{asset_name}: binary revision provenance is missing revision in {source}")
        revisions.add(recorded_revision)
    if len(revisions) != 1:
        raise RuntimeError(
            f"{asset_name}: conflicting binary revision provenance: {','.join(sorted(revisions))}"
        )
    return revisions.pop()


def write_build_provenance(asset_entries, revision_file: Path, output_path: Path, generated_from: str):
    revisions = parse_revision_file(revision_file)
    host_platform = resolve_host_platform()
    assets = {}
    for child, driver, platform in asset_entries:
        normalized_driver = normalize_driver(driver)
        revision = str(revisions.get(normalized_driver) or "").strip()
        if not revision:
            raise RuntimeError(
                f"{child.name}: missing build revision for {platform}/{normalized_driver} in {revision_file}"
            )
        if platform == host_platform:
            binary_driver, binary_revision = probe_agent_metadata(child)
            if binary_driver != normalized_driver or binary_revision != revision:
                raise RuntimeError(
                    f"{child.name}: build provenance metadata mismatch: "
                    f"binary={binary_driver}/{binary_revision} "
                    f"expected={normalized_driver}/{revision}"
                )
            revision = binary_revision
        size = child.stat().st_size
        assets[child.name] = {
            "driver": driver,
            "driverType": driver,
            "platform": platform,
            "revision": revision,
            "size": size,
            "sha256": hashlib.sha256(child.read_bytes()).hexdigest(),
        }
    payload = {
        "schemaVersion": 1,
        "generatedFrom": generated_from,
        "assets": assets,
    }
    output_path.parent.mkdir(parents=True, exist_ok=True)
    output_path.write_text(json.dumps(payload, ensure_ascii=False, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    print(f"wrote build provenance: {output_path}")
    print(f"asset count: {len(assets)}")


def generate_platform_revisions(root: Path, drivers_by_platform):
    if not drivers_by_platform:
        return {}

    bash_executable = resolve_bash_executable()
    with tempfile.TemporaryDirectory(prefix="gonavi-driver-release-manifest-") as tmp:
        worktree = Path(tmp) / "worktree"
        subprocess.run(
            ["git", "worktree", "add", "--detach", str(worktree), "HEAD"],
            cwd=root,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            check=True,
        )
        try:
            revision_file = worktree / "internal/db/driver_agent_revisions_gen.go"
            result = {}
            for platform in sorted(drivers_by_platform):
                drivers = sorted({normalize_driver(driver) for driver in drivers_by_platform[platform] if normalize_driver(driver)})
                run_bash_command(
                    bash_executable,
                    worktree,
                    ["./tools/generate-driver-agent-revisions.sh", "--platform", platform, *([] if not drivers else ["--drivers", ",".join(drivers)])],
                    stdout=subprocess.DEVNULL,
                    stderr=subprocess.PIPE,
                    text=True,
                    check=True,
                )
                result[platform] = parse_revision_file(revision_file)
            return result
        finally:
            subprocess.run(
                ["git", "worktree", "remove", "--force", str(worktree)],
                cwd=root,
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
                check=False,
            )


def main():
    args = parse_args()
    assets_dir = Path(args.assets_dir).resolve()
    root = repo_root()
    generated_from = os.environ.get("GITHUB_SHA", "").strip() or resolve_head_commit(root)

    asset_entries = []
    for child in sorted(assets_dir.rglob("*")):
        if not child.is_file():
            continue
        driver, platform = infer_driver_and_platform(child.name)
        if not driver or not platform:
            continue
        if child.stat().st_size == 0:
            raise RuntimeError(f"{child.name}: asset is empty")
        asset_entries.append((child, driver, platform))

    if args.provenance_output:
        revision_file = Path(args.revision_file).resolve() if args.revision_file else root / "internal" / "db" / "driver_agent_revisions_gen.go"
        write_build_provenance(
            asset_entries,
            revision_file,
            Path(args.provenance_output).resolve(),
            generated_from,
        )
        if not args.output:
            return 0

    output_path = Path(args.output).resolve()
    provenance_entries = load_asset_provenance(args.provenance)
    host_platform = resolve_host_platform()

    manifest = {
        "schemaVersion": 1,
        "generatedFrom": generated_from,
        "assets": {},
    }
    fallback_entries = []
    fallback_drivers_by_platform = {}

    for child, driver, platform in asset_entries:
        normalized_driver = normalize_driver(driver)
        size = child.stat().st_size
        sha256 = hashlib.sha256(child.read_bytes()).hexdigest()

        if child.name not in provenance_entries:
            if platform != host_platform:
                resolve_asset_provenance(
                    provenance_entries,
                    child.name,
                    normalized_driver,
                    platform,
                    sha256,
                    size,
                )
            fallback_entries.append((child, driver, platform, normalized_driver, size, sha256))
            fallback_drivers_by_platform.setdefault(platform, set()).add(normalized_driver)
            continue

        revision = resolve_asset_provenance(
            provenance_entries,
            child.name,
            normalized_driver,
            platform,
            sha256,
            size,
        )
        if platform == host_platform:
            binary_driver, binary_revision = probe_agent_metadata(child)
            if binary_driver != normalized_driver:
                raise RuntimeError(
                    f"{child.name}: embedded driver type mismatch: "
                    f"binary={binary_driver} expected={normalized_driver}"
                )
            if binary_revision != revision:
                raise RuntimeError(
                    f"{child.name}: provenance revision mismatch: "
                    f"binary={binary_revision} expected={revision}"
                )
        manifest["assets"][child.name] = {
            "driver": driver,
            "driverType": driver,
            "platform": platform,
            "revision": revision,
            "size": size,
            "sha256": sha256,
        }

    if fallback_entries:
        fallback_revisions_by_platform = generate_platform_revisions(root, fallback_drivers_by_platform)
        for child, driver, platform, normalized_driver, size, sha256 in fallback_entries:
            revision = str((fallback_revisions_by_platform.get(platform) or {}).get(normalized_driver) or "").strip()
            if not revision:
                raise RuntimeError(f"{child.name}: missing revision for {platform}/{normalized_driver}")
            binary_driver, binary_revision = probe_agent_metadata(child)
            if binary_driver != normalized_driver:
                raise RuntimeError(
                    f"{child.name}: embedded driver type mismatch: "
                    f"binary={binary_driver} expected={normalized_driver}"
                )
            if binary_revision != revision:
                raise RuntimeError(
                    f"{child.name}: embedded revision mismatch: "
                    f"binary={binary_revision} expected={revision}"
                )
            manifest["assets"][child.name] = {
                "driver": driver,
                "driverType": driver,
                "platform": platform,
                "revision": binary_revision,
                "size": size,
                "sha256": sha256,
            }

    output_path.parent.mkdir(parents=True, exist_ok=True)
    output_path.write_text(json.dumps(manifest, ensure_ascii=False, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    print(f"wrote manifest: {output_path}")
    print(f"asset count: {len(manifest['assets'])}")
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except subprocess.CalledProcessError as exc:
        command = exc.cmd if isinstance(exc.cmd, str) else " ".join(exc.cmd)
        stderr = (exc.stderr or "").strip()
        if stderr:
            print(stderr, file=sys.stderr)
        print(f"error: command failed: {command}", file=sys.stderr)
        raise
