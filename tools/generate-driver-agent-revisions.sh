#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$SCRIPT_DIR"
SCRIPT_DIR_WINDOWS="$(pwd -W 2>/dev/null || true)"
SCRIPT_DIR_WINDOWS="${SCRIPT_DIR_WINDOWS//\\//}"

DEFAULT_DRIVERS=(mariadb oceanbase diros starrocks sphinx sqlserver sqlite duckdb dameng kingbase highgo vastbase opengauss gaussdb iris mongodb tdengine iotdb clickhouse elasticsearch trino)
OUTPUT_FILE="internal/db/driver_agent_revisions_gen.go"

usage() {
  cat <<'EOF'
用法：
  ./tools/generate-driver-agent-revisions.sh [选项]

选项：
  --platform <GOOS/GOARCH>  按目标平台解析 Go build tags，默认使用当前 Go 环境
  --drivers <列表>          只更新指定驱动（逗号分隔），并保留其他已生成 revision
  -h, --help                显示帮助
EOF
}

normalize_driver() {
  local value
  value="$(printf '%s' "$1" | tr '[:upper:]' '[:lower:]' | tr -d '[:space:]')"
  case "$value" in
    doris|diros) echo "diros" ;;
    oceanbase) echo "oceanbase" ;;
    opengauss|open_gauss|open-gauss) echo "opengauss" ;;
    gaussdb|gauss_db|gauss-db) echo "gaussdb" ;;
    elasticsearch|elastic) echo "elasticsearch" ;;
    mariadb|diros|starrocks|sphinx|sqlserver|sqlite|duckdb|dameng|kingbase|highgo|vastbase|gaussdb|iris|mongodb|tdengine|iotdb|clickhouse|trino)
      echo "$value"
      ;;
    *)
      return 1
      ;;
  esac
}

build_driver_name() {
  echo "$1"
}

driver_build_tags() {
  local driver="$1"
  local build_driver tag
  build_driver="$(build_driver_name "$driver")"
  tag="gonavi_${build_driver}_driver"
  if [[ "$driver" == "duckdb" && "$goos" == "windows" && "$goarch" == "amd64" ]]; then
    tag="$tag duckdb_use_lib"
  fi
  echo "$tag"
}

hash_file() {
  local target="$1"
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$target" | awk '{print $1}'
    return
  fi
  if command -v shasum >/dev/null 2>&1; then
    shasum -a 256 "$target" | awk '{print $1}'
    return
  fi
  echo "未找到 sha256sum 或 shasum" >&2
  exit 1
}

files_equal() {
  local left="$1"
  local right="$2"
  if command -v cmp >/dev/null 2>&1; then
    cmp -s "$left" "$right"
    return
  fi
  [[ "$(hash_file "$left")" == "$(hash_file "$right")" ]]
}

should_include_shared_internal_db_file() {
  local identity="$1"
  case "$identity" in
    internal/db/agent_process_stub.go|\
internal/db/agent_process_windows.go|\
internal/db/database.go|\
internal/db/database_optional_factories_full.go|\
internal/db/database_optional_factories_lite.go|\
internal/db/driver_agent_binary_check.go|\
internal/db/driver_support.go|\
internal/db/json_decode.go|\
internal/db/mysql_agent_path.go|\
internal/db/optional_driver_agent_impl.go|\
internal/db/optional_driver_build_full.go|\
internal/db/optional_driver_build_lite.go|\
internal/db/query_value.go|\
internal/db/scan_rows.go|\
internal/db/ssl_mode.go|\
internal/db/timeout.go)
      return 0
      ;;
  esac

  return 1
}

should_include_driver_internal_db_file() {
  local driver="$1"
  local identity="$2"

  case "$driver:$identity" in
    mariadb:internal/db/mariadb_impl.go|\
mariadb:internal/db/mysql_impl.go|\
oceanbase:internal/db/oceanbase_impl.go|\
oceanbase:internal/db/oracle_impl.go|\
oceanbase:internal/db/mysql_impl.go|\
diros:internal/db/diros_impl.go|\
diros:internal/db/mysql_impl.go|\
starrocks:internal/db/starrocks_impl.go|\
starrocks:internal/db/mysql_impl.go|\
sphinx:internal/db/sphinx_impl.go|\
sphinx:internal/db/mysql_impl.go|\
sqlserver:internal/db/sqlserver_impl.go|\
sqlite:internal/db/sqlite_impl.go|\
duckdb:internal/db/duckdb_impl.go|\
duckdb:internal/db/duckdb_metadata.go|\
duckdb:internal/db/duckdb_driver_import.go|\
duckdb:internal/db/duckdb_platform_supported.go|\
duckdb:internal/db/duckdb_platform_unsupported.go|\
dameng:internal/db/dameng_impl.go|\
dameng:internal/db/dameng_metadata.go|\
kingbase:internal/db/kingbase_impl.go|\
kingbase:internal/db/kingbase_identifier_utils.go|\
highgo:internal/db/highgo_impl.go|\
vastbase:internal/db/vastbase_impl.go|\
opengauss:internal/db/opengauss_impl.go|\
opengauss:internal/db/postgres_impl.go|\
gaussdb:internal/db/gaussdb_impl.go|\
gaussdb:internal/db/postgres_impl.go|\
iris:internal/db/iris_impl.go|\
mongodb:internal/db/mongodb_impl.go|\
mongodb:internal/db/mongodb_impl_v1.go|\
tdengine:internal/db/tdengine_impl.go|\
iotdb:internal/db/iotdb_impl.go|\
clickhouse:internal/db/clickhouse_impl.go|\
clickhouse:internal/db/clickhouse_legacy_http.go|\
elasticsearch:internal/db/elasticsearch_impl.go|\
elasticsearch:internal/db/elasticsearch_helpers.go|\
trino:internal/db/trino_impl.go)
      return 0
      ;;
  esac

  return 1
}

should_include_internal_db_file() {
  local driver="$1"
  local identity="$2"

  if should_include_shared_internal_db_file "$identity"; then
    return 0
  fi
  should_include_driver_internal_db_file "$driver" "$identity"
}

should_include_source_file() {
  local driver="$1"
  local identity="$2"

  # revision 用于验证 agent IPC 兼容性，不是整个二进制依赖树的版本号。
  # optional-driver-agent 依赖 monolithic internal/db 包，go list 会同时列出
  # 内置驱动和其他 optional driver 的依赖；把它们纳入指纹会让无关升级要求
  # 用户重装所有 driver-agent。
  case "$identity" in
    cmd/optional-driver-agent/*)
      return 0
      ;;
  esac
  if [[ "$identity" == internal/db/* ]]; then
    should_include_internal_db_file "$driver" "$identity"
    return
  fi
  return 1
}

list_go_imports() {
  awk '
    $1 == "import" && $2 == "(" { in_import = 1; next }
    $1 == "import" {
      for (i = 2; i <= NF; i++) {
        if ($i ~ /^"[^"]+"$/) {
          gsub(/^"|"$/, "", $i)
          print $i
          next
        }
      }
    }
    in_import && $1 == ")" { in_import = 0; next }
    in_import {
      for (i = 1; i <= NF; i++) {
        if ($i ~ /^"[^"]+"$/) {
          gsub(/^"|"$/, "", $i)
          print $i
          next
        }
      }
    }
  ' "$1"
}

is_external_import() {
  local first_segment="${1%%/*}"
  [[ "$first_segment" == *.* ]]
}

source_identity() {
  local file="${1//\\//}"
  if [[ -n "$gomodcache" && "$file" == "$gomodcache"/* ]]; then
    printf 'gomod/%s\n' "${file#$gomodcache/}"
    return
  fi
  if [[ -n "$SCRIPT_DIR_WINDOWS" && "$file" == "$SCRIPT_DIR_WINDOWS"/* ]]; then
    printf '%s\n' "${file#$SCRIPT_DIR_WINDOWS/}"
    return
  fi
  case "$file" in
    "$SCRIPT_DIR"/*)
      printf '%s\n' "${file#$SCRIPT_DIR/}"
      ;;
    *)
      printf '%s\n' "$file"
      ;;
  esac
}

target_platform=""
driver_csv=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --platform)
      target_platform="${2:-}"
      shift 2
      ;;
    --drivers)
      driver_csv="${2:-}"
      shift 2
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "未知参数：$1" >&2
      usage
      exit 1
      ;;
  esac
done

if ! command -v go >/dev/null 2>&1; then
  echo "未找到 Go，请先安装 Go 并确保 go 在 PATH 中。" >&2
  exit 1
fi

if [[ -z "$target_platform" ]]; then
  target_platform="$(go env GOOS)/$(go env GOARCH)"
fi
if [[ "$target_platform" != */* ]]; then
  echo "--platform 参数格式错误，应为 GOOS/GOARCH，例如 darwin/arm64" >&2
  exit 1
fi

goos="${target_platform%%/*}"
goarch="${target_platform##*/}"
gomodcache="$(go env GOMODCACHE)"
gomodcache="${gomodcache//\\//}"

declare -a drivers=()
if [[ -n "$driver_csv" ]]; then
  IFS=',' read -r -a raw_drivers <<<"$driver_csv"
  for item in "${raw_drivers[@]}"; do
    drivers+=("$(normalize_driver "$item")")
  done
else
  drivers=("${DEFAULT_DRIVERS[@]}")
fi

selected_driver_set="|"
for driver in "${drivers[@]}"; do
  selected_driver_set="${selected_driver_set}${driver}|"
done

existing_revision_for() {
  local target="$1"
  local line
  [[ -n "$driver_csv" && -f "$OUTPUT_FILE" ]] || return 1
  while IFS= read -r line; do
    if [[ "$line" =~ \"([^\"]+)\"[[:space:]]*:[[:space:]]*\"([^\"]+)\" ]]; then
      if [[ "${BASH_REMATCH[1]}" == "$target" ]]; then
        printf '%s\n' "${BASH_REMATCH[2]}"
        return 0
      fi
    fi
  done <"$OUTPUT_FILE"
  return 1
}

detect_revision_jobs() {
  local configured="${GONAVI_DRIVER_REVISION_JOBS:-}"
  local detected

  if [[ "$configured" =~ ^[0-9]+$ && "$configured" -gt 0 ]]; then
    echo "$configured"
    return
  fi

  if command -v nproc >/dev/null 2>&1; then
    detected="$(nproc)"
  elif command -v sysctl >/dev/null 2>&1; then
    detected="$(sysctl -n hw.ncpu 2>/dev/null || true)"
  else
    detected=""
  fi

  if ! [[ "$detected" =~ ^[0-9]+$ && "$detected" -gt 0 ]]; then
    detected=4
  fi

  if [[ "$detected" -gt 4 ]]; then
    detected=4
  fi
  echo "$detected"
}

declare -a output_drivers=()
if [[ -n "$driver_csv" ]]; then
  output_drivers=("${DEFAULT_DRIVERS[@]}")
else
  output_drivers=("${drivers[@]}")
fi

fingerprint_driver() {
  local driver="$1"
  local build_driver tag cgo_enabled tmp dependency_files included_files external_imports external_dependency_files hash_entries
  local file identity import_path file_hash revision
  local -a direct_external_imports=()
  build_driver="$(build_driver_name "$driver")"
  tag="$(driver_build_tags "$driver")"
  cgo_enabled=0
  if [[ "$driver" == "duckdb" ]]; then
    cgo_enabled=1
  fi

  tmp="$(mktemp "${TMPDIR:-/tmp}/gonavi-agent-revision.XXXXXX")"
  {
    printf 'driver=%s\n' "$driver"
    printf 'build_tag=%s\n' "$tag"
    printf 'goos=%s\n' "$goos"
    printf 'goarch=%s\n' "$goarch"
  } >"$tmp"

  dependency_files="$(mktemp "${TMPDIR:-/tmp}/gonavi-agent-dependencies.XXXXXX")"
  if ! CGO_ENABLED="$cgo_enabled" GOOS="$goos" GOARCH="$goarch" GOTOOLCHAIN=auto \
    go list -deps \
      -tags "$tag" \
      -f '{{if not .Standard}}{{range .GoFiles}}{{$.Dir}}/{{.}}{{"\n"}}{{end}}{{range .CgoFiles}}{{$.Dir}}/{{.}}{{"\n"}}{{end}}{{end}}' \
      ./cmd/optional-driver-agent | sort -u >"$dependency_files"; then
    rm -f "$tmp" "$dependency_files"
    echo "driver-agent dependency enumeration failed: $driver ($goos/$goarch)" >&2
    return 1
  fi

  included_files="$(mktemp "${TMPDIR:-/tmp}/gonavi-agent-included-files.XXXXXX")"
  external_imports="$(mktemp "${TMPDIR:-/tmp}/gonavi-agent-external-imports.XXXXXX")"
  external_dependency_files="$(mktemp "${TMPDIR:-/tmp}/gonavi-agent-external-dependencies.XXXXXX")"
  hash_entries="$(mktemp "${TMPDIR:-/tmp}/gonavi-agent-hash-entries.XXXXXX")"

  # 只从 agent 入口和目标 driver 源码提取外部 import，避免 internal/db
  # 包级依赖把其他驱动的 module closure 一并带入当前 revision。
  while IFS= read -r file; do
    file="${file//\\//}"
    [[ -n "$file" && -f "$file" ]] || continue
    identity="$(source_identity "$file")"
    if [[ "$identity" == "$OUTPUT_FILE" ]]; then
      continue
    fi
    if ! should_include_source_file "$driver" "$identity"; then
      continue
    fi
    printf '%s\n' "$file" >>"$included_files"

    if [[ "$identity" == cmd/optional-driver-agent/* ]] || should_include_driver_internal_db_file "$driver" "$identity"; then
      while IFS= read -r import_path; do
        if is_external_import "$import_path"; then
          printf '%s\n' "$import_path" >>"$external_imports"
        fi
      done < <(list_go_imports "$file")
    fi
  done <"$dependency_files"

  LC_ALL=C sort -u "$external_imports" -o "$external_imports"
  while IFS= read -r import_path; do
    [[ -n "$import_path" ]] || continue
    direct_external_imports+=("$import_path")
  done <"$external_imports"

  if [[ ${#direct_external_imports[@]} -gt 0 ]]; then
    if ! CGO_ENABLED="$cgo_enabled" GOOS="$goos" GOARCH="$goarch" GOTOOLCHAIN=auto \
      go list -deps \
        -tags "$tag" \
        -f '{{if not .Standard}}{{range .GoFiles}}{{$.Dir}}/{{.}}{{"\n"}}{{end}}{{range .CgoFiles}}{{$.Dir}}/{{.}}{{"\n"}}{{end}}{{end}}' \
        "${direct_external_imports[@]}" | LC_ALL=C sort -u >"$external_dependency_files"; then
      rm -f "$tmp" "$dependency_files" "$included_files" "$external_imports" "$external_dependency_files" "$hash_entries"
      echo "driver-agent external dependency enumeration failed: $driver ($goos/$goarch)" >&2
      return 1
    fi
  fi

  while IFS= read -r file; do
    file="${file//\\//}"
    [[ -n "$file" && -f "$file" ]] || continue
    identity="$(source_identity "$file")"
    case "$identity" in
      gomod/*|third_party/*)
        printf '%s\n' "$file" >>"$included_files"
        ;;
    esac
  done <"$external_dependency_files"

  LC_ALL=C sort -u "$included_files" -o "$included_files"
  while IFS= read -r file; do
    file="${file//\\//}"
    [[ -n "$file" && -f "$file" ]] || continue
    identity="$(source_identity "$file")"
    file_hash="$(hash_file "$file")"
    printf '%s  %s\n' "$file_hash" "$identity" >>"$hash_entries"
  done <"$included_files"
  LC_ALL=C sort -k2,2 "$hash_entries" >>"$tmp"
  rm -f "$dependency_files" "$included_files" "$external_imports" "$external_dependency_files" "$hash_entries"

  revision="$(hash_file "$tmp" | cut -c1-16)"
  rm -f "$tmp"
  printf 'src-%s' "$revision"
}

revision_jobs="$(detect_revision_jobs)"
revision_tmp_dir="$(mktemp -d "${TMPDIR:-/tmp}/gonavi-agent-revisions.XXXXXX")"
cleanup_revision_tmp_dir() {
  rm -rf "$revision_tmp_dir"
}
trap cleanup_revision_tmp_dir EXIT

declare -a revision_pids=()
declare -a revision_pid_drivers=()
revision_failed=0

wait_for_oldest_revision_job() {
  local pid driver
  pid="${revision_pids[0]}"
  driver="${revision_pid_drivers[0]}"

  if ! wait "$pid"; then
    echo "❌ 生成 driver-agent revision 失败：$driver ($goos/$goarch)" >&2
    revision_failed=1
  fi

  if [[ ${#revision_pids[@]} -le 1 ]]; then
    revision_pids=()
    revision_pid_drivers=()
  else
    revision_pids=("${revision_pids[@]:1}")
    revision_pid_drivers=("${revision_pid_drivers[@]:1}")
  fi
}

start_revision_job() {
  local driver="$1"
  {
    fingerprint_driver "$driver" >"$revision_tmp_dir/$driver.revision"
  } &
  revision_pids+=("$!")
  revision_pid_drivers+=("$driver")
}

for driver in "${output_drivers[@]}"; do
  if [[ -n "$driver_csv" && "$selected_driver_set" != *"|$driver|"* ]] && revision="$(existing_revision_for "$driver")"; then
    printf '%s\n' "$revision" >"$revision_tmp_dir/$driver.revision"
    continue
  fi

  while [[ ${#revision_pids[@]} -ge "$revision_jobs" ]]; do
    wait_for_oldest_revision_job
  done
  start_revision_job "$driver"
done

while [[ ${#revision_pids[@]} -gt 0 ]]; do
  wait_for_oldest_revision_job
done

if [[ "$revision_failed" -ne 0 ]]; then
  exit 1
fi

tmp_output="$(mktemp "${TMPDIR:-/tmp}/gonavi-agent-revisions-go.XXXXXX")"
{
  cat <<'EOF'
// Code generated by tools/generate-driver-agent-revisions.sh; DO NOT EDIT.

package db

func init() {
	optionalDriverAgentRevisions = map[string]string{
EOF
  for driver in "${output_drivers[@]}"; do
    revision="$(<"$revision_tmp_dir/$driver.revision")"
    printf '\t\t"%s": "%s",\n' "$driver" "$revision"
  done
  cat <<'EOF'
	}
}
EOF
} >"$tmp_output"

gofmt -w "$tmp_output"

if [[ -f "$OUTPUT_FILE" ]] && files_equal "$tmp_output" "$OUTPUT_FILE"; then
  rm -f "$tmp_output"
else
  mv "$tmp_output" "$OUTPUT_FILE"
fi

echo "已生成 driver-agent revisions: $OUTPUT_FILE ($goos/$goarch)"
