#!/usr/bin/env python3
"""Static contract checks for CLI release assets and distribution gates."""

import json
import os
from pathlib import Path
import re
import subprocess
import tempfile
import textwrap
import unittest


ROOT = Path(__file__).resolve().parents[1]
GITHUB_EXPRESSION = re.compile(r"\$\{\{.*?\}\}")


def extract_workflow_run_script(source: str, step_name: str) -> str:
    """Return one literal run block without requiring a YAML dependency."""
    lines = source.splitlines()
    marker = f"- name: {step_name}"
    matching_lines = [index for index, line in enumerate(lines) if line.strip() == marker]
    if len(matching_lines) != 1:
        raise AssertionError(
            f"expected exactly one workflow step named {step_name!r}, found {len(matching_lines)}"
        )

    step_index = matching_lines[0]
    step_indent = len(lines[step_index]) - len(lines[step_index].lstrip())
    run_index = None
    for index in range(step_index + 1, len(lines)):
        line = lines[index]
        stripped = line.lstrip()
        indent = len(line) - len(stripped)
        if stripped and indent <= step_indent:
            break
        if stripped == "run: |":
            run_index = index
            break
    if run_index is None:
        raise AssertionError(f"workflow step {step_name!r} has no literal run block")

    run_indent = len(lines[run_index]) - len(lines[run_index].lstrip())
    body: list[str] = []
    for line in lines[run_index + 1 :]:
        stripped = line.lstrip()
        indent = len(line) - len(stripped)
        if stripped and indent <= run_indent:
            break
        body.append(line)
    script = textwrap.dedent("\n".join(body)) + "\n"
    return GITHUB_EXPRESSION.sub("GITHUB_EXPRESSION", script)


class CLIReleaseAssetsTest(unittest.TestCase):
    def test_stable_and_dev_workflows_publish_the_same_six_archive_names(self) -> None:
        expected_tokens = (
            "gonavi-cli_${version}_${{ matrix.goos }}_${{ matrix.goarch }}.${{ matrix.extension }}",
            'extension: tar.gz',
            'extension: zip',
        )
        for name in ("release.yml", "dev-build.yml"):
            source = (ROOT / ".github" / "workflows" / name).read_text(encoding="utf-8")
            for token in expected_tokens:
                self.assertIn(token, source, f"{token!r} missing from {name}")
            self.assertIn("github.com/rhysd/actionlint/cmd/actionlint@v1.7.12", source)
            self.assertIn(".github/workflows/publish-release.yml", source)
            self.assertIn("python3 tools/cli-release-assets.test.py", source)
            self.assertIn("python3 tools/validate-npm-cli-package-version.test.py", source)
            self.assertIn("CLI artifact set is invalid", source)
            self.assertIn("CLI release asset set is invalid", source)
            self.assertIn("CLI checksum file contents are invalid", source)
            self.assertIn("find cli-assets -type f -printf '%P\\n' | sort", source)
            self.assertIn("find cli-assets -maxdepth 1 -type f -name 'gonavi-cli_*'", source)
            self.assertIn('actual_entries="$(unzip -Z1 "$asset" | sort)"', source)
            self.assertIn('actual_entries="$(tar -tzf "$asset" | sed', source)
            self.assertIn('gonavi-cli_${version}_checksums.txt', source)
            self.assertIn('(cd cli-assets && sha256sum "${expected[@]}"', source)
            self.assertIn('sha256sum --check "$cli_checksum_name"', source)
            self.assertIn("Download canonical driver revision map", source)
            self.assertIn("Install canonical driver revision map", source)
            self.assertIn("canonical-driver-revision-map/driver_agent_revisions_gen.go", source)
            self.assertIn("--component gui", source)
            self.assertIn("--assets-dir release-assets", source)
            self.assertIn("release-assets/*", source)
            self.assertIn("cli-assets/*", source)
            self.assertNotIn(
                'install -m 0644 "cli-assets/${asset}" "release-assets/${asset}"',
                source,
            )
            self.assertNotIn("xattr -cr", source)
            if name == "dev-build.yml":
                self.assertIn('SHORT_SHA="${GITHUB_SHA:0:7}"', source)
                self.assertNotIn("git rev-parse --short HEAD", source)

    def test_release_workflow_bash_blocks_are_syntax_checked(self) -> None:
        workflow_steps = {
            "release.yml": (
                "Build and package CLI",
                "Package macOS DMG",
                "Verify GUI and CLI driver revision contracts",
                "Validate CLI artifact staging",
                "Generate CLI checksums",
                "Generate SHA256SUMS",
                "Verify CLI release assets",
                "Generate static update manifest (latest.json)",
                "Annotate macOS signing status",
                "Record release provenance",
            ),
            "dev-build.yml": (
                "Build and package dev CLI",
                "Package macOS DMG",
                "Verify GUI and CLI driver revision contracts",
                "Validate dev CLI artifact staging",
                "Generate dev CLI checksums",
                "Generate SHA256SUMS",
                "Verify dev CLI release assets",
                "Generate static update manifest (latest-dev.json)",
            ),
            "publish-release.yml": (
                "Prepare and verify stable mirror payload",
                "Verify public CLI release assets for npm postinstall",
                "Publish npm CLI package",
                "Verify npm CLI package metadata",
                "Generate and retain WinGet CLI manifest",
            ),
        }
        for workflow_name, step_names in workflow_steps.items():
            source = (ROOT / ".github" / "workflows" / workflow_name).read_text(encoding="utf-8")
            for step_name in step_names:
                script = extract_workflow_run_script(source, step_name)
                result = subprocess.run(
                    ["bash", "-n"],
                    input=script,
                    text=True,
                    capture_output=True,
                    check=False,
                )
                self.assertEqual(
                    result.returncode,
                    0,
                    f"invalid bash in {workflow_name} step {step_name!r}:\n{result.stderr}",
                )

    def test_gui_and_cli_driver_revisions_are_compared_before_release_staging(self) -> None:
        cases = (
            (
                "release.yml",
                "Build and package CLI",
                "Validate CLI artifact staging",
                "cli-driver-revision-contract-*",
                "gui-driver-revision-contract-*",
            ),
            (
                "dev-build.yml",
                "Build and package dev CLI",
                "Validate dev CLI artifact staging",
                "dev-cli-driver-revision-contract-*",
                "dev-gui-driver-revision-contract-*",
            ),
        )
        for workflow_name, cli_step, staging_step, cli_pattern, gui_pattern in cases:
            source = (ROOT / ".github" / "workflows" / workflow_name).read_text(encoding="utf-8")
            cli_script = extract_workflow_run_script(source, cli_step)
            gui_script = extract_workflow_run_script(source, "Build")
            verification_script = extract_workflow_run_script(
                source, "Verify GUI and CLI driver revision contracts"
            )

            self.assertIn("tools/write-driver-revision-contract.sh --role cli", cli_script)
            self.assertIn('--platform "GITHUB_EXPRESSION/GITHUB_EXPRESSION"', cli_script)
            self.assertIn("--output-dir driver-revision-contract", cli_script)
            self.assertIn("tools/write-driver-revision-contract.sh", gui_script)
            self.assertIn("--role gui", gui_script)
            self.assertIn('--platform "GITHUB_EXPRESSION"', gui_script)
            self.assertIn("--output-dir driver-revision-contract", gui_script)
            self.assertIn(
                "tools/verify-driver-revision-contract.sh --contracts-dir driver-revision-contract",
                verification_script,
            )
            self.assertIn("driver_revision_maps", source)
            self.assertIn("Download canonical driver revision map", source)
            self.assertIn("Install canonical driver revision map", source)
            self.assertNotIn("generate-driver-agent-revisions.sh --platform", cli_script)
            self.assertNotIn("generate-driver-agent-revisions.sh --platform", gui_script)
            self.assertIn(cli_pattern, source)
            self.assertIn(gui_pattern, source)
            self.assertIn('--platform "${{ matrix.goos }}/${{ matrix.goarch }}"', source)
            self.assertIn('--platform "${{ matrix.platform }}"', source)
            self.assertIn("path: driver-revision-contract", source)
            self.assertIn('driver_revision_variant: "webkit41"', source)
            self.assertIn('revision_contract_args+=(--variant "${{ matrix.driver_revision_variant }}")', source)
            self.assertIn("name: " + gui_pattern[:-1] + "${{ matrix.build_name }}", source)
            self.assertNotIn("if: ${{ matrix.wails_tags == '' }}", source)
            self.assertLess(
                source.index("Verify GUI and CLI driver revision contracts"),
                source.index(staging_step),
            )

            cli_job_marker = "name: Build CLI" if workflow_name == "release.yml" else "name: Build dev CLI"
            cli_needs_index = source.index(cli_job_marker)
            self.assertIn("driver_revision_maps", source[cli_needs_index : source.index("    steps:", cli_needs_index)])
            build_index = source.index("name: Build ${{ matrix.platform }}")
            build_header = source[build_index : source.index("    steps:", build_index)]
            self.assertIn("driver_revision_maps", build_header)
            for artifact_key in (
                "darwin-amd64",
                "darwin-arm64",
                "linux-amd64",
                "linux-arm64",
                "windows-amd64",
                "windows-arm64",
            ):
                self.assertIn(f"canonical_revision_map: {artifact_key}", source)
            self.assertIn("canonical_revision_map: linux-amd64\n            wails_tags: \"webkit2_41\"", source)

        for workflow_name in ("release.yml", "dev-build.yml"):
            source = (ROOT / ".github" / "workflows" / workflow_name).read_text(encoding="utf-8")
            self.assertIn("bash tools/verify-driver-revision-contract.test.sh", source)

    def test_stable_release_title_matches_immutable_tag(self) -> None:
        source = (ROOT / ".github" / "workflows" / "release.yml").read_text(encoding="utf-8")
        self.assertIn(
            "name: ${{ needs.validate_release_tag.outputs.tag }}",
            source,
        )
        self.assertNotIn(
            "name: GoNavi ${{ needs.validate_release_tag.outputs.tag }}",
            source,
        )

    def test_gui_manifest_input_never_contains_cli_assets(self) -> None:
        workflow_steps = {
            "release.yml": (
                "Validate CLI artifact staging",
                "Generate static update manifest (latest.json)",
            ),
            "dev-build.yml": (
                "Validate dev CLI artifact staging",
                "Generate static update manifest (latest-dev.json)",
            ),
        }
        for workflow_name, (staging_step, manifest_step) in workflow_steps.items():
            source = (ROOT / ".github" / "workflows" / workflow_name).read_text(encoding="utf-8")
            staging_script = extract_workflow_run_script(source, staging_step)
            manifest_script = extract_workflow_run_script(source, manifest_step)

            self.assertIn("cli-assets", staging_script)
            self.assertNotIn("release-assets", staging_script)
            self.assertIn("--assets-dir release-assets", manifest_script)
            self.assertNotIn("cli-assets", manifest_script)

    def test_checksum_generation_keeps_cli_staging_separate(self) -> None:
        cases = (
            (
                "release.yml",
                "Generate CLI checksums",
                "1.2.3",
                {"RELEASE_TAG": "v1.2.3"},
            ),
            (
                "dev-build.yml",
                "Generate dev CLI checksums",
                "dev-a1b2c3d",
                {"GITHUB_SHA": "a1b2c3d4567890"},
            ),
        )
        for workflow_name, checksum_step, version, extra_env in cases:
            source = (ROOT / ".github" / "workflows" / workflow_name).read_text(encoding="utf-8")
            checksum_script = extract_workflow_run_script(source, checksum_step)
            global_script = extract_workflow_run_script(source, "Generate SHA256SUMS")
            archives = (
                f"gonavi-cli_{version}_darwin_amd64.tar.gz",
                f"gonavi-cli_{version}_darwin_arm64.tar.gz",
                f"gonavi-cli_{version}_linux_amd64.tar.gz",
                f"gonavi-cli_{version}_linux_arm64.tar.gz",
                f"gonavi-cli_{version}_windows_amd64.zip",
                f"gonavi-cli_{version}_windows_arm64.zip",
            )

            with tempfile.TemporaryDirectory() as temporary_directory:
                root = Path(temporary_directory)
                gui_dir = root / "release-assets"
                cli_dir = root / "cli-assets"
                gui_dir.mkdir()
                cli_dir.mkdir()
                (gui_dir / f"GoNavi-{version}-Linux-Amd64.tar.gz").write_bytes(b"gui")
                for archive in archives:
                    (cli_dir / archive).write_bytes(archive.encode("ascii"))

                environment = os.environ.copy()
                environment.update(extra_env)
                for script in (checksum_script, global_script):
                    result = subprocess.run(
                        ["bash"],
                        input=script,
                        cwd=root,
                        env=environment,
                        text=True,
                        capture_output=True,
                        check=False,
                    )
                    self.assertEqual(
                        result.returncode,
                        0,
                        f"failed to execute {workflow_name} checksum script:\n{result.stderr}",
                    )

                cli_checksum_name = f"gonavi-cli_{version}_checksums.txt"
                self.assertTrue((cli_dir / cli_checksum_name).is_file())
                self.assertFalse((gui_dir / cli_checksum_name).exists())
                self.assertFalse(any(path.name.startswith("gonavi-cli_") for path in gui_dir.iterdir()))
                global_names = {
                    line.split(maxsplit=1)[1]
                    for line in (gui_dir / "SHA256SUMS").read_text(encoding="ascii").splitlines()
                }
                self.assertEqual(
                    global_names,
                    {
                        f"GoNavi-{version}-Linux-Amd64.tar.gz",
                        cli_checksum_name,
                        *archives,
                    },
                )

    def test_stable_workflow_requires_notarized_production_signing(self) -> None:
        source = (ROOT / ".github" / "workflows" / "release.yml").read_text(encoding="utf-8")
        for token in (
            "MACOS_SIGNING_CERTIFICATE_P12",
            "MACOS_SIGNING_IDENTITY",
            "Developer ID Application",
            "APPLE_TEAM_ID",
            "verify_team_identifier",
            "TeamIdentifier",
            "codesign --force --deep --options runtime --timestamp",
            "CFBundleShortVersionString",
            "CFBundleVersion",
            'codesign --force --timestamp --sign "$MACOS_SIGNING_IDENTITY" "$DMG_NAME"',
            'codesign --verify --deep --strict --verbose=4 "$APP_NAME"',
            'codesign --verify --verbose=4 "$DMG_NAME"',
            "xcrun notarytool submit",
            "--output-format json",
            'status != "Accepted"',
            "xcrun stapler staple",
            "xcrun stapler validate",
            'spctl -a -t exec -vv "$PACKAGED_APP"',
            "spctl --assess",
            'APP_PATH="./GoNavi.app"',
            'PACKAGED_APP="$VERIFY_MOUNT_DIR/GoNavi.app"',
            'PACKAGED_INFO_PLIST="$PACKAGED_APP/Contents/Info.plist"',
        ):
            self.assertIn(token, source)
        self.assertLess(
            source.index('Set :CFBundleShortVersionString ${VERSION}'),
            source.index('codesign --force --deep --options runtime --timestamp'),
        )
        self.assertLess(
            source.index('codesign --force --timestamp --sign "$MACOS_SIGNING_IDENTITY" "$DMG_NAME"'),
            source.index("xcrun notarytool submit"),
        )
        self.assertLess(
            source.index("xcrun stapler validate"),
            source.rindex('codesign --verify --verbose=4 "$DMG_NAME"'),
        )

    def test_dev_workflow_requires_fixed_dmg_bundle_name(self) -> None:
        source = (ROOT / ".github" / "workflows" / "dev-build.yml").read_text(encoding="utf-8")
        self.assertIn('APP_PATH="./GoNavi.app"', source)
        self.assertIn('PACKAGED_APP="$VERIFY_MOUNT_DIR/GoNavi.app"', source)
        self.assertIn("tools/validate-gui-update-manifest.py", source)
        self.assertIn("--channel dev", source)

    def test_wails_config_has_a_non_default_product_version(self) -> None:
        config = json.loads((ROOT / "wails.json").read_text(encoding="utf-8"))
        product_version = config["info"]["productVersion"]
        self.assertRegex(product_version, r"^\d+\.\d+\.\d+$")
        self.assertNotEqual(product_version, "1.0.0")

    def test_publish_workflow_keeps_cli_separate_from_gui_manifest(self) -> None:
        source = (ROOT / ".github" / "workflows" / "publish-release.yml").read_text(encoding="utf-8")
        self.assertIn("gonavi-cli_${version}_darwin_amd64.tar.gz", source)
        self.assertIn("gonavi-cli_${version}_checksums.txt", source)
        self.assertIn("CLI checksums disagree", source)
        self.assertIn("Release assets are not an exact contract", source)
        self.assertIn("CLI checksum file is missing from the GitHub Release", source)
        self.assertIn("CLI checksum file contents are invalid", source)
        self.assertIn("tools/validate-gui-update-manifest.py", source)
        self.assertIn("--channel stable", source)
        self.assertIn("const requiredAssets = [", source)
        self.assertIn("const optionalAssets = [", source)
        self.assertIn("GoNavi-${version}-Linux-Amd64.AppImage", source)
        self.assertIn("GoNavi-${version}-Linux-Amd64-WebKit41.AppImage", source)
        self.assertIn("const allowedAssetNames = new Set([...requiredAssets, ...optionalAssets])", source)
        self.assertNotIn("release.assets.length !== expectedAssets.length", source)
        self.assertIn("ref: ${{ inputs.tooling_ref || steps.validate.outputs.tag }}", source)
        self.assertIn("tooling_ref:", source)
        self.assertIn("publish_npm:", source)
        self.assertIn("PUBLISH_NPM: ${{ inputs.publish_npm && 'true' || 'false' }}", source)
        self.assertIn("NPM_TOKEN secret is required", source)
        self.assertIn("Validate npm publication credentials", source)
        self.assertIn("npm publish npm/gonavi-cli --access public --ignore-scripts", source)
        self.assertIn('npm view "@syngnat/gonavi-cli@${version}" --json', source)
        for step_name in (
            "Validate npm publication credentials",
            "Verify public CLI release assets for npm postinstall",
            "Setup Node for npm CLI publication",
            "Publish npm CLI package",
            "Verify npm CLI package metadata",
        ):
            self.assertIn(
                f"- name: {step_name}\n        if: ${{{{ env.PUBLISH_NPM == 'true' }}}}",
                source,
            )
        self.assertIn(
            "- name: Skip npm CLI publication\n        if: ${{ env.PUBLISH_NPM != 'true' }}",
            source,
        )
        self.assertIn("Upload WinGet CLI manifest artifact", source)
        self.assertIn("actions/upload-artifact@v6", source)
        self.assertIn("winget-cli-manifest-${{ steps.validate.outputs.tag }}", source)
        self.assertLess(
            source.index("Verify GitHub release is published and latest"),
            source.index("Publish npm CLI package"),
        )
        self.assertLess(
            source.index("Verify npm CLI package metadata"),
            source.index("Publish stable release to verified static edge"),
        )

    def test_stable_release_does_not_require_npm_wrapper_publication(self) -> None:
        source = (ROOT / ".github" / "workflows" / "release.yml").read_text(encoding="utf-8")
        self.assertNotIn("Validate stable npm CLI package version", source)
        self.assertNotIn("validate-npm-cli-package-version.py --tag", source)

    def test_cli_container_uses_data_volume_and_help_entrypoint(self) -> None:
        dockerfile = (ROOT / "Dockerfile.cli").read_text(encoding="utf-8")
        compose = (ROOT / "docker-compose.cli.yml").read_text(encoding="utf-8")
        workflow = (ROOT / ".github" / "workflows" / "docker-images.yml").read_text(encoding="utf-8")
        self.assertIn('ENTRYPOINT ["/usr/local/bin/gonavi"]', dockerfile)
        self.assertIn('VOLUME ["/data"]', dockerfile)
        self.assertIn("GONAVI_DATA_ROOT=/data", dockerfile)
        self.assertIn("ARG VERSION=dev", dockerfile)
        self.assertIn('ARG TARGETOS', dockerfile)
        self.assertIn('ARG TARGETARCH', dockerfile)
        self.assertIn(
            './tools/generate-driver-agent-revisions.sh --platform "${TARGETOS}/${TARGETARCH}"',
            dockerfile,
        )
        self.assertIn("GoNavi-Wails/internal/cli.Version=${VERSION}", dockerfile)
        self.assertIn("GONAVI_DATA_ROOT: /data", compose)
        self.assertIn("GONAVI_LOG_DIR: /data/logs", compose)
        self.assertIn("HOME: /data", compose)
        self.assertIn("GONAVI_CONTAINER_UID", compose)
        self.assertIn("GONAVI_CONTAINER_GID", compose)
        self.assertIn("VERSION=${{ steps.prep.outputs.version }}", workflow)
        self.assertIn('--user "$(id -u):$(id -g)"', workflow)
        self.assertIn("-e GONAVI_LOG_DIR=/data/logs", workflow)
        self.assertIn('> "$data_dir/connections.json"', workflow)
        self.assertIn('"id":"cli-docker-smoke"', workflow)
        self.assertNotIn("--data-root /data list-connections", workflow)
        self.assertNotIn('chmod 0777 "$data_dir"', workflow)


if __name__ == "__main__":
    unittest.main()
