#!/usr/bin/env bash

set -euo pipefail

if [[ "${BASH_VERSINFO[0]:-0}" -lt 4 ]]; then
  echo "skip: detect-changed-driver-agents.sh requires Bash 4+ for associative arrays; current bash is ${BASH_VERSION:-unknown}"
  exit 0
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$SCRIPT_DIR"

tmpdir="$(mktemp -d "${TMPDIR:-/tmp}/gonavi-detect-driver-revisions.XXXXXX")"
tmpdir_connection=""
tmpdir_script=""
tmpdir_shared_source=""
cleanup() {
  rm -rf "$tmpdir"
  if [[ -n "$tmpdir_connection" ]]; then
    rm -rf "$tmpdir_connection"
  fi
  if [[ -n "$tmpdir_script" ]]; then
    rm -rf "$tmpdir_script"
  fi
  if [[ -n "$tmpdir_shared_source" ]]; then
    rm -rf "$tmpdir_shared_source"
  fi
}
trap cleanup EXIT

git init -q "$tmpdir"
mkdir -p "$tmpdir/tools"
cp tools/detect-changed-driver-agents.sh "$tmpdir/tools/detect-changed-driver-agents.sh"
mkdir -p "$tmpdir/internal/db"
cat >"$tmpdir/internal/db/driver_agent_revisions_gen.go" <<'GOEOF'
package db

func init() {
	optionalDriverAgentRevisions = map[string]string{
		"mariadb":    "src-old-mariadb",
		"clickhouse": "src-old-clickhouse",
	}
}
GOEOF

(
  cd "$tmpdir"
  git add .
  git -c user.name=GoNavi -c user.email=gonavi@example.test commit -q -m initial
  base="$(git rev-parse HEAD)"
  perl -0pi -e 's/src-old-clickhouse/src-new-clickhouse/' internal/db/driver_agent_revisions_gen.go
  git add internal/db/driver_agent_revisions_gen.go
  git -c user.name=GoNavi -c user.email=gonavi@example.test commit -q -m 'update clickhouse revision'
  actual="$(bash ./tools/detect-changed-driver-agents.sh --base "$base" --head HEAD)"
  if [[ "$actual" != "clickhouse" ]]; then
    echo "expected clickhouse revision-only change to trigger clickhouse build, got: ${actual:-<empty>}" >&2
    exit 1
  fi
)

tmpdir_shared_source="$(mktemp -d "${TMPDIR:-/tmp}/gonavi-detect-shared-source.XXXXXX")"
git init -q "$tmpdir_shared_source"
mkdir -p "$tmpdir_shared_source/tools" "$tmpdir_shared_source/internal/db"
cp tools/detect-changed-driver-agents.sh "$tmpdir_shared_source/tools/detect-changed-driver-agents.sh"
cat >"$tmpdir_shared_source/internal/db/database.go" <<'GOEOF'
package db

func normalizeDriverType(driverType string) string {
	return driverType
}
GOEOF

(
  cd "$tmpdir_shared_source"
  git add .
  git -c user.name=GoNavi -c user.email=gonavi@example.test commit -q -m initial
  base="$(git rev-parse HEAD)"

  perl -0pi -e 's/return driverType/if driverType == "sqlite3" { return "sqlite" }\n\treturn driverType/' internal/db/database.go
  git add internal/db/database.go
  git -c user.name=GoNavi -c user.email=gonavi@example.test commit -q -m 'update shared database logic'

  actual="$(bash ./tools/detect-changed-driver-agents.sh --base "$base" --head HEAD)"
  expected="mariadb,oceanbase,doris,starrocks,sphinx,sqlserver,sqlite,duckdb,dameng,kingbase,highgo,vastbase,opengauss,gaussdb,iris,mongodb,tdengine,iotdb,clickhouse,elasticsearch,trino"
  if [[ "$actual" != "$expected" ]]; then
    echo "expected shared internal/db source change to trigger all driver builds, got: ${actual:-<empty>}" >&2
    exit 1
  fi
)

tmpdir_connection="$(mktemp -d "${TMPDIR:-/tmp}/gonavi-detect-connection-change.XXXXXX")"
git init -q "$tmpdir_connection"
mkdir -p "$tmpdir_connection/tools" "$tmpdir_connection/internal/connection"
cp tools/detect-changed-driver-agents.sh "$tmpdir_connection/tools/detect-changed-driver-agents.sh"
cat >"$tmpdir_connection/internal/connection/types.go" <<'GOEOF'
package connection

type ConnectionConfig struct {
	Type string `json:"type"`
}
GOEOF

(
  cd "$tmpdir_connection"
  git add .
  git -c user.name=GoNavi -c user.email=gonavi@example.test commit -q -m initial
  base="$(git rev-parse HEAD)"
  perl -0pi -e 's/Type string/RedisSentinelLabel string `json:"redisSentinelLabel,omitempty"`\n\tType string/' internal/connection/types.go
  git add internal/connection/types.go
  git -c user.name=GoNavi -c user.email=gonavi@example.test commit -q -m 'add redis-only connection field'
  actual="$(bash ./tools/detect-changed-driver-agents.sh --base "$base" --head HEAD)"
  if [[ -n "$actual" ]]; then
    echo "expected connection-only field change to keep driver-agent detection empty, got: ${actual}" >&2
    exit 1
  fi
)

tmpdir_script="$(mktemp -d "${TMPDIR:-/tmp}/gonavi-detect-script-change.XXXXXX")"
git init -q "$tmpdir_script"
mkdir -p "$tmpdir_script/tools"
cp tools/detect-changed-driver-agents.sh "$tmpdir_script/tools/detect-changed-driver-agents.sh"
(
  cd "$tmpdir_script"
  git add .
  git -c user.name=GoNavi -c user.email=gonavi@example.test commit -q -m initial
  base="$(git rev-parse HEAD)"
  printf '\n# test change\n' >> tools/detect-changed-driver-agents.sh
  git add tools/detect-changed-driver-agents.sh
  git -c user.name=GoNavi -c user.email=gonavi@example.test commit -q -m 'update detection script'
  actual="$(bash ./tools/detect-changed-driver-agents.sh --base "$base" --head HEAD 2>/dev/null)"
  if [[ "$actual" != *"mariadb"* || "$actual" != *"clickhouse"* || "$actual" != *"elasticsearch"* ]]; then
    echo "expected detection script change to trigger all driver builds, got: ${actual:-<empty>}" >&2
    exit 1
  fi
)

tmpdir_compensation="$(mktemp -d "${TMPDIR:-/tmp}/gonavi-detect-compensation.XXXXXX")"
git init -q "$tmpdir_compensation"
mkdir -p "$tmpdir_compensation/tools" "$tmpdir_compensation/internal/db" "$tmpdir_compensation/.github/workflows"
cp tools/detect-changed-driver-agents.sh "$tmpdir_compensation/tools/detect-changed-driver-agents.sh"
cat >"$tmpdir_compensation/internal/db/driver_agent_revisions_gen.go" <<'GOEOF'
package db

func init() {
	optionalDriverAgentRevisions = map[string]string{
		"clickhouse": "src-old-clickhouse",
	}
}
GOEOF
cat >"$tmpdir_compensation/.github/workflows/dev-build.yml" <<'YAMLEOF'
name: Dev Build
YAMLEOF

(
  cd "$tmpdir_compensation"
  git add .
  git -c user.name=GoNavi -c user.email=gonavi@example.test commit -q -m initial
  published_base="$(git rev-parse HEAD)"

  perl -0pi -e 's/src-old-clickhouse/src-new-clickhouse/' internal/db/driver_agent_revisions_gen.go
  git add internal/db/driver_agent_revisions_gen.go
  git -c user.name=GoNavi -c user.email=gonavi@example.test commit -q -m 'update clickhouse revision'
  push_base="$(git rev-parse HEAD)"

  printf '\n# workflow fix\n' >> .github/workflows/dev-build.yml
  git add .github/workflows/dev-build.yml
  git -c user.name=GoNavi -c user.email=gonavi@example.test commit -q -m 'fix workflow'

  actual_push_base="$(bash ./tools/detect-changed-driver-agents.sh --base "$push_base" --head HEAD)"
  if [[ -n "$actual_push_base" ]]; then
    echo "expected workflow-only fix commit to be empty when using push diff base, got: ${actual_push_base:-<empty>}" >&2
    exit 1
  fi

  actual_published_base="$(bash ./tools/detect-changed-driver-agents.sh --base "$published_base" --head HEAD)"
  if [[ "$actual_published_base" != "clickhouse" ]]; then
    echo "expected published release base to recover clickhouse rebuild, got: ${actual_published_base:-<empty>}" >&2
    exit 1
  fi
)

tmpdir_workflow="$(mktemp -d "${TMPDIR:-/tmp}/gonavi-detect-workflow-change.XXXXXX")"
git init -q "$tmpdir_workflow"
mkdir -p "$tmpdir_workflow/tools" "$tmpdir_workflow/.github/workflows"
cp tools/detect-changed-driver-agents.sh "$tmpdir_workflow/tools/detect-changed-driver-agents.sh"
cat >"$tmpdir_workflow/.github/workflows/dev-build.yml" <<'YAMLEOF'
name: Dev Build
YAMLEOF

(
  cd "$tmpdir_workflow"
  git add .
  git -c user.name=GoNavi -c user.email=gonavi@example.test commit -q -m initial
  base="$(git rev-parse HEAD)"

  printf '\n# workflow logic changed\n' >> .github/workflows/dev-build.yml
  git add .github/workflows/dev-build.yml
  git -c user.name=GoNavi -c user.email=gonavi@example.test commit -q -m 'update workflow'

  actual="$(bash ./tools/detect-changed-driver-agents.sh --base "$base" --head HEAD 2>/dev/null)"
  if [[ "$actual" != *"mariadb"* || "$actual" != *"clickhouse"* || "$actual" != *"duckdb"* || "$actual" != *"elasticsearch"* ]]; then
    echo "expected workflow change to trigger all driver builds, got: ${actual:-<empty>}" >&2
    exit 1
  fi
)

tmpdir_packaging="$(mktemp -d "${TMPDIR:-/tmp}/gonavi-detect-packaging-change.XXXXXX")"
git init -q "$tmpdir_packaging"
mkdir -p "$tmpdir_packaging/tools"
cp tools/detect-changed-driver-agents.sh "$tmpdir_packaging/tools/detect-changed-driver-agents.sh"
cat >"$tmpdir_packaging/tools/package-driver-release-assets.py" <<'PYEOF'
print("package")
PYEOF

(
  cd "$tmpdir_packaging"
  git add .
  git -c user.name=GoNavi -c user.email=gonavi@example.test commit -q -m initial
  base="$(git rev-parse HEAD)"

  printf '\nprint("changed")\n' >> tools/package-driver-release-assets.py
  git add tools/package-driver-release-assets.py
  git -c user.name=GoNavi -c user.email=gonavi@example.test commit -q -m 'update packaging script'

  # 发布打包脚本不参与驱动二进制构建，改动不应触发任何驱动重建
  actual="$(bash ./tools/detect-changed-driver-agents.sh --base "$base" --head HEAD 2>/dev/null)"
  if [[ -n "$actual" ]]; then
    echo "expected packaging script change to trigger no driver builds, got: ${actual}" >&2
    exit 1
  fi
)

tmpdir_release_validation="$(mktemp -d "${TMPDIR:-/tmp}/gonavi-detect-release-validation-change.XXXXXX")"
git init -q "$tmpdir_release_validation"
mkdir -p "$tmpdir_release_validation/tools"
cp tools/detect-changed-driver-agents.sh "$tmpdir_release_validation/tools/detect-changed-driver-agents.sh"
cat >"$tmpdir_release_validation/tools/validate-driver-release-assets.py" <<'PYEOF'
print("validate")
PYEOF

(
  cd "$tmpdir_release_validation"
  git add .
  git -c user.name=GoNavi -c user.email=gonavi@example.test commit -q -m initial
  base="$(git rev-parse HEAD)"

  printf '\nprint("changed")\n' >> tools/validate-driver-release-assets.py
  git add tools/validate-driver-release-assets.py
  git -c user.name=GoNavi -c user.email=gonavi@example.test commit -q -m 'update release validation script'

  # 发布校验脚本不参与驱动二进制构建，改动不应触发任何驱动重建
  actual="$(bash ./tools/detect-changed-driver-agents.sh --base "$base" --head HEAD 2>/dev/null)"
  if [[ -n "$actual" ]]; then
    echo "expected release validation script change to trigger no driver builds, got: ${actual}" >&2
    exit 1
  fi
)

echo "detect-changed-driver-agents revision test passed"
