#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$SCRIPT_DIR"

same_commit_result="$(bash ./tools/diff-driver-agent-revisions.sh --base HEAD --head HEAD --platform darwin/arm64)"
if [[ -n "$same_commit_result" ]]; then
  echo "expected same commit revision diff to be empty, got: ${same_commit_result}" >&2
  exit 1
fi

tmpdir=""
tmpdir_frontend=""
cleanup() {
  if [[ -n "$tmpdir" ]]; then
    rm -rf "$tmpdir"
  fi
  if [[ -n "$tmpdir_frontend" ]]; then
    rm -rf "$tmpdir_frontend"
  fi
}
trap cleanup EXIT

tmpdir="$(mktemp -d "${TMPDIR:-/tmp}/gonavi-diff-driver-revisions.XXXXXX")"

rsync -a --exclude .git ./ "$tmpdir/" >/dev/null

(
  cd "$tmpdir"
  git init -q
  git add -f cmd/optional-driver-agent
  git add .
  git -c user.name=GoNavi -c user.email=gonavi@example.test commit -q -m initial
  base="$(git rev-parse HEAD)"

  perl -0pi -e 's/type DuckDB struct \{/\/\/ test revision change\n&type DuckDB struct {/' internal/db/duckdb_impl.go
  git add internal/db/duckdb_impl.go
  git -c user.name=GoNavi -c user.email=gonavi@example.test commit -q -m 'touch duckdb impl'

  actual="$(bash ./tools/diff-driver-agent-revisions.sh --base "$base" --head HEAD --platform darwin/arm64)"
  if [[ "$actual" != *"duckdb"* ]]; then
    echo "expected duckdb-specific source change to include duckdb revision rebuild, got: ${actual:-<empty>}" >&2
    exit 1
  fi

  filtered_actual="$(bash ./tools/diff-driver-agent-revisions.sh --base "$base" --head HEAD --platform darwin/arm64 --drivers duckdb)"
  if [[ "$filtered_actual" != "duckdb" ]]; then
    echo "expected --drivers duckdb to keep duckdb revision rebuild only, got: ${filtered_actual:-<empty>}" >&2
    exit 1
  fi

  ignored_actual="$(bash ./tools/diff-driver-agent-revisions.sh --base "$base" --head HEAD --platform darwin/arm64 --drivers mariadb)"
  if [[ -n "$ignored_actual" ]]; then
    echo "expected --drivers mariadb to ignore unrelated duckdb revision diff, got: ${ignored_actual}" >&2
    exit 1
  fi
)

rm -rf "$tmpdir"
tmpdir=""

tmpdir_frontend="$(mktemp -d "${TMPDIR:-/tmp}/gonavi-diff-driver-revisions-frontend.XXXXXX")"

rsync -a --exclude .git ./ "$tmpdir_frontend/" >/dev/null

(
  cd "$tmpdir_frontend"
  git init -q
  git add -f cmd/optional-driver-agent
  git add .
  git -c user.name=GoNavi -c user.email=gonavi@example.test commit -q -m initial
  base="$(git rev-parse HEAD)"

  perl -0pi -e 's/isAddingPrimaryKey:/isAddingPrimaryKeyFlag:/' frontend/src/components/tableDesignerDuckDbPrimaryKey.ts
  git add frontend/src/components/tableDesignerDuckDbPrimaryKey.ts
  git -c user.name=GoNavi -c user.email=gonavi@example.test commit -q -m 'touch frontend only'

  actual="$(bash ./tools/diff-driver-agent-revisions.sh --base "$base" --head HEAD --platform darwin/arm64)"
  if [[ -n "$actual" ]]; then
    echo "expected frontend-only change to keep driver revision diff empty, got: ${actual}" >&2
    exit 1
  fi
)

echo "diff-driver-agent-revisions test passed"
