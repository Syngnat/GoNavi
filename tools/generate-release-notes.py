#!/usr/bin/env python3
"""Generate categorized GitHub release notes with contributor attribution.

For every non-merge commit in the release range, the generator first resolves
the author of an associated merged pull request. It falls back to GitHub's
commit metadata and then to a GitHub noreply email address. External
contributors are mentioned in the resulting Markdown so GitHub can render its
native contributor names and avatar list on the release page.
"""

from __future__ import annotations

import argparse
import http.client
import json
import os
import re
import subprocess
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Mapping, Sequence


GITHUB_LOGIN_RE = re.compile(r"^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$")
GITHUB_NOREPLY_RE = re.compile(
    r"^(?:\d+\+)?(?P<login>[A-Za-z0-9-]+(?:\[bot\])?)@users\.noreply\.github\.com$",
    re.IGNORECASE,
)
CONTRIBUTED_BY_RE = re.compile(
    r"\(\s*contributed\s+by\s+(?:\*\*)?@[A-Za-z0-9-]+(?:\*\*)?\s*\)",
    re.IGNORECASE,
)


@dataclass(frozen=True)
class Commit:
    sha: str
    subject: str
    author_name: str
    author_email: str


class GitHubUnavailableError(RuntimeError):
    """Raised after GitHub API retries are exhausted."""


class GitHubClient:
    """Small read-only GitHub REST client used by the release workflow."""

    def __init__(self, token: str = "", api_url: str = "https://api.github.com") -> None:
        self._token = token.strip()
        self._api_url = api_url.rstrip("/")
        self._available = True

    @property
    def available(self) -> bool:
        return self._available

    def get_json(self, path: str) -> Any:
        if not self._available:
            raise GitHubUnavailableError("GitHub API disabled after an earlier request failure")

        url = f"{self._api_url}/{path.lstrip('/')}"
        headers = {
            "Accept": "application/vnd.github+json",
            "User-Agent": "GoNavi-release-notes",
            "X-GitHub-Api-Version": "2022-11-28",
        }
        if self._token:
            headers["Authorization"] = f"Bearer {self._token}"

        for attempt in range(3):
            request = urllib.request.Request(url, headers=headers)
            try:
                with urllib.request.urlopen(request, timeout=15) as response:
                    return json.load(response)
            except urllib.error.HTTPError as exc:
                retryable = exc.code in {429, 500, 502, 503, 504}
                if retryable and attempt < 2:
                    time.sleep(2**attempt)
                    continue
                if exc.code in {401, 403, 429} or exc.code >= 500:
                    self._available = False
                    raise GitHubUnavailableError(
                        f"GitHub API returned HTTP {exc.code} for {path}"
                    ) from exc
                raise
            except (json.JSONDecodeError, UnicodeDecodeError) as exc:
                self._available = False
                raise GitHubUnavailableError(
                    f"GitHub API returned invalid JSON for {path}"
                ) from exc
            except (OSError, http.client.HTTPException) as exc:
                if attempt < 2:
                    time.sleep(2**attempt)
                    continue
                self._available = False
                raise GitHubUnavailableError(
                    f"GitHub API could not be reached for {path}"
                ) from exc

        self._available = False
        raise GitHubUnavailableError(f"GitHub request failed: {path}")


def run_git(*args: str) -> str:
    completed = subprocess.run(
        ["git", *args],
        check=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        encoding="utf-8",
        errors="replace",
    )
    return completed.stdout


def resolve_previous_tag(tag: str) -> str:
    """Return the preceding release tag by creation date.

    Release branches are not guaranteed to have linear ancestry, so the
    nearest reachable tag can be much older than the actual previous release.
    This keeps the established release ordering while explicitly excluding the
    tag currently being published.
    """

    output = run_git("tag", "--list", "v*", "--sort=-creatordate")
    tags = [candidate for candidate in output.splitlines() if candidate]
    current = tag.casefold()
    for index, candidate in enumerate(tags):
        if candidate.casefold() == current:
            return tags[index + 1] if index + 1 < len(tags) else ""
    return tags[0] if tags else ""


def warn_if_release_history_diverged(previous_tag: str, tag: str) -> None:
    if not previous_tag:
        return
    try:
        run_git("merge-base", "--is-ancestor", previous_tag, tag)
    except subprocess.CalledProcessError as exc:
        if exc.returncode != 1:
            raise
        print(
            f"warning: {previous_tag} is not an ancestor of {tag}; "
            "release notes will include commits reachable only from the new tag",
            file=sys.stderr,
        )


def read_commits(tag: str, previous_tag: str, max_commits: int = 0) -> list[Commit]:
    revision_range = f"{previous_tag}..{tag}" if previous_tag else tag
    git_args = [
        "log",
        revision_range,
        "--no-merges",
        "-z",
        "--pretty=format:%H%x00%s%x00%an%x00%ae",
    ]
    if max_commits > 0:
        git_args.insert(2, f"-n{max_commits}")
    output = run_git(*git_args)
    if not output:
        return []
    fields = output.split("\x00")
    if len(fields) % 4 != 0:
        raise ValueError("unexpected git log record while generating release notes")
    return [Commit(*fields[index : index + 4]) for index in range(0, len(fields), 4)]


def login_from_noreply_email(author_email: str) -> str:
    match = GITHUB_NOREPLY_RE.fullmatch(author_email.strip())
    return match.group("login") if match else ""


def _login_from_payload(payload: Any) -> str:
    if not isinstance(payload, Mapping):
        return ""
    login = payload.get("login")
    return login.strip() if isinstance(login, str) else ""


def resolve_contributor_login(
    *,
    pulls: Any,
    commit_payload: Any,
    author_email: str,
    repository: str,
) -> str:
    """Resolve attribution, preferring the author of the merged pull request."""

    candidates: list[Mapping[str, Any]] = []
    if isinstance(pulls, list):
        for pull in pulls:
            if not isinstance(pull, Mapping) or not pull.get("merged_at"):
                continue
            base = pull.get("base")
            base_repo = base.get("repo") if isinstance(base, Mapping) else None
            full_name = base_repo.get("full_name") if isinstance(base_repo, Mapping) else None
            if not isinstance(full_name, str) or full_name.casefold() != repository.casefold():
                continue
            if _login_from_payload(pull.get("user")):
                candidates.append(pull)

    if candidates:
        # Prefer the PR that originally introduced the commit. A newer
        # backport or release-branch PR may otherwise steal attribution from
        # the original contributor.
        selected = min(candidates, key=lambda pull: str(pull.get("merged_at", "")))
        return _login_from_payload(selected.get("user"))

    if isinstance(commit_payload, Mapping):
        login = _login_from_payload(commit_payload.get("author"))
        if login:
            return login

    return login_from_noreply_email(author_email)


def _api_path(repository: str, suffix: str) -> str:
    owner, name = repository.split("/", 1)
    return f"repos/{urllib.parse.quote(owner, safe='')}/{urllib.parse.quote(name, safe='')}/{suffix}"


def infer_login_from_commit(commit: Commit, repository: str) -> str:
    login = login_from_noreply_email(commit.author_email)
    if login:
        return login
    owner = repository.split("/", 1)[0]
    if commit.author_name.strip().casefold() == owner.casefold():
        return owner
    return ""


def fetch_commit_attribution(
    *,
    client: GitHubClient,
    repository: str,
    commit: Commit,
) -> str:
    encoded_sha = urllib.parse.quote(commit.sha, safe="")
    pulls: Any = []
    commit_payload: Any = {}

    try:
        pulls = client.get_json(_api_path(repository, f"commits/{encoded_sha}/pulls"))
    except (OSError, ValueError, GitHubUnavailableError) as exc:
        print(
            f"warning: unable to query associated pull requests for {commit.sha[:12]}: {exc}",
            file=sys.stderr,
        )
        if not client.available:
            return infer_login_from_commit(commit, repository)

    # A merged PR author is the most accurate attribution. Avoid the second API
    # request when it is already available.
    login = resolve_contributor_login(
        pulls=pulls,
        commit_payload={},
        author_email="",
        repository=repository,
    )
    if login:
        return login

    try:
        commit_payload = client.get_json(_api_path(repository, f"commits/{encoded_sha}"))
    except (OSError, ValueError, GitHubUnavailableError) as exc:
        print(
            f"warning: unable to query commit author for {commit.sha[:12]}: {exc}",
            file=sys.stderr,
        )

    return resolve_contributor_login(
        pulls=pulls,
        commit_payload=commit_payload,
        author_email=commit.author_email,
        repository=repository,
    )


def load_attributions(path: Path) -> dict[str, str]:
    payload = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(payload, dict):
        raise ValueError("attributions file must contain a JSON object")
    attributions: dict[str, str] = {}
    for sha, login in payload.items():
        if isinstance(sha, str) and isinstance(login, str):
            attributions[sha] = login.strip()
    return attributions


def collect_attributions(
    *,
    commits: Sequence[Commit],
    repository: str,
    fixture_path: Path | None,
) -> dict[str, str]:
    if fixture_path is not None:
        fixture = load_attributions(fixture_path)
        return {
            commit.sha: fixture.get(commit.sha, "") or login_from_noreply_email(commit.author_email)
            for commit in commits
        }

    token = os.environ.get("GITHUB_TOKEN", "")
    if not token:
        print(
            "warning: GITHUB_TOKEN is not set; GitHub API rate limits may prevent complete attribution",
            file=sys.stderr,
        )
    client = GitHubClient(
        token=token,
        api_url=os.environ.get("GITHUB_API_URL", "https://api.github.com"),
    )
    attributions: dict[str, str] = {}
    for commit in commits:
        if client.available:
            attributions[commit.sha] = fetch_commit_attribution(
                client=client,
                repository=repository,
                commit=commit,
            )
        else:
            attributions[commit.sha] = infer_login_from_commit(commit, repository)
    return attributions


def is_external_contributor(login: str, repository: str) -> bool:
    login = login.strip()
    owner = repository.split("/", 1)[0]
    if not login or login.casefold() == owner.casefold():
        return False
    lowered = login.casefold()
    if lowered.endswith("[bot]") or lowered in {"github-actions", "github-actions[bot]"}:
        return False
    return GITHUB_LOGIN_RE.fullmatch(login) is not None


def category_for_subject(subject: str) -> str:
    lowered = subject.casefold()
    if subject.startswith("✨") or "feat" in lowered:
        return "feature"
    if subject.startswith("🐛") or "fix" in lowered:
        return "fix"
    if subject.startswith("⚡") or "perf" in lowered:
        return "performance"
    if subject.startswith("♻️") or "refactor" in lowered:
        return "refactor"
    if subject.startswith("🌐"):
        return "i18n"
    return "other"


def render_release_notes(
    *,
    commits: Sequence[Commit],
    attributions: Mapping[str, str],
    repository: str,
    tag: str,
    previous_tag: str,
    repository_url: str,
) -> str:
    sections = [
        ("feature", "## ✨ 新功能"),
        ("fix", "## 🐛 问题修复"),
        ("performance", "## ⚡ 性能优化"),
        ("refactor", "## ♻️ 重构"),
        ("i18n", "## 🌐 国际化"),
        ("other", "## 🔧 其他变更"),
    ]
    categorized: dict[str, list[str]] = {key: [] for key, _ in sections}

    for commit in commits:
        subject = commit.subject.strip()
        if not subject:
            continue
        login = attributions.get(commit.sha, "").strip()
        attribution = ""
        if is_external_contributor(login, repository) and not CONTRIBUTED_BY_RE.search(subject):
            # A real GitHub @mention makes the release page render its native,
            # deduplicated Contributors avatar row; do not duplicate it in HTML.
            attribution = f" (contributed by **@{login}**)"
        categorized[category_for_subject(subject)].append(f"- {subject}{attribution}")

    blocks: list[str] = []
    for key, heading in sections:
        if categorized[key]:
            blocks.append(f"{heading}\n\n" + "\n".join(categorized[key]))

    if not blocks:
        blocks.append("暂无提交记录。")

    if previous_tag:
        base_url = repository_url.rstrip("/")
        previous_url = urllib.parse.quote(previous_tag, safe="")
        tag_url = urllib.parse.quote(tag, safe="")
        blocks.append(
            "---\n"
            f"**完整变更**: [{previous_tag}...{tag}]"
            f"({base_url}/compare/{previous_url}...{tag_url})"
        )

    return "\n\n".join(blocks) + "\n"


def parse_args(argv: Sequence[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Generate categorized release notes with GitHub contributor mentions"
    )
    parser.add_argument("--repo", required=True, help="GitHub repository in owner/name form")
    parser.add_argument("--tag", required=True, help="Release tag")
    parser.add_argument(
        "--previous-tag",
        default="",
        help="Previous git ref/tag/commit (default: preceding v* tag by creation date)",
    )
    parser.add_argument(
        "--max-commits",
        type=int,
        default=0,
        help="Optional max commit count in the range (0 = unlimited; useful for dense dev builds)",
    )
    parser.add_argument("--repository-url", required=True, help="Repository web URL")
    parser.add_argument(
        "--attributions-file",
        type=Path,
        help="Offline JSON mapping of commit SHA to GitHub login (tests/local use)",
    )
    parser.add_argument("--output", type=Path, required=True, help="Output Markdown file")
    args = parser.parse_args(argv)
    if not re.fullmatch(r"[^/\s]+/[^/\s]+", args.repo):
        parser.error("--repo must use owner/name format")
    if args.max_commits < 0:
        parser.error("--max-commits must be >= 0")
    return args


def main(argv: Sequence[str] | None = None) -> int:
    args = parse_args(argv)
    previous_tag = args.previous_tag.strip() or resolve_previous_tag(args.tag)
    warn_if_release_history_diverged(previous_tag, args.tag)
    revision_range = f"{previous_tag}..{args.tag}" if previous_tag else args.tag
    commits = read_commits(args.tag, previous_tag, max_commits=args.max_commits)
    attributions = collect_attributions(
        commits=commits,
        repository=args.repo,
        fixture_path=args.attributions_file,
    )
    body = render_release_notes(
        commits=commits,
        attributions=attributions,
        repository=args.repo,
        tag=args.tag,
        previous_tag=previous_tag,
        repository_url=args.repository_url,
    )

    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(body, encoding="utf-8")
    contributors = {
        login
        for login in attributions.values()
        if is_external_contributor(login, args.repo)
    }
    print(
        f"wrote {args.output} ({len(commits)} commits, {len(contributors)} external contributors, "
        f"range={revision_range})"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
