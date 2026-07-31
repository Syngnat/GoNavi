#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$SCRIPT_DIR"

tmpdir="$(mktemp -d "${TMPDIR:-/tmp}/gonavi-force-global-driver-builds.XXXXXX")"
cleanup() {
  rm -rf "$tmpdir"
}
trap cleanup EXIT

git init -q "$tmpdir"
mkdir -p "$tmpdir/tools" "$tmpdir/.github/workflows" "$tmpdir/internal/db"
cp tools/should-force-global-driver-builds.sh "$tmpdir/tools/should-force-global-driver-builds.sh"
cat >"$tmpdir/.github/workflows/dev-build.yml" <<'YAMLEOF'
name: Dev Build
YAMLEOF
cat >"$tmpdir/tools/package-driver-release-assets.py" <<'PYEOF'
print("package")
PYEOF
cat >"$tmpdir/tools/validate-driver-release-assets.py" <<'PYEOF'
print("validate")
PYEOF
cat >"$tmpdir/internal/db/duckdb_impl.go" <<'GOEOF'
package db
GOEOF

base_ref=""
cd "$tmpdir"
git add .
git -c user.name=GoNavi -c user.email=gonavi@example.test commit -q -m initial
base_ref="$(git rev-parse HEAD)"

(
  cd "$tmpdir"
  printf '\n# workflow change\n' >> .github/workflows/dev-build.yml
  git add .github/workflows/dev-build.yml
  git -c user.name=GoNavi -c user.email=gonavi@example.test commit -q -m 'workflow change'
  actual="$(bash ./tools/should-force-global-driver-builds.sh --base "$base_ref" --head HEAD)"
  if [[ "$actual" != "true" ]]; then
    echo "expected workflow change to force global driver builds, got: ${actual:-<empty>}" >&2
    exit 1
  fi
)

(
  cd "$tmpdir"
  git reset --hard -q "$base_ref"
  printf '\nprint("changed")\n' >> tools/package-driver-release-assets.py
  git add tools/package-driver-release-assets.py
  git -c user.name=GoNavi -c user.email=gonavi@example.test commit -q -m 'packaging change'
  actual="$(bash ./tools/should-force-global-driver-builds.sh --base "$base_ref" --head HEAD)"
  if [[ "$actual" != "false" ]]; then
    echo "expected packaging-only change not to force global driver builds, got: ${actual:-<empty>}" >&2
    exit 1
  fi
)

(
  cd "$tmpdir"
  git reset --hard -q "$base_ref"
  printf '\nprint("changed")\n' >> tools/validate-driver-release-assets.py
  git add tools/validate-driver-release-assets.py
  git -c user.name=GoNavi -c user.email=gonavi@example.test commit -q -m 'release asset validation change'
  actual="$(bash ./tools/should-force-global-driver-builds.sh --base "$base_ref" --head HEAD)"
  if [[ "$actual" != "false" ]]; then
    echo "expected release asset validation-only change not to force global driver builds, got: ${actual:-<empty>}" >&2
    exit 1
  fi
)

(
  cd "$tmpdir"
  git reset --hard -q "$base_ref"
  printf '\n// source-only change\n' >> internal/db/duckdb_impl.go
  git add internal/db/duckdb_impl.go
  git -c user.name=GoNavi -c user.email=gonavi@example.test commit -q -m 'duckdb source change'
  actual="$(bash ./tools/should-force-global-driver-builds.sh --base "$base_ref" --head HEAD)"
  if [[ "$actual" != "false" ]]; then
    echo "expected source-only driver change not to force global driver builds, got: ${actual:-<empty>}" >&2
    exit 1
  fi
)

(
  cd "$tmpdir"
  actual="$(bash ./tools/should-force-global-driver-builds.sh --base all --head HEAD)"
  if [[ "$actual" != "true" ]]; then
    echo "expected base=all to force global driver builds, got: ${actual:-<empty>}" >&2
    exit 1
  fi
)

echo "should-force-global-driver-builds test passed"
