#!/usr/bin/env python3

import json
import hashlib
import os
import shlex
import shutil
import stat
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parent.parent
SCRIPT = ROOT / "tools" / "generate-driver-release-manifest.py"


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


def expected_revision(revision_file: Path, driver: str):
    for line in revision_file.read_text(encoding="utf-8").splitlines():
        if f'"{driver}"' not in line:
            continue
        left, right = line.strip().rstrip(",").split(":", 1)
        if left.strip().strip('"') == driver:
            return right.strip().strip('"')
    raise AssertionError(f"missing revision for {driver}")


class GenerateDriverReleaseManifestTest(unittest.TestCase):
    def test_release_jobs_pin_go_toolchain_before_generating_driver_manifest(self):
        setup_go_step = (
            "      - name: Setup Go\n"
            "        uses: actions/setup-go@v6\n"
            "        with:\n"
            "          go-version-file: 'go.mod'"
        )
        manifest_command = "python3 ../tools/generate-driver-release-manifest.py"

        for workflow_name in ("dev-build.yml", "release.yml"):
            workflow = (ROOT / ".github" / "workflows" / workflow_name).read_text(encoding="utf-8")
            release_job = workflow.split("\n  release:\n", 1)[1]
            self.assertIn(setup_go_step, release_job)
            self.assertLess(release_job.index(setup_go_step), release_job.index(manifest_command))

    def _host_platform(self):
        goos = subprocess.run(
            ["go", "env", "GOOS"],
            cwd=ROOT,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            check=True,
        ).stdout.strip()
        goarch = subprocess.run(
            ["go", "env", "GOARCH"],
            cwd=ROOT,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            check=True,
        ).stdout.strip()
        return goos, goarch

    def _build_metadata_agent(self, output: Path, revision: str, driver: str = "clickhouse"):
        source = output.parent / "metadata-agent.go"
        source.write_text(
            "package main\n"
            "import (\"bufio\"; \"fmt\"; \"os\")\n"
            "func main() {\n"
            "  scanner := bufio.NewScanner(os.Stdin)\n"
            "  for scanner.Scan() {\n"
            f"    fmt.Println(`{{\"id\":1,\"success\":true,\"data\":{{\"driverType\":\"{driver}\",\"agentRevision\":\"{revision}\",\"protocolSchema\":\"json-lines-v1\"}}}}`)\n"
            "  }\n"
            "}\n",
            encoding="utf-8",
        )
        output.unlink(missing_ok=True)
        proc = subprocess.run(
            ["go", "build", "-o", str(output), str(source)],
            cwd=ROOT,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
        )
        self.assertEqual(proc.returncode, 0, proc.stderr)

    def _build_transiently_failing_metadata_agent(self, output: Path, revision: str):
        source = output.parent / "transient-metadata-agent.go"
        marker = output.parent / "metadata-agent-first-probe"
        source.write_text(
            "package main\n"
            "import (\"bufio\"; \"fmt\"; \"os\")\n"
            "func main() {\n"
            f"  marker := {json.dumps(str(marker))}\n"
            "  if _, err := os.Stat(marker); os.IsNotExist(err) {\n"
            "    if err := os.WriteFile(marker, []byte(\"attempted\"), 0600); err != nil { panic(err) }\n"
            "    os.Exit(127)\n"
            "  }\n"
            "  scanner := bufio.NewScanner(os.Stdin)\n"
            "  for scanner.Scan() {\n"
            f"    fmt.Println(`{{\"id\":1,\"success\":true,\"data\":{{\"driverType\":\"clickhouse\",\"agentRevision\":\"{revision}\",\"protocolSchema\":\"json-lines-v1\"}}}}`)\n"
            "  }\n"
            "}\n",
            encoding="utf-8",
        )
        subprocess.run(
            ["go", "build", "-o", str(output), str(source)],
            cwd=ROOT,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            check=True,
        )

    def _cross_platform(self):
        host = "/".join(self._host_platform())
        for platform in ("linux/amd64", "darwin/arm64", "windows/amd64"):
            if platform != host:
                return platform
        raise AssertionError(f"unable to select cross platform for {host}")

    def test_rejects_native_asset_with_stale_embedded_revision(self):
        goos, goarch = self._host_platform()
        extension = ".exe" if goos == "windows" else ""
        with tempfile.TemporaryDirectory(prefix="gonavi-release-manifest-stale-agent-") as tmp:
            tmpdir = Path(tmp)
            assets_dir = tmpdir / "drivers"
            assets_dir.mkdir(parents=True)
            asset = assets_dir / f"clickhouse-driver-agent-{goos}-{goarch}{extension}"
            self._build_metadata_agent(asset, "src-stale-agent")

            output = tmpdir / "manifest.json"
            proc = subprocess.run(
                [sys.executable, str(SCRIPT), "--assets-dir", str(assets_dir), "--output", str(output)],
                cwd=ROOT,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                text=True,
            )

            self.assertNotEqual(proc.returncode, 0, proc.stdout)
            self.assertIn("src-stale-agent", proc.stderr)
            self.assertFalse(output.exists())

    def test_retries_native_metadata_probe_after_transient_exit_127(self):
        goos, goarch = self._host_platform()
        platform = f"{goos}/{goarch}"
        extension = ".exe" if goos == "windows" else ""
        revision = "src-transient-probe"
        with tempfile.TemporaryDirectory(prefix="gonavi-release-manifest-transient-agent-") as tmp:
            tmpdir = Path(tmp)
            assets_dir = tmpdir / "drivers"
            assets_dir.mkdir(parents=True)
            asset = assets_dir / f"clickhouse-driver-agent-{goos}-{goarch}{extension}"
            self._build_transiently_failing_metadata_agent(asset, revision)
            revision_file = tmpdir / "driver_agent_revisions_gen.go"
            revision_file.write_text(
                "package db\n"
                "var revisions = map[string]string{\n"
                f'    "clickhouse": "{revision}",\n'
                "}\n",
                encoding="utf-8",
            )
            provenance = tmpdir / "build-provenance.json"

            proc = subprocess.run(
                [
                    sys.executable,
                    str(SCRIPT),
                    "--assets-dir",
                    str(assets_dir),
                    "--provenance-output",
                    str(provenance),
                    "--revision-file",
                    str(revision_file),
                ],
                cwd=ROOT,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                text=True,
            )

            self.assertEqual(proc.returncode, 0, proc.stderr)
            payload = json.loads(provenance.read_text(encoding="utf-8"))
            self.assertEqual(payload["assets"][asset.name]["revision"], revision)

    def test_rejects_native_asset_when_sha_bound_provenance_disagrees_with_binary(self):
        goos, goarch = self._host_platform()
        platform = f"{goos}/{goarch}"
        extension = ".exe" if goos == "windows" else ""
        with tempfile.TemporaryDirectory(prefix="gonavi-release-manifest-native-provenance-") as tmp:
            tmpdir = Path(tmp)
            assets_dir = tmpdir / "drivers"
            assets_dir.mkdir(parents=True)
            asset = assets_dir / f"clickhouse-driver-agent-{goos}-{goarch}{extension}"
            self._build_metadata_agent(asset, "src-binary-revision")
            content = asset.read_bytes()
            provenance = tmpdir / "provenance.json"
            provenance.write_text(
                json.dumps(
                    {
                        "schemaVersion": 1,
                        "assets": {
                            asset.name: {
                                "driver": "clickhouse",
                                "driverType": "clickhouse",
                                "platform": platform,
                                "revision": "src-provenance-revision",
                                "sha256": hashlib.sha256(content).hexdigest(),
                                "size": len(content),
                            }
                        },
                    }
                ),
                encoding="utf-8",
            )

            output = tmpdir / "manifest.json"
            proc = subprocess.run(
                [
                    sys.executable,
                    str(SCRIPT),
                    "--assets-dir",
                    str(assets_dir),
                    "--output",
                    str(output),
                    "--provenance",
                    str(provenance),
                ],
                cwd=ROOT,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                text=True,
            )

            self.assertNotEqual(proc.returncode, 0, proc.stdout)
            self.assertIn("provenance revision mismatch", proc.stderr)
            self.assertIn("src-binary-revision", proc.stderr)
            self.assertIn("src-provenance-revision", proc.stderr)
            self.assertFalse(output.exists())

    def test_rejects_cross_platform_asset_without_binary_revision_provenance(self):
        goos, goarch = self._cross_platform().split("/", 1)
        extension = ".exe" if goos == "windows" else ""
        with tempfile.TemporaryDirectory(prefix="gonavi-release-manifest-cross-agent-") as tmp:
            tmpdir = Path(tmp)
            assets_dir = tmpdir / "drivers"
            assets_dir.mkdir(parents=True)
            asset = assets_dir / f"clickhouse-driver-agent-{goos}-{goarch}{extension}"
            asset.write_bytes(b"cross-platform-driver-agent")

            output = tmpdir / "manifest.json"
            proc = subprocess.run(
                [sys.executable, str(SCRIPT), "--assets-dir", str(assets_dir), "--output", str(output)],
                cwd=ROOT,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                text=True,
            )

            self.assertNotEqual(proc.returncode, 0, proc.stdout)
            self.assertIn("binary revision provenance", proc.stderr)
            self.assertFalse(output.exists())

    def test_accepts_cross_platform_asset_with_matching_sha_bound_provenance(self):
        platform = self._cross_platform()
        goos, goarch = platform.split("/", 1)
        extension = ".exe" if goos == "windows" else ""
        revision = "src-build-provenance"

        with tempfile.TemporaryDirectory(prefix="gonavi-release-manifest-provenance-") as tmp:
            tmpdir = Path(tmp)
            assets_dir = tmpdir / "drivers"
            assets_dir.mkdir(parents=True)
            asset = assets_dir / f"clickhouse-driver-agent-{goos}-{goarch}{extension}"
            content = b"cross-platform-driver-agent-with-provenance"
            asset.write_bytes(content)
            provenance = tmpdir / "provenance.json"
            provenance.write_text(
                json.dumps(
                    {
                        "schemaVersion": 1,
                        "assets": {
                            asset.name: {
                                "driver": "clickhouse",
                                "driverType": "clickhouse",
                                "platform": platform,
                                "revision": revision,
                                "sha256": hashlib.sha256(content).hexdigest(),
                                "size": len(content),
                            }
                        },
                    }
                ),
                encoding="utf-8",
            )

            output = tmpdir / "manifest.json"
            proc = subprocess.run(
                [
                    sys.executable,
                    str(SCRIPT),
                    "--assets-dir",
                    str(assets_dir),
                    "--output",
                    str(output),
                    "--provenance",
                    str(provenance),
                ],
                cwd=ROOT,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                text=True,
            )

            self.assertEqual(proc.returncode, 0, proc.stderr)
            manifest = json.loads(output.read_text(encoding="utf-8"))
            self.assertEqual(manifest["assets"][asset.name]["revision"], revision)

    def test_accepts_sha_matching_provenance_from_the_build_runner(self):
        platform = self._cross_platform()
        goos, goarch = platform.split("/", 1)
        extension = ".exe" if goos == "windows" else ""
        with tempfile.TemporaryDirectory(prefix="gonavi-release-manifest-stale-provenance-") as tmp:
            tmpdir = Path(tmp)
            assets_dir = tmpdir / "drivers"
            assets_dir.mkdir(parents=True)
            asset = assets_dir / f"clickhouse-driver-agent-{goos}-{goarch}{extension}"
            content = b"stale-cross-platform-driver-agent"
            asset.write_bytes(content)
            provenance = tmpdir / "previous-manifest.json"
            provenance.write_text(
                json.dumps(
                    {
                        "schemaVersion": 1,
                        "assets": {
                            asset.name: {
                                "driver": "clickhouse",
                                "driverType": "clickhouse",
                                "platform": platform,
                                "revision": "src-build-runner",
                                "sha256": hashlib.sha256(content).hexdigest(),
                                "size": len(content),
                            }
                        },
                    }
                ),
                encoding="utf-8",
            )

            output = tmpdir / "manifest.json"
            proc = subprocess.run(
                [
                    sys.executable,
                    str(SCRIPT),
                    "--assets-dir",
                    str(assets_dir),
                    "--output",
                    str(output),
                    "--provenance",
                    str(provenance),
                ],
                cwd=ROOT,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                text=True,
            )

            self.assertEqual(proc.returncode, 0, proc.stderr)
            manifest = json.loads(output.read_text(encoding="utf-8"))
            self.assertEqual(manifest["assets"][asset.name]["revision"], "src-build-runner")

    def test_writes_sha_bound_build_provenance_from_revision_file(self):
        platform = self._cross_platform()
        goos, goarch = platform.split("/", 1)
        extension = ".exe" if goos == "windows" else ""
        with tempfile.TemporaryDirectory(prefix="gonavi-release-build-provenance-") as tmp:
            tmpdir = Path(tmp)
            assets_dir = tmpdir / "drivers"
            assets_dir.mkdir(parents=True)
            asset = assets_dir / f"clickhouse-driver-agent-{goos}-{goarch}{extension}"
            content = b"freshly-built-cross-platform-agent"
            asset.write_bytes(content)
            revision_file = tmpdir / "driver_agent_revisions_gen.go"
            revision_file.write_text(
                "package db\n"
                "var revisions = map[string]string{\n"
                '    "clickhouse": "src-build-revision",\n'
                "}\n",
                encoding="utf-8",
            )
            provenance = tmpdir / "build-provenance.json"

            proc = subprocess.run(
                [
                    sys.executable,
                    str(SCRIPT),
                    "--assets-dir",
                    str(assets_dir),
                    "--provenance-output",
                    str(provenance),
                    "--revision-file",
                    str(revision_file),
                ],
                cwd=ROOT,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                text=True,
            )

            self.assertEqual(proc.returncode, 0, proc.stderr)
            payload = json.loads(provenance.read_text(encoding="utf-8"))
            metadata = payload["assets"][asset.name]
            self.assertEqual(metadata["revision"], "src-build-revision")
            self.assertEqual(metadata["sha256"], hashlib.sha256(content).hexdigest())
            self.assertEqual(metadata["platform"], platform)

    def _generate_revision_file(self, platform: str, drivers: str = "clickhouse"):
        bash_executable = resolve_bash_executable()
        worktree = Path(tempfile.mkdtemp(prefix="gonavi-release-manifest-worktree-"))
        subprocess.run(
            ["git", "worktree", "add", "--detach", str(worktree), "HEAD"],
            cwd=ROOT,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            check=True,
        )
        self.addCleanup(
            lambda: subprocess.run(
                ["git", "worktree", "remove", "--force", str(worktree)],
                cwd=ROOT,
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
                check=False,
            )
        )
        run_bash_command(
            bash_executable,
            worktree,
            ["./tools/generate-driver-agent-revisions.sh", "--platform", platform, "--drivers", drivers],
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            check=True,
        )
        return worktree / "internal" / "db" / "driver_agent_revisions_gen.go"

    def test_generates_manifest_from_verified_native_and_provenance_backed_cross_platform_assets(self):
        with tempfile.TemporaryDirectory(prefix="gonavi-release-manifest-test-") as tmp:
            tmpdir = Path(tmp)
            assets_dir = tmpdir / "drivers"
            (assets_dir / "MacOS").mkdir(parents=True)
            (assets_dir / "Linux").mkdir(parents=True)
            (assets_dir / "Windows").mkdir(parents=True)

            darwin_revision_file = self._generate_revision_file("darwin/arm64")
            linux_revision_file = self._generate_revision_file("linux/amd64")
            linux_arm64_revision_file = self._generate_revision_file("linux/arm64")
            windows_revision_file = self._generate_revision_file("windows/amd64", "clickhouse,mongodb")
            revision_by_platform_driver = {
                ("darwin/arm64", "clickhouse"): expected_revision(darwin_revision_file, "clickhouse"),
                ("linux/amd64", "clickhouse"): expected_revision(linux_revision_file, "clickhouse"),
                ("linux/arm64", "clickhouse"): expected_revision(linux_arm64_revision_file, "clickhouse"),
                ("windows/amd64", "clickhouse"): expected_revision(windows_revision_file, "clickhouse"),
                ("windows/amd64", "mongodb"): expected_revision(windows_revision_file, "mongodb"),
            }
            fixtures = {
                assets_dir / "MacOS" / "clickhouse-driver-agent-darwin-arm64": ("clickhouse", "darwin/arm64", b"darwin-binary"),
                assets_dir / "Linux" / "clickhouse-driver-agent-linux-amd64": ("clickhouse", "linux/amd64", b"linux-binary"),
                assets_dir / "Linux" / "clickhouse-driver-agent-linux-arm64": ("clickhouse", "linux/arm64", b"linux-arm64-binary"),
                assets_dir / "Windows" / "clickhouse-driver-agent-windows-amd64.exe": ("clickhouse", "windows/amd64", b"MZfake-binary"),
                assets_dir / "Windows" / "mongodb-driver-agent-v1-windows-amd64.exe": ("mongodb", "windows/amd64", b"MZfake-mongodb-v1"),
                assets_dir / "Windows" / "mongodb-driver-agent-v2-windows-amd64.exe": ("mongodb", "windows/amd64", b"MZfake-mongodb-v2"),
            }
            host_platform = "/".join(self._host_platform())
            for path, (driver, platform, content) in fixtures.items():
                path.write_bytes(content)
                os.chmod(path, stat.S_IRUSR | stat.S_IWUSR | stat.S_IXUSR)
                if platform == host_platform:
                    self._build_metadata_agent(path, revision_by_platform_driver[(platform, driver)], driver)

            provenance_assets = {}
            for path, (driver, platform, _) in fixtures.items():
                content = path.read_bytes()
                provenance_assets[path.name] = {
                    "driver": driver,
                    "driverType": driver,
                    "platform": platform,
                    "revision": revision_by_platform_driver[(platform, driver)],
                    "sha256": hashlib.sha256(content).hexdigest(),
                    "size": len(content),
                }
            provenance = tmpdir / "provenance.json"
            provenance.write_text(
                json.dumps({"schemaVersion": 1, "assets": provenance_assets}),
                encoding="utf-8",
            )

            output = tmpdir / "manifest.json"
            proc = subprocess.run(
                [
                    sys.executable,
                    str(SCRIPT),
                    "--assets-dir",
                    str(assets_dir),
                    "--output",
                    str(output),
                    "--provenance",
                    str(provenance),
                ],
                cwd=ROOT,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                text=True,
                check=True,
            )

            self.assertIn("asset count: 6", proc.stdout)
            manifest = json.loads(output.read_text(encoding="utf-8"))
            assets = manifest["assets"]
            self.assertEqual(
                assets["clickhouse-driver-agent-darwin-arm64"]["revision"],
                expected_revision(darwin_revision_file, "clickhouse"),
            )
            self.assertEqual(
                assets["clickhouse-driver-agent-linux-amd64"]["revision"],
                expected_revision(linux_revision_file, "clickhouse"),
            )
            self.assertEqual(
                assets["clickhouse-driver-agent-linux-arm64"]["revision"],
                expected_revision(linux_arm64_revision_file, "clickhouse"),
            )
            self.assertEqual(
                assets["clickhouse-driver-agent-windows-amd64.exe"]["revision"],
                expected_revision(windows_revision_file, "clickhouse"),
            )
            self.assertEqual(
                assets["mongodb-driver-agent-v1-windows-amd64.exe"]["driver"],
                "mongodb",
            )
            self.assertEqual(
                assets["mongodb-driver-agent-v1-windows-amd64.exe"]["platform"],
                "windows/amd64",
            )
            self.assertEqual(
                assets["mongodb-driver-agent-v1-windows-amd64.exe"]["revision"],
                expected_revision(windows_revision_file, "mongodb"),
            )
            self.assertEqual(
                assets["mongodb-driver-agent-v2-windows-amd64.exe"]["driver"],
                "mongodb",
            )


if __name__ == "__main__":
    unittest.main()
