#!/usr/bin/env python3
"""Two-phase, node-local publication transaction for GoNavi CDN edges."""

from __future__ import annotations

import argparse
import contextlib
import datetime as dt
import hashlib
import json
import os
import re
import shutil
import sys
import time
from pathlib import Path, PurePosixPath
from typing import Any, Iterator


MARKER = "gonavi-download-mirror-v1"
NON_ROOT_TEST_ENV = "GONAVI_EDGE_TRANSACTION_ALLOW_NON_ROOT_TEST"
TAG_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$")
SHA256_RE = re.compile(r"^[0-9a-f]{64}$")
COMMANDS = (
    "verify",
    "promote-immutable",
    "promote-mutable",
    "rollback-mutable",
    "finalize",
    "abort",
)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("command", choices=COMMANDS)
    parser.add_argument("--root", type=Path, required=True)
    parser.add_argument("--staging-dir", type=Path, required=True)
    parser.add_argument("--channel", choices=("stable", "dev"), required=True)
    parser.add_argument("--app-tag", required=True)
    parser.add_argument("--driver-tag", default="")
    parser.add_argument("--generation", required=True)
    parser.add_argument("--node-id", required=True)
    parser.add_argument("--performance-status", choices=("unknown", "ok", "limited"), default="unknown")
    parser.add_argument("--performance-mbps", type=float, default=0.0)
    return parser.parse_args()


def fail(message: str) -> None:
    raise ValueError(message)


def validate_token(value: str, label: str) -> str:
    if not TAG_RE.fullmatch(value) or value in {".", ".."}:
        fail(f"invalid {label}: {value!r}")
    return value


def utc_now() -> str:
    return dt.datetime.now(dt.timezone.utc).isoformat().replace("+00:00", "Z")


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def atomic_write_json(path: Path, value: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(f".{path.name}.tmp-{os.getpid()}")
    temporary.write_text(
        json.dumps(value, ensure_ascii=True, sort_keys=True) + "\n",
        encoding="ascii",
    )
    os.chmod(temporary, 0o644)
    os.replace(temporary, path)


def resolve_below(root: Path, candidate: Path, label: str) -> Path:
    resolved = candidate.resolve()
    try:
        resolved.relative_to(root)
    except ValueError:
        fail(f"{label} must stay below mirror root: {resolved}")
    if resolved == root:
        fail(f"{label} must not equal mirror root")
    return resolved


@contextlib.contextmanager
def deployment_lock(root: Path) -> Iterator[None]:
    lock_dir = root / ".deploy.lock.d"
    deadline = time.monotonic() + 120
    while True:
        try:
            lock_dir.mkdir()
            break
        except FileExistsError:
            if time.monotonic() >= deadline:
                fail("timed out waiting for edge deployment lock")
            time.sleep(0.25)
    try:
        yield
    finally:
        with contextlib.suppress(OSError):
            lock_dir.rmdir()


class Transaction:
    def __init__(self, args: argparse.Namespace) -> None:
        root = args.root.resolve()
        if not root.is_absolute() or root == Path(root.anchor):
            fail("mirror root must be an absolute non-root path")
        if not root.is_dir() or (root / ".gonavi-mirror-root").read_text(
            encoding="utf-8", errors="replace"
        ).strip() != MARKER:
            fail("mirror root marker is missing or invalid")

        validate_token(args.app_tag, "app tag")
        validate_token(args.generation, "generation")
        validate_token(args.node_id, "node id")
        if args.driver_tag:
            validate_token(args.driver_tag, "driver tag")
        if not 0 <= args.performance_mbps < 1_000_000:
            fail("performance Mbps is invalid")

        staging = resolve_below(root, args.staging_dir, "staging directory")
        incoming = (root / ".incoming").resolve()
        try:
            staging.relative_to(incoming)
        except ValueError:
            fail(f"staging directory must be below {incoming}")
        if args.command != "abort" and not staging.is_dir():
            fail(f"staging directory does not exist: {staging}")

        self.args = args
        self.root = root
        self.staging = staging
        self.payload = staging / "payload"
        self.deployment_path = staging / "deployment.json"
        self.checksums_path = staging / "SHA256SUMS"
        self.ready_path = root / ".state" / "ready" / f"{args.channel}-{args.generation}.json"
        self.channel_state_path = root / ".state" / "channels" / f"{args.channel}.json"
        self.transaction_dir = root / ".transactions" / args.generation

        if args.channel == "stable":
            self.app_download_parent = root / "gonavi" / "releases" / "download"
            self.app_latest_relative = Path("gonavi/releases/latest/latest.json")
            self.driver_download_parent = root / "drivers" / "releases" / "download"
            self.driver_latest_relative = Path(
                "drivers/releases/latest/GoNavi-DriverAgents-Index.json"
            )
        else:
            self.app_download_parent = root / "gonavi" / "dev" / "releases" / "download"
            self.app_latest_relative = Path("gonavi/dev/releases/latest/latest-dev.json")
            self.driver_download_parent = root / "drivers" / "dev" / "releases" / "download"
            self.driver_latest_relative = Path(
                "drivers/dev/releases/latest/GoNavi-DriverAgents-Index.json"
            )

    def load_deployment(self) -> dict[str, Any]:
        try:
            metadata = json.loads(self.deployment_path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError) as exc:
            fail(f"unable to read deployment metadata: {exc}")
        expected = {
            "channel": self.args.channel,
            "appTag": self.args.app_tag,
            "driverEnabled": bool(self.args.driver_tag),
            "driverTag": self.args.driver_tag,
            "generation": self.args.generation,
        }
        for key, value in expected.items():
            if metadata.get(key) != value:
                fail(
                    f"deployment metadata mismatch for {key}: "
                    f"expected={value!r} actual={metadata.get(key)!r}"
                )
        probe_path = metadata.get("probePath")
        probe_size = metadata.get("probeSize")
        probe_sha = metadata.get("probeSha256")
        if (
            not isinstance(probe_path, str)
            or not probe_path
            or probe_path.startswith("/")
            or ".." in PurePosixPath(probe_path).parts
            or not isinstance(probe_size, int)
            or probe_size <= 0
            or not isinstance(probe_sha, str)
            or not SHA256_RE.fullmatch(probe_sha)
        ):
            fail("deployment probe metadata is invalid")
        return metadata

    def inherited_driver_tag(self) -> str:
        try:
            state = json.loads(self.channel_state_path.read_text(encoding="utf-8"))
        except FileNotFoundError:
            state = {}
        except (OSError, json.JSONDecodeError) as exc:
            fail(f"unable to read previous channel state: {exc}")
        if not isinstance(state, dict) or (state and state.get("channel") != self.args.channel):
            fail(f"invalid previous channel state: {self.channel_state_path}")

        latest_path = self.root / self.driver_latest_relative
        try:
            latest = json.loads(latest_path.read_text(encoding="utf-8"))
        except FileNotFoundError:
            latest = {}
        except (OSError, json.JSONDecodeError) as exc:
            fail(f"unable to read current driver index: {exc}")
        if not isinstance(latest, dict):
            fail(f"invalid current driver index: {latest_path}")

        state_tag = state.get("driverTag")
        if not isinstance(state_tag, str):
            state_tag = ""
        latest_tag = latest.get("mirrorTagName") or latest.get("tagName")
        if not isinstance(latest_tag, str):
            latest_tag = ""
        if not latest_tag:
            if state_tag:
                fail(
                    "previous channel state references a driver tag but the current "
                    f"driver index is missing: state={state_tag!r}"
                )
            return ""
        if state_tag and state_tag != latest_tag:
            fail(
                "previous channel state and current driver index disagree: "
                f"state={state_tag!r} latest={latest_tag!r}"
            )
        validate_token(latest_tag, "inherited driver tag")
        if not (self.driver_download_parent / latest_tag).is_dir():
            fail(f"inherited driver release is missing: {latest_tag}")
        return latest_tag

    def checksum_entries(self) -> list[tuple[str, Path]]:
        if not self.payload.is_dir() or not self.checksums_path.is_file():
            fail("staged payload or SHA256SUMS is missing")
        if any(path.is_symlink() for path in self.staging.rglob("*")):
            fail("symbolic links are not allowed in a mirror deployment")
        entries: list[tuple[str, Path]] = []
        seen: set[PurePosixPath] = set()
        for line in self.checksums_path.read_text(encoding="ascii").splitlines():
            digest, separator, raw_path = line.partition("  ")
            relative = PurePosixPath(raw_path)
            if (
                not separator
                or not SHA256_RE.fullmatch(digest)
                or relative.is_absolute()
                or ".." in relative.parts
                or "." in relative.parts
            ):
                fail(f"unsafe SHA256SUMS entry: {line!r}")
            if relative in seen:
                fail(f"duplicate SHA256SUMS entry: {relative}")
            seen.add(relative)
            entries.append((digest, self.payload.joinpath(*relative.parts)))
        if not entries:
            fail("SHA256SUMS has no entries")
        actual_files = {
            path.resolve()
            for path in self.payload.rglob("*")
            if path.is_file()
        }
        expected_files = {path.resolve() for _, path in entries}
        if actual_files != expected_files:
            fail("staged payload files do not exactly match SHA256SUMS")
        return entries

    def seal_payload(self) -> None:
        if os.name == "nt":
            return
        if os.geteuid() != 0:
            if os.environ.get(NON_ROOT_TEST_ENV) == "1":
                return
            fail("immutable promotion must run as root")
        paths = [self.payload, *self.payload.rglob("*")]
        for path in paths:
            if path.is_symlink() or not (path.is_dir() or path.is_file()):
                fail(f"unsupported staged payload entry: {path}")
            os.chown(path, 0, -1)
            os.chmod(path, 0o755 if path.is_dir() else 0o644)

    def verify(self) -> dict[str, Any]:
        metadata = self.load_deployment()
        entries = self.checksum_entries()
        if metadata.get("fileCount") != len(entries):
            fail("deployment file count does not match SHA256SUMS")
        payload_bytes = 0
        for digest, path in entries:
            if not path.is_file():
                fail(f"staged payload file is missing: {path}")
            payload_bytes += path.stat().st_size
            if sha256_file(path) != digest:
                fail(f"staged payload sha256 mismatch: {path}")
        if metadata.get("payloadBytes") != payload_bytes:
            fail("deployment payload byte count does not match staged files")
        return metadata

    @staticmethod
    def directories_equal(left: Path, right: Path) -> bool:
        left_files = {
            path.relative_to(left).as_posix(): (path.stat().st_size, sha256_file(path))
            for path in left.rglob("*")
            if path.is_file()
        }
        right_files = {
            path.relative_to(right).as_posix(): (path.stat().st_size, sha256_file(path))
            for path in right.rglob("*")
            if path.is_file()
        }
        return left_files == right_files

    def promote_directory(self, source: Path, destination: Path) -> None:
        if not source.is_dir():
            fail(f"immutable source directory is missing: {source}")
        destination.parent.mkdir(parents=True, exist_ok=True)
        if destination.exists():
            if not destination.is_dir() or not self.directories_equal(source, destination):
                fail(f"refusing to overwrite immutable mirror directory: {destination}")
            shutil.rmtree(source)
            return
        os.replace(source, destination)

    def promote_immutable(self) -> None:
        # Remove uploader write access before the authoritative verification so
        # the checked bytes cannot change between hashing and atomic promotion.
        self.seal_payload()
        metadata = self.verify()
        active_driver_tag = self.args.driver_tag or self.inherited_driver_tag()
        self.promote_directory(
            self.payload
            / self.app_download_parent.relative_to(self.root)
            / self.args.app_tag,
            self.app_download_parent / self.args.app_tag,
        )
        if self.args.driver_tag:
            self.promote_directory(
                self.payload
                / self.driver_download_parent.relative_to(self.root)
                / self.args.driver_tag,
                self.driver_download_parent / self.args.driver_tag,
            )
        probe = self.root.joinpath(*PurePosixPath(metadata["probePath"]).parts)
        if (
            not probe.is_file()
            or probe.stat().st_size != metadata["probeSize"]
            or sha256_file(probe) != metadata["probeSha256"]
        ):
            fail("promoted immutable probe asset verification failed")
        ready = {
            **metadata,
            "driverTag": active_driver_tag,
            "nodeId": self.args.node_id,
            "status": "ready",
            "verifiedAt": utc_now(),
            "payloadChecksumsSha256": sha256_file(self.checksums_path),
        }
        atomic_write_json(self.ready_path, ready)

    def mutable_pairs(self) -> list[tuple[Path, Path]]:
        result = [
            (
                self.payload / self.app_latest_relative,
                self.root / self.app_latest_relative,
            )
        ]
        if self.args.driver_tag:
            result.append(
                (
                    self.payload / self.driver_latest_relative,
                    self.root / self.driver_latest_relative,
                )
            )
        return result

    def backup_path(self, destination: Path) -> Path:
        return self.transaction_dir / "backup" / destination.relative_to(self.root)

    def restore_mutable(self) -> None:
        for _, destination in self.mutable_pairs():
            backup = self.backup_path(destination)
            missing = backup.with_name(backup.name + ".missing")
            if backup.is_file():
                destination.parent.mkdir(parents=True, exist_ok=True)
                temporary = destination.with_name(f".{destination.name}.rollback-{os.getpid()}")
                shutil.copy2(backup, temporary)
                os.replace(temporary, destination)
            elif missing.is_file():
                with contextlib.suppress(FileNotFoundError):
                    destination.unlink()
        with contextlib.suppress(FileNotFoundError):
            (self.transaction_dir / "mutable-promoted").unlink()

    def promote_mutable(self) -> None:
        if not self.ready_path.is_file():
            fail("node-local ready manifest is missing")
        shutil.rmtree(self.transaction_dir, ignore_errors=True)
        for source, destination in self.mutable_pairs():
            if not source.is_file():
                fail(f"mutable source file is missing: {source}")
            backup = self.backup_path(destination)
            backup.parent.mkdir(parents=True, exist_ok=True)
            if destination.is_file():
                shutil.copy2(destination, backup)
            else:
                backup.with_name(backup.name + ".missing").touch()
        try:
            for source, destination in self.mutable_pairs():
                destination.parent.mkdir(parents=True, exist_ok=True)
                temporary = destination.with_name(f".{destination.name}.tmp-{os.getpid()}")
                shutil.copyfile(source, temporary)
                os.chmod(temporary, 0o644)
                os.replace(temporary, destination)
        except OSError:
            self.restore_mutable()
            raise
        (self.transaction_dir / "mutable-promoted").touch()

    def finalize(self) -> None:
        if not (self.transaction_dir / "mutable-promoted").is_file():
            fail("mutable promotion marker is missing")
        ready = json.loads(self.ready_path.read_text(encoding="utf-8"))
        state = {**ready, "status": "active", "promotedAt": utc_now()}
        atomic_write_json(self.channel_state_path, state)

        channels: dict[str, Any] = {}
        for path in sorted(self.channel_state_path.parent.glob("*.json")):
            try:
                value = json.loads(path.read_text(encoding="utf-8"))
            except (OSError, json.JSONDecodeError):
                continue
            name = value.get("channel")
            if isinstance(name, str) and name:
                channels[name] = value
        health = {
            "schemaVersion": 1,
            "status": "ok",
            "ready": True,
            "nodeId": self.args.node_id,
            "generation": self.args.generation,
            "channels": channels,
            "updatedAt": state["promotedAt"],
            "performance": {
                "status": self.args.performance_status,
                "observedMbps": round(self.args.performance_mbps, 2),
                "observedAt": state["promotedAt"],
            },
        }
        atomic_write_json(self.root / "healthz", health)
        shutil.rmtree(self.transaction_dir, ignore_errors=True)
        shutil.rmtree(self.staging, ignore_errors=True)

    def abort(self) -> None:
        shutil.rmtree(self.staging, ignore_errors=True)
        shutil.rmtree(self.transaction_dir, ignore_errors=True)


def main() -> int:
    try:
        args = parse_args()
        transaction = Transaction(args)
        with deployment_lock(transaction.root):
            if args.command == "verify":
                transaction.verify()
            elif args.command == "promote-immutable":
                transaction.promote_immutable()
            elif args.command == "promote-mutable":
                transaction.promote_mutable()
            elif args.command == "rollback-mutable":
                transaction.restore_mutable()
            elif args.command == "finalize":
                transaction.finalize()
            else:
                transaction.abort()
        print(
            json.dumps(
                {
                    "command": args.command,
                    "nodeId": args.node_id,
                    "generation": args.generation,
                    "channel": args.channel,
                    "ok": True,
                },
                sort_keys=True,
            )
        )
        return 0
    except (OSError, ValueError, json.JSONDecodeError) as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
