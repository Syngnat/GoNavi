# Contributing Guide

Thank you for contributing to this project.

This repository uses `dev` as the default integration branch, while stable releases are published from `main` through `release/*` branches.

---

## Branch Model

- `dev`: default branch and day-to-day integration branch
- `main`: stable release branch
- `release/*`: release preparation branches for maintainers
- Recommended branch names for external contributors:
  - `fix/*`: bug fixes
  - `feature/*`: new features or enhancements

Maintainer release flow:

```text
feature/* / fix/* -> dev -> release/* -> main -> tag(vX.Y.Z)
```

---

## How External Contributors Should Open Pull Requests

Whether your branch is `fix/*` or `feature/*`, external contributors should **open pull requests directly against `dev`**.

Reasons:

- `dev` is the active integration branch, so changes can be reviewed in the same lane as ongoing work
- contributors align with the branch that triggers day-to-day validation and dev builds
- maintainers can cut `release/*` branches from `dev` without re-syncing external changes first

Recommended flow:

1. Fork this repository
2. Sync your fork with `dev` and create a branch from `dev` (`fix/*` or `feature/*` is recommended)
3. Make your changes and perform basic self-checks
4. Push the branch to your fork
5. Open a pull request against the `dev` branch of this repository

---

## Pull Request Requirements

Please keep each pull request focused, reviewable, and easy to validate.

Recommended expectations:

- one pull request should address one logical change
- use a clear title that explains the purpose
- include the following in the description:
  - background and problem statement
  - key changes
  - impact scope
  - validation method
- include screenshots or recordings for UI changes when helpful
- explicitly mention risk and rollback notes for compatibility, data, or build-chain changes
- include the failing output on the base commit and the passing output on the PR head for bug fixes
- run the checks that apply to the change, and list every check you did not run with the reason

`CI Gate` is the required status check. A PR is not ready to merge while it is failing,
cancelled, or missing.

---

## Merge Strategy for Maintainers

Pull requests merged into `dev` use **Merge commit** (the repository currently
does not enable squash or rebase merges).

Reasons:

- keeps the reviewed PR head and its merge record visible
- preserves the PR's individual commits for audit and rollback
- matches the branch ruleset's allowed merge method

---

## Maintainer Sync Rules

Because external pull requests are merged directly into `dev`, maintainers should treat `dev` as the source branch for daily collaboration and release preparation.

### 1. Create `release/*` from `dev`

Before a release, create a release branch from `dev`, for example:

```bash
git checkout dev
git pull
git checkout -b release/v0.6.0
git push -u origin release/v0.6.0
```

### 2. Release from `release/*` back to `main`

When release preparation is complete, merge the release branch back into `main` and create a tag:

```bash
git checkout main
git pull
git merge release/v0.6.0
git push
git tag v0.6.0
git push origin v0.6.0
```

### 3. Sync `main` back to `dev` after release

After the release, sync `main` back into `dev` so the next iteration starts from the released code line:

```bash
git checkout dev
git pull
git merge main
git push
```

---

## Coding Standards

GoNavi coding conventions for humans and AI (Cursor / Claude / Codex) live in [`AGENTS.md`](./AGENTS.md).

- Go: [`GO_STYLE.md`](./GO_STYLE.md) (Uber / Google / Effective Go — **not** the Alibaba Java manual)
- Java helpers: Alibaba Java Coding Guidelines

Hard rule: do not grow already oversized files. Split packages, types, hooks, and tests instead.

---

## Commit Message Recommendation

Keep commit messages clear and easy to audit.

Recommended format:

```text
emoji type(scope): concise description
```

Examples:

```text
🔧 fix(ci): fix DuckDB driver toolchain on Windows AMD64
✨ feat(redis): add Stream data browsing support
♻️ refactor(datagrid): optimize large-table horizontal scrolling and rendering
```

---

## Additional Notes

- Please include validation results for documentation, build-chain, or driver compatibility changes
- For larger changes, opening an issue or draft PR first is recommended
- Maintainers may ask contributors to narrow the scope if the change conflicts with the current project direction

Thank you for contributing.
