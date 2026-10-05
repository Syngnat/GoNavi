#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$SCRIPT_DIR"
SCRIPT_DIR_WINDOWS="$(pwd -W 2>/dev/null || true)"
SCRIPT_DIR_WINDOWS="${SCRIPT_DIR_WINDOWS//\\//}"

DEFAULT_DRIVERS=(mariadb oceanbase diros starrocks sphinx sqlserver sqlite duckdb dameng kingbase highgo vastbase opengauss gaussdb iris cache mongodb tdengine iotdb clickhouse elasticsearch trino kafka rocketmq pulsar)
# shellcheck source=tools/datasource-registry.sh
source "$SCRIPT_DIR/tools/datasource-registry.sh"
load_datasource_registry "$SCRIPT_DIR"
DEFAULT_DRIVERS+=("${REGISTRY_DRIVERS[@]}")
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
    mariadb|diros|starrocks|sphinx|sqlserver|sqlite|duckdb|dameng|kingbase|highgo|vastbase|gaussdb|iris|cache|mongodb|tdengine|iotdb|clickhouse|trino|kafka|rocketmq|pulsar)
      echo "$value"
      ;;
    *)
      registry_normalize_driver "$value"
      ;;
  esac
}

build_driver_name() {
  echo "$1"
}

driver_build_tags() {
  local driver="$1"
  local build_driver tag registry_tag
  build_driver="$(build_driver_name "$driver")"
  tag="gonavi_${build_driver}_driver"
  if registry_tag="$(registry_driver_build_tag "$driver")"; then
    tag="$registry_tag"
  fi
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

hash_stdin() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum | awk '{print $1}'
    return
  fi
  if command -v shasum >/dev/null 2>&1; then
    shasum -a 256 | awk '{print $1}'
    return
  fi
  echo "未找到 sha256sum 或 shasum" >&2
  exit 1
}

# 仓库内源码按索引内容（LF）计算哈希：Windows 上 core.autocrlf=true 会把工作区检出为 CRLF，
# 直接哈希会得到与 CI（LF 检出）不同的 revision。模块缓存里的依赖源码不受 autocrlf 影响，按原样哈希。
hash_source_file() {
  local target="$1"
  local identity="$2"
  case "$identity" in
    gomod/*)
      hash_file "$target"
      ;;
    *)
      tr -d '\r' <"$target" | hash_stdin
      ;;
  esac
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

# revision 只回答一个问题：「已安装的 driver-agent 进程，其行为是否与当前 GoNavi
# 期望的一致」。因此指纹只覆盖真正跑在 agent 进程里的代码：
#   1. cmd/optional-driver-agent/*         —— agent 入口与 IPC 分发（全部驱动共享）
#   2. 下面的共享协议 / 取值归一化文件      —— 影响 agent 输出形态或 IPC 帧格式
#   3. 目标驱动自己的 internal/db 源码       —— 按文件名前缀匹配（见 driver_source_prefixes）
#   4. 上述文件直接 import 的外部模块闭包
# 只在 GoNavi 主进程执行的客户端包装代码（OptionalDriverAgentDB、拉起/定位/校验 agent、
# 工厂注册等）不参与指纹：它们的改动不会改变 agent 二进制的行为，若纳入会让每次
# 客户端重构都要求用户重装全部 driver-agent。
should_include_shared_internal_db_file() {
  local identity="$1"
  case "$identity" in
    internal/db/attach_external.go|\
internal/db/driver_support.go|\
internal/db/json_decode.go|\
internal/db/optional_driver_agent_ipc.go|\
internal/db/query_args.go|\
internal/db/query_args_impl.go|\
internal/db/query_value.go|\
internal/db/scan_rows.go|\
internal/db/ssl_mode.go|\
internal/db/timeout.go|\
internal/db/write_outcome.go)
      return 0
      ;;
  esac

  return 1
}

# 客户端专属文件：与驱动前缀同名（如 mysql_agent_*.go）但只在主进程执行，显式排除。
is_client_only_internal_db_file() {
  local identity="$1"
  case "$identity" in
    internal/db/agent_process.go|\
internal/db/agent_process_*.go|\
internal/db/database_optional_factories_*.go|\
internal/db/driver_agent_binary_check.go|\
internal/db/driver_agent_stderr_tail.go|\
internal/db/mysql_agent_impl.go|\
internal/db/mysql_agent_path.go|\
internal/db/optional_driver_agent_impl.go|\
internal/db/optional_driver_agent_params.go|\
internal/db/optional_driver_agent_protocol.go|\
internal/db/optional_driver_agent_stream.go|\
internal/db/optional_driver_build_*.go)
      return 0
      ;;
  esac

  return 1
}

# 每个驱动对应的 internal/db 源码文件名前缀：<prefix>.go、<prefix>_*.go 与
# query_args_impl_<prefix>.go 都视为该驱动自己的实现。共享基座（mysql / postgres /
# oracle / pg 元数据）按实际复用关系挂到派生驱动下。
driver_source_prefixes() {
  case "$1" in
    mariadb) echo "mariadb mysql" ;;
    oceanbase) echo "oceanbase oracle mysql" ;;
    diros) echo "diros mysql" ;;
    starrocks) echo "starrocks mysql" ;;
    sphinx) echo "sphinx mysql" ;;
    opengauss) echo "opengauss postgres pg" ;;
    gaussdb) echo "gaussdb postgres pg" ;;
    kingbase) echo "kingbase pg" ;;
    highgo) echo "highgo pg" ;;
    vastbase) echo "vastbase pg" ;;
    cache) echo "cache iris" ;;
    # 消息队列借用 chroma_impl_rows.go 的取值小工具与 mysql_impl_dsn.go 的 host:port 解析，
    # 按文件名精确纳入，避免整组 mysql 改动牵连消息队列 agent 的 revision。
    kafka) echo "kafka message_queue_helpers chroma_impl_rows mysql_impl_dsn" ;;
    rocketmq) echo "rocketmq message_queue_helpers chroma_impl_rows mysql_impl_dsn" ;;
    pulsar) echo "pulsar chroma_impl_rows" ;;
    *) registry_driver_source_prefixes "$1" || echo "$1" ;;
  esac
}

should_include_driver_internal_db_file() {
  local driver="$1"
  local identity="$2"
  local base prefix

  case "$identity" in
    internal/db/*.go) ;;
    *) return 1 ;;
  esac
  if is_client_only_internal_db_file "$identity"; then
    return 1
  fi

  base="${identity#internal/db/}"
  for prefix in $(driver_source_prefixes "$driver"); do
    case "$base" in
      "${prefix}.go"|"${prefix}_"*.go|"query_args_impl_${prefix}.go")
        return 0
        ;;
    esac
  done

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
    internal/datasource/*.go)
      # 描述表加载与档位解析逻辑只影响描述表驱动；历史驱动的指纹不纳入。
      registry_driver_entry_hash "$driver" >/dev/null
      return
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

is_transient_go_module_error() {
  local log="$1"
  grep -Eiq \
    'stream error|INTERNAL_ERROR; received from peer|connection reset by peer|i/o timeout|TLS handshake timeout|timeout awaiting response headers|EOF|502 Bad Gateway|503 Service Unavailable|429 Too Many Requests' \
    "$log"
}

run_go_list_deps() {
  local output="$1"
  local cgo_enabled="$2"
  local target_goos="$3"
  local target_goarch="$4"
  local tag="$5"
  shift 5
  local attempt max_attempts=3
  local err_log raw
  local source_format='{{if not .Standard}}{{range .GoFiles}}{{$.Dir}}/{{.}}{{"\n"}}{{end}}{{range .CgoFiles}}{{$.Dir}}/{{.}}{{"\n"}}{{end}}{{end}}'
  err_log="$(mktemp "${TMPDIR:-/tmp}/gonavi-go-list-err.XXXXXX")"
  raw="$(mktemp "${TMPDIR:-/tmp}/gonavi-go-list-out.XXXXXX")"
  for attempt in 1 2 3; do
    if CGO_ENABLED="$cgo_enabled" GOOS="$target_goos" GOARCH="$target_goarch" GOTOOLCHAIN=auto \
      go list -deps \
        -tags "$tag" \
        -f "$source_format" \
        "$@" >"$raw" 2>"$err_log"; then
      cat "$err_log" >&2 || true
      LC_ALL=C sort -u "$raw" -o "$output"
      rm -f "$err_log" "$raw"
      return 0
    fi
    cat "$err_log" >&2 || true
    if [[ "$attempt" -lt "$max_attempts" ]] && is_transient_go_module_error "$err_log"; then
      echo "⚠️ go list 依赖枚举遇到瞬时错误，准备重试 (${attempt}/${max_attempts})" >&2
      sleep "${GONAVI_GO_LIST_RETRY_SLEEP:-$((attempt * 2))}"
      continue
    fi
    rm -f "$err_log" "$raw"
    return 1
  done
  rm -f "$err_log" "$raw"
  return 1
}

fingerprint_driver() {
  local driver="$1"
  local build_driver tag cgo_enabled tmp dependency_files included_files external_imports external_dependency_files hash_entries
  local file identity import_path file_hash revision registry_entry
  local -a direct_external_imports=()
  build_driver="$(build_driver_name "$driver")"
  tag="$(driver_build_tags "$driver")"
  cgo_enabled="$(registry_driver_cgo "$driver")"
  if [[ "$driver" == "duckdb" ]]; then
    cgo_enabled=1
  fi

  tmp="$(mktemp "${TMPDIR:-/tmp}/gonavi-agent-revision.XXXXXX")"
  {
    printf 'driver=%s\n' "$driver"
    printf 'build_tag=%s\n' "$tag"
    printf 'goos=%s\n' "$goos"
    printf 'goarch=%s\n' "$goarch"
    if registry_entry="$(registry_driver_entry_hash "$driver")"; then
      # 描述表经 go:embed 进入代理，只哈希 Go 源码会漏掉档位等声明的变化。
      printf 'registry_entry=%s\n' "$registry_entry"
    fi
  } >"$tmp"

  dependency_files="$(mktemp "${TMPDIR:-/tmp}/gonavi-agent-dependencies.XXXXXX")"
  if ! run_go_list_deps "$dependency_files" "$cgo_enabled" "$goos" "$goarch" "$tag" ./cmd/optional-driver-agent; then
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
    if ! run_go_list_deps "$external_dependency_files" "$cgo_enabled" "$goos" "$goarch" "$tag" "${direct_external_imports[@]}"; then
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
    file_hash="$(hash_source_file "$file" "$identity")"
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
