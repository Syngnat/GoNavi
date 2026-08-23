#!/usr/bin/env python3

import importlib.util
import io
import json
import os
import pathlib
import subprocess
import sys
import tempfile
import unittest
from contextlib import redirect_stderr
from unittest import mock


ROOT = pathlib.Path(__file__).resolve().parents[1]
MODULE_PATH = pathlib.Path(__file__).with_name("generate-release-notes.py")
SPEC = importlib.util.spec_from_file_location("generate_release_notes", MODULE_PATH)
MODULE = importlib.util.module_from_spec(SPEC)
assert SPEC.loader is not None
sys.modules[SPEC.name] = MODULE
SPEC.loader.exec_module(MODULE)


class GenerateReleaseNotesTests(unittest.TestCase):
    def test_resolves_previous_release_tag_even_when_history_is_not_linear(self) -> None:
        with mock.patch.object(
            MODULE,
            "run_git",
            return_value="v1.2.0\nv1.1.0\nv1.0.0\nv0.9.0\n",
        ):
            self.assertEqual(MODULE.resolve_previous_tag("v1.1.0"), "v1.0.0")

    def test_warns_when_release_tags_have_diverged(self) -> None:
        error = subprocess.CalledProcessError(1, ["git", "merge-base"])
        stderr = io.StringIO()
        with mock.patch.object(MODULE, "run_git", side_effect=error), redirect_stderr(stderr):
            MODULE.warn_if_release_history_diverged("v1.0.0", "v1.1.0")

        self.assertIn("v1.0.0 is not an ancestor of v1.1.0", stderr.getvalue())

    def test_renders_external_contributor_mentions_without_tagging_owner_or_bots(self) -> None:
        external_sha = "a" * 40
        owner_sha = "b" * 40
        bot_sha = "c" * 40
        body = MODULE.render_release_notes(
            commits=[
                MODULE.Commit(external_sha, "✨ feat(export): add contributor notes", "Outside", "outside@example.test"),
                MODULE.Commit(owner_sha, "🐛 fix(release): keep owner entry", "Syngnat", "owner@example.test"),
                MODULE.Commit(bot_sha, "🔧 chore(deps): update action", "Bot", "bot@example.test"),
            ],
            attributions={
                external_sha: "OutsideUser",
                owner_sha: "Syngnat",
                bot_sha: "dependabot[bot]",
            },
            repository="Syngnat/GoNavi",
            tag="v1.1.0",
            previous_tag="v1.0.0",
            repository_url="https://github.com/Syngnat/GoNavi",
        )

        self.assertIn(
            "- ✨ feat(export): add contributor notes (contributed by **@OutsideUser**)",
            body,
        )
        self.assertIn("- 🐛 fix(release): keep owner entry", body)
        self.assertNotIn("keep owner entry (contributed by", body)
        self.assertNotIn("dependabot[bot]", body)
        self.assertEqual(body.count("**@OutsideUser**"), 1)

    def test_prefers_merged_pull_request_author_for_commit_attribution(self) -> None:
        pulls = [
            {
                "number": 600,
                "merged_at": "2026-07-17T13:49:59Z",
                "user": {"login": "OutsideUser"},
                "base": {"repo": {"full_name": "Syngnat/GoNavi"}},
            },
            {
                "number": 666,
                "merged_at": "2026-07-18T13:49:59Z",
                "user": {"login": "Syngnat"},
                "base": {"repo": {"full_name": "Syngnat/GoNavi"}},
            }
        ]
        commit_payload = {"author": {"login": "Syngnat"}}

        login = MODULE.resolve_contributor_login(
            pulls=pulls,
            commit_payload=commit_payload,
            author_email="owner@example.test",
            repository="Syngnat/GoNavi",
        )

        self.assertEqual(login, "OutsideUser")

    def test_api_outage_uses_noreply_fallback_and_opens_the_circuit(self) -> None:
        class UnavailableClient:
            available = True
            calls = 0

            def get_json(self, _path: str):
                self.calls += 1
                self.available = False
                raise MODULE.GitHubUnavailableError("offline")

        client = UnavailableClient()
        commit = MODULE.Commit(
            "d" * 40,
            "✨ feat(release): external contribution (#666)",
            "Outside User",
            "123+OutsideUser@users.noreply.github.com",
        )
        with redirect_stderr(io.StringIO()):
            login = MODULE.fetch_commit_attribution(
                client=client,
                repository="Syngnat/GoNavi",
                commit=commit,
            )

        self.assertEqual(login, "OutsideUser")
        self.assertEqual(client.calls, 1)

    def test_commit_api_login_wins_over_historical_noreply_login(self) -> None:
        class RecordingClient:
            available = True
            paths: list[str] = []

            def get_json(self, path: str):
                self.paths.append(path)
                if path.endswith("/pulls"):
                    return []
                return {"author": {"login": "CurrentLogin"}}

        client = RecordingClient()
        commit = MODULE.Commit(
            "f" * 40,
            "🐛 fix(release): preserve current login",
            "Old Login",
            "123+OldLogin@users.noreply.github.com",
        )
        login = MODULE.fetch_commit_attribution(
            client=client,
            repository="Syngnat/GoNavi",
            commit=commit,
        )

        self.assertEqual(login, "CurrentLogin")
        self.assertEqual(len(client.paths), 2)

    def test_real_client_opens_circuit_for_incomplete_http_response(self) -> None:
        client = MODULE.GitHubClient(token="test-token")
        incomplete = MODULE.http.client.IncompleteRead(b"", 1)
        with mock.patch.object(
            MODULE.urllib.request,
            "urlopen",
            side_effect=incomplete,
        ) as urlopen, mock.patch.object(MODULE.time, "sleep"):
            with self.assertRaises(MODULE.GitHubUnavailableError):
                client.get_json("repos/Syngnat/GoNavi/commits/deadbeef")
            with self.assertRaises(MODULE.GitHubUnavailableError):
                client.get_json("repos/Syngnat/GoNavi/commits/deadbeef")

        self.assertFalse(client.available)
        self.assertEqual(urlopen.call_count, 3)

    def test_git_log_parser_allows_control_separators_in_subject(self) -> None:
        sha = "e" * 40
        output = f"{sha}\0✨ feat: keep \x1e and \x1f\0Outside User\0outside@example.test"
        with mock.patch.object(MODULE, "run_git", return_value=output):
            commits = MODULE.read_commits("v1.1.0", "v1.0.0")

        self.assertEqual(len(commits), 1)
        self.assertEqual(commits[0].subject, "✨ feat: keep \x1e and \x1f")

    def test_cli_generates_notes_from_git_range_and_offline_attribution_fixture(self) -> None:
        with tempfile.TemporaryDirectory(prefix="gonavi-release-notes-") as tmp:
            repo = pathlib.Path(tmp)
            self.run_git(repo, "init")
            self.run_git(repo, "config", "user.name", "Syngnat")
            self.run_git(repo, "config", "user.email", "owner@example.test")

            (repo / "fixture.txt").write_text("baseline\n", encoding="utf-8")
            self.run_git(repo, "add", "fixture.txt")
            self.run_git(repo, "commit", "-m", "🔧 chore: baseline")
            self.run_git(repo, "tag", "v1.0.0")

            (repo / "fixture.txt").write_text("baseline\nowner\n", encoding="utf-8")
            self.run_git(repo, "add", "fixture.txt")
            self.run_git(repo, "commit", "-m", "🐛 fix(release): owner fix")
            owner_sha = self.run_git(repo, "rev-parse", "HEAD").strip()

            (repo / "fixture.txt").write_text("baseline\nowner\nexternal\n", encoding="utf-8")
            self.run_git(repo, "add", "fixture.txt")
            contributor_env = {
                **os.environ,
                "GIT_AUTHOR_NAME": "Outside User",
                "GIT_AUTHOR_EMAIL": "123+OutsideUser@users.noreply.github.com",
                "GIT_COMMITTER_NAME": "Outside User",
                "GIT_COMMITTER_EMAIL": "123+OutsideUser@users.noreply.github.com",
            }
            self.run_git(repo, "commit", "-m", "✨ feat(release): external feature (#666)", env=contributor_env)
            external_sha = self.run_git(repo, "rev-parse", "HEAD").strip()
            self.run_git(repo, "tag", "v1.1.0")

            attributions = repo / "attributions.json"
            attributions.write_text(
                json.dumps({owner_sha: "Syngnat", external_sha: "OutsideUser"}),
                encoding="utf-8",
            )
            output = repo / "release-notes.md"
            subprocess.check_call(
                [
                    sys.executable,
                    str(MODULE_PATH),
                    "--repo",
                    "Syngnat/GoNavi",
                    "--tag",
                    "v1.1.0",
                    "--previous-tag",
                    "v1.0.0",
                    "--repository-url",
                    "https://github.com/Syngnat/GoNavi",
                    "--attributions-file",
                    str(attributions),
                    "--output",
                    str(output),
                ],
                cwd=repo,
                env={key: value for key, value in os.environ.items() if key != "GITHUB_TOKEN"},
            )

            body = output.read_text(encoding="utf-8")
            self.assertIn("## ✨ 新功能", body)
            self.assertIn("external feature (#666) (contributed by **@OutsideUser**)", body)
            self.assertIn("## 🐛 问题修复", body)
            self.assertNotIn("owner fix (contributed by", body)
            self.assertIn(
                "[v1.0.0...v1.1.0](https://github.com/Syngnat/GoNavi/compare/v1.0.0...v1.1.0)",
                body,
            )

    def test_release_workflow_uses_tested_generator_and_pull_request_metadata(self) -> None:
        release = (ROOT / ".github" / "workflows" / "release.yml").read_text(encoding="utf-8")
        dev_build = (ROOT / ".github" / "workflows" / "dev-build.yml").read_text(encoding="utf-8")

        self.assertIn("pull-requests: read", release)
        self.assertIn("python3 tools/generate-release-notes.py", release)
        self.assertNotIn("git log \"$RANGE\" --no-merges --pretty=format:'%s'", release)
        changelog_step = release.split("- name: Generate Changelog", 1)[1].split(
            "- name: Create Release", 1
        )[0]
        for expected in (
            "GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}",
            'CHANGELOG_FILE="$RUNNER_TEMP/changelog.md"',
            '--repo "${{ github.repository }}"',
            '--tag "$RELEASE_TAG"',
            '--repository-url "${{ github.server_url }}/${{ github.repository }}"',
            '--output "$CHANGELOG_FILE"',
            'echo "changelog_file=$CHANGELOG_FILE" >> "$GITHUB_OUTPUT"',
        ):
            self.assertIn(expected, changelog_step)
        create_release_step = release.split("- name: Create Release", 1)[1]
        self.assertIn(
            "body_path: ${{ steps.changelog.outputs.changelog_file }}",
            create_release_step,
        )
        for workflow in (release, dev_build):
            self.assertIn("python3 tools/generate-release-notes.test.py", workflow)

    @staticmethod
    def run_git(repo: pathlib.Path, *args: str, env=None) -> str:
        return subprocess.check_output(
            ["git", *args],
            cwd=repo,
            env=env,
            text=True,
            encoding="utf-8",
            stderr=subprocess.STDOUT,
        )


if __name__ == "__main__":
    unittest.main()
