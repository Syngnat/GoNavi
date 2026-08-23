#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$SCRIPT_DIR"

extract_revision() {
  local file="$1"
  local driver="$2"
  sed -n "s/.*\"${driver}\"[[:space:]]*:[[:space:]]*\"\\([^\"]*\\)\".*/\\1/p" "$file" | head -n 1
}

copy_repo_to_tmp() {
  local target="$1"
  git ls-files -z | tar --null -T - -cf - | (cd "$target" && tar -xf -)
}

tmpdir_failure="$(mktemp -d "${TMPDIR:-/tmp}/gonavi-generate-driver-revisions-failure.XXXXXX")"
tmpdir_platform="$(mktemp -d "${TMPDIR:-/tmp}/gonavi-generate-driver-revisions-platform.XXXXXX")"
tmpdir_connection="$(mktemp -d "${TMPDIR:-/tmp}/gonavi-generate-driver-revisions-connection.XXXXXX")"
tmpdir_scope="$(mktemp -d "${TMPDIR:-/tmp}/gonavi-generate-driver-revisions-scope.XXXXXX")"
tmpdir_runner="$(mktemp -d "${TMPDIR:-/tmp}/gonavi-generate-driver-revisions-runner.XXXXXX")"
darwin_file="$(mktemp "${TMPDIR:-/tmp}/gonavi-darwin-revisions.XXXXXX")"
windows_file="$(mktemp "${TMPDIR:-/tmp}/gonavi-windows-revisions.XXXXXX")"
cleanup() {
  rm -rf "$tmpdir_failure" "$tmpdir_platform" "$tmpdir_connection" "$tmpdir_scope" "$tmpdir_runner"
  rm -f "$darwin_file" "$windows_file"
}
trap cleanup EXIT

copy_repo_to_tmp "$tmpdir_failure"

(
  cd "$tmpdir_failure"
  cp internal/db/driver_agent_revisions_gen.go driver_agent_revisions.before.go
  mkdir -p fake-bin
  cat >fake-bin/go <<'EOF'
#!/usr/bin/env bash
set -euo pipefail

if [[ "${1:-}" == "list" ]]; then
  printf '%s\n' "$PWD/cmd/optional-driver-agent/main.go"
  exit 42
fi

exec "${REAL_GO:?}" "$@"
EOF
  chmod +x fake-bin/go

  if REAL_GO="$(command -v go)" PATH="$PWD/fake-bin:$PATH" GONAVI_DRIVER_REVISION_JOBS=1 \
    bash ./tools/generate-driver-agent-revisions.sh --platform darwin/arm64 --drivers mariadb \
      >generator.stdout 2>generator.stderr; then
    echo "expected revision generation to fail when go list returns a partial result" >&2
    exit 1
  fi
  if ! cmp -s driver_agent_revisions.before.go internal/db/driver_agent_revisions_gen.go; then
    echo "expected failed revision generation to preserve the existing revision file" >&2
    exit 1
  fi
  if ! grep -Fq "driver-agent dependency enumeration failed: mariadb (darwin/arm64)" generator.stderr; then
    echo "expected failed revision generation to report the dependency enumeration error" >&2
    cat generator.stderr >&2
    exit 1
  fi
)

copy_repo_to_tmp "$tmpdir_platform"

(
  cd "$tmpdir_platform"
  GONAVI_DRIVER_REVISION_JOBS=1 bash ./tools/generate-driver-agent-revisions.sh --platform darwin/arm64 --drivers duckdb >/dev/null
  cp internal/db/driver_agent_revisions_gen.go "$darwin_file"
  GONAVI_DRIVER_REVISION_JOBS=1 bash ./tools/generate-driver-agent-revisions.sh --platform windows/amd64 --drivers duckdb >/dev/null
  cp internal/db/driver_agent_revisions_gen.go "$windows_file"
)

darwin_duckdb="$(extract_revision "$darwin_file" duckdb)"
windows_duckdb="$(extract_revision "$windows_file" duckdb)"
if [[ -z "$darwin_duckdb" || -z "$windows_duckdb" ]]; then
  echo "expected duckdb revision to be generated for both platforms" >&2
  exit 1
fi
if [[ "$darwin_duckdb" == "$windows_duckdb" ]]; then
  echo "expected duckdb revision to differ between darwin/arm64 and windows/amd64, got identical value: $darwin_duckdb" >&2
  exit 1
fi

copy_repo_to_tmp "$tmpdir_runner"

(
  cd "$tmpdir_runner"
  runner_source="$tmpdir_runner/runner-only.go"
  before_file="$(mktemp "${TMPDIR:-/tmp}/gonavi-runner-revision-before.XXXXXX")"
  after_file="$(mktemp "${TMPDIR:-/tmp}/gonavi-runner-revision-after.XXXXXX")"
  cleanup_runner_revision_files() {
    rm -f "$before_file" "$after_file"
  }
  trap cleanup_runner_revision_files EXIT

  printf '%s\n' 'package runneronly' 'const Revision = "first"' > "$runner_source"
  mkdir -p fake-bin
  cat >fake-bin/go <<'EOF'
#!/usr/bin/env bash
set -euo pipefail

if [[ "${1:-}" == "list" ]]; then
  for arg in "$@"; do
    if [[ "$arg" == "./cmd/optional-driver-agent" ]]; then
      printf '%s\n' "$PWD/cmd/optional-driver-agent/main.go"
      printf '%s\n' "$PWD/internal/db/sqlite_impl.go"
      printf '%s\n' "${RUNNER_SOURCE:?}"
      exit 0
    fi
  done
fi

exec "${REAL_GO:?}" "$@"
EOF
  chmod +x fake-bin/go

  export REAL_GO="$(command -v go)"
  export RUNNER_SOURCE="$runner_source"
  export PATH="$PWD/fake-bin:$PATH"
  export GONAVI_DRIVER_REVISION_JOBS=1

  bash ./tools/generate-driver-agent-revisions.sh --platform darwin/arm64 --drivers sqlite >/dev/null
  cp internal/db/driver_agent_revisions_gen.go "$before_file"
  printf '%s\n' 'package runneronly' 'const Revision = "second"' > "$runner_source"
  bash ./tools/generate-driver-agent-revisions.sh --platform darwin/arm64 --drivers sqlite >/dev/null
  cp internal/db/driver_agent_revisions_gen.go "$after_file"

  before_sqlite="$(extract_revision "$before_file" sqlite)"
  after_sqlite="$(extract_revision "$after_file" sqlite)"
  if [[ -z "$before_sqlite" || -z "$after_sqlite" ]]; then
    echo "expected sqlite revision to be generated for runner-isolation check" >&2
    exit 1
  fi
  if [[ "$before_sqlite" != "$after_sqlite" ]]; then
    echo "expected runner-only dependency change to keep sqlite revision stable, before=$before_sqlite after=$after_sqlite" >&2
    exit 1
  fi
)

copy_repo_to_tmp "$tmpdir_connection"

(
  cd "$tmpdir_connection"
  GONAVI_DRIVER_REVISION_JOBS=1 bash ./tools/generate-driver-agent-revisions.sh --platform windows/amd64 --drivers sqlserver >/dev/null
  before_file="$(mktemp "${TMPDIR:-/tmp}/gonavi-sqlserver-revision-before.XXXXXX")"
  after_file="$(mktemp "${TMPDIR:-/tmp}/gonavi-sqlserver-revision-after.XXXXXX")"
  cleanup_sqlserver_revision_files() {
    rm -f "$before_file" "$after_file"
  }
  trap cleanup_sqlserver_revision_files EXIT

  cp internal/db/driver_agent_revisions_gen.go "$before_file"
  perl -0pi -e 's/RedisSentinelMaster   string/RedisSentinelLabel    string           `json:"redisSentinelLabel,omitempty"`\n\tRedisSentinelMaster   string/' internal/connection/types.go
  GONAVI_DRIVER_REVISION_JOBS=1 bash ./tools/generate-driver-agent-revisions.sh --platform windows/amd64 --drivers sqlserver >/dev/null
  cp internal/db/driver_agent_revisions_gen.go "$after_file"

  before_sqlserver="$(extract_revision "$before_file" sqlserver)"
  after_sqlserver="$(extract_revision "$after_file" sqlserver)"
  if [[ -z "$before_sqlserver" || -z "$after_sqlserver" ]]; then
    echo "expected sqlserver revision to be generated before and after connection-only change" >&2
    exit 1
  fi
  if [[ "$before_sqlserver" != "$after_sqlserver" ]]; then
    echo "expected Redis-only connection field change to keep sqlserver revision stable, before=$before_sqlserver after=$after_sqlserver" >&2
    exit 1
  fi
)

copy_repo_to_tmp "$tmpdir_scope"

(
  cd "$tmpdir_scope"
  fake_gomodcache="$(mktemp -d "${TMPDIR:-/tmp}/gonavi-fake-gomodcache.XXXXXX")"
  mkdir -p fake-bin "$fake_gomodcache/example.com/unrelated@v1.0.0" "$fake_gomodcache/modernc.org/sqlite@v1.0.0"
  cat >"$fake_gomodcache/example.com/unrelated@v1.0.0/unrelated.go" <<'EOF'
package unrelated

const Revision = "first"
EOF
  cat >"$fake_gomodcache/modernc.org/sqlite@v1.0.0/sqlite.go" <<'EOF'
package sqlite

const Revision = "first"
EOF
  cat >fake-bin/go <<'EOF'
#!/usr/bin/env bash
set -euo pipefail

if [[ "${1:-}" == "env" && "${2:-}" == "GOMODCACHE" ]]; then
  printf '%s\n' "${FAKE_GOMODCACHE:?}"
  exit 0
fi

if [[ "${1:-}" == "list" ]]; then
  for arg in "$@"; do
    case "$arg" in
      ./cmd/optional-driver-agent)
        printf '%s\n' "$PWD/cmd/optional-driver-agent/main.go"
        printf '%s\n' "$PWD/internal/db/sqlite_impl.go"
        printf '%s\n' "$PWD/internal/db/mysql_impl.go"
        printf '%s\n' "$PWD/internal/utils/utils.go"
        printf '%s\n' "${FAKE_GOMODCACHE:?}/example.com/unrelated@v1.0.0/unrelated.go"
        exit 0
        ;;
      modernc.org/sqlite)
        printf '%s\n' "${FAKE_GOMODCACHE:?}/modernc.org/sqlite@v1.0.0/sqlite.go"
        exit 0
        ;;
    esac
  done
fi

exec "${REAL_GO:?}" "$@"
EOF
  chmod +x fake-bin/go

  before_file="$(mktemp "${TMPDIR:-/tmp}/gonavi-sqlite-revision-before.XXXXXX")"
  external_file="$(mktemp "${TMPDIR:-/tmp}/gonavi-sqlite-revision-external.XXXXXX")"
  other_driver_file="$(mktemp "${TMPDIR:-/tmp}/gonavi-sqlite-revision-other-driver.XXXXXX")"
  dependency_file="$(mktemp "${TMPDIR:-/tmp}/gonavi-sqlite-revision-dependency.XXXXXX")"
  own_driver_file="$(mktemp "${TMPDIR:-/tmp}/gonavi-sqlite-revision-own-driver.XXXXXX")"
  cleanup_scope_revision_files() {
    rm -rf "$fake_gomodcache"
    rm -f "$before_file" "$external_file" "$other_driver_file" "$dependency_file" "$own_driver_file"
  }
  trap cleanup_scope_revision_files EXIT

  export FAKE_GOMODCACHE="$fake_gomodcache"
  export REAL_GO="$(command -v go)"
  export PATH="$PWD/fake-bin:$PATH"

  GONAVI_DRIVER_REVISION_JOBS=1 bash ./tools/generate-driver-agent-revisions.sh --platform windows/amd64 --drivers sqlite >/dev/null
  cp internal/db/driver_agent_revisions_gen.go "$before_file"

  perl -0pi -e 's/const Revision = "first"/const Revision = "second"/' "$FAKE_GOMODCACHE/example.com/unrelated@v1.0.0/unrelated.go"
  GONAVI_DRIVER_REVISION_JOBS=1 bash ./tools/generate-driver-agent-revisions.sh --platform windows/amd64 --drivers sqlite >/dev/null
  cp internal/db/driver_agent_revisions_gen.go "$external_file"

  printf '\n// unrelated mysql revision test marker\n' >>internal/db/mysql_impl.go
  printf '\n// unrelated shared revision test marker\n' >>internal/utils/utils.go
  GONAVI_DRIVER_REVISION_JOBS=1 bash ./tools/generate-driver-agent-revisions.sh --platform windows/amd64 --drivers sqlite >/dev/null
  cp internal/db/driver_agent_revisions_gen.go "$other_driver_file"

  perl -0pi -e 's/const Revision = "first"/const Revision = "second"/' "$FAKE_GOMODCACHE/modernc.org/sqlite@v1.0.0/sqlite.go"
  GONAVI_DRIVER_REVISION_JOBS=1 bash ./tools/generate-driver-agent-revisions.sh --platform windows/amd64 --drivers sqlite >/dev/null
  cp internal/db/driver_agent_revisions_gen.go "$dependency_file"

  printf '\n// sqlite revision test marker\n' >>internal/db/sqlite_impl.go
  GONAVI_DRIVER_REVISION_JOBS=1 bash ./tools/generate-driver-agent-revisions.sh --platform windows/amd64 --drivers sqlite >/dev/null
  cp internal/db/driver_agent_revisions_gen.go "$own_driver_file"

  before_sqlite="$(extract_revision "$before_file" sqlite)"
  external_sqlite="$(extract_revision "$external_file" sqlite)"
  other_driver_sqlite="$(extract_revision "$other_driver_file" sqlite)"
  dependency_sqlite="$(extract_revision "$dependency_file" sqlite)"
  own_driver_sqlite="$(extract_revision "$own_driver_file" sqlite)"
  if [[ -z "$before_sqlite" || -z "$external_sqlite" || -z "$other_driver_sqlite" || -z "$dependency_sqlite" || -z "$own_driver_sqlite" ]]; then
    echo "expected sqlite revision to be generated for every scope check" >&2
    exit 1
  fi
  if [[ "$before_sqlite" != "$external_sqlite" ]]; then
    echo "expected unrelated external dependency change to keep sqlite revision stable, before=$before_sqlite after=$external_sqlite" >&2
    exit 1
  fi
  if [[ "$before_sqlite" != "$other_driver_sqlite" ]]; then
    echo "expected unrelated driver and shared source changes to keep sqlite revision stable, before=$before_sqlite after=$other_driver_sqlite" >&2
    exit 1
  fi
  if [[ "$before_sqlite" == "$dependency_sqlite" ]]; then
    echo "expected sqlite dependency change to update sqlite revision, revision=$before_sqlite" >&2
    exit 1
  fi
  if [[ "$dependency_sqlite" == "$own_driver_sqlite" ]]; then
    echo "expected sqlite implementation change to update sqlite revision, revision=$dependency_sqlite" >&2
    exit 1
  fi
)

echo "generate-driver-agent-revisions platform test passed"
