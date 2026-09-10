#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$SCRIPT_DIR"

DEFAULT_DRIVERS=(mariadb oceanbase diros starrocks sphinx sqlserver sqlite duckdb dameng kingbase highgo vastbase opengauss gaussdb iris cache mongodb tdengine iotdb clickhouse elasticsearch trino)

usage() {
  cat <<'EOF'
用法：
  ./tools/diff-driver-agent-revisions.sh --base <ref> --head <ref> --platform <GOOS/GOARCH>

输出：
  逗号分隔的 driver-agent 列表；当 base/head 在当前 runner + 指定平台上生成出的 revision 完全一致时输出空行。

说明：
  该脚本会分别在 base/head 对应源码上重算指定平台的 driver-agent revision，
  并按实际 revision 差异判定哪些驱动必须重建。
EOF
}

join_drivers() {
  local IFS=,
  echo "$*"
}

public_driver_name() {
  case "$1" in
    diros) echo "doris" ;;
    *) echo "$1" ;;
  esac
}

normalize_driver_name() {
  local value
  value="$(printf '%s' "${1:-}" | tr '[:upper:]' '[:lower:]' | tr -d '[:space:]')"
  case "$value" in
    doris|diros) echo "diros" ;;
    mariadb|oceanbase|starrocks|sphinx|sqlserver|sqlite|duckdb|dameng|kingbase|highgo|vastbase|opengauss|gaussdb|iris|cache|mongodb|tdengine|iotdb|clickhouse|elasticsearch|trino)
      echo "$value"
      ;;
    *)
      return 1
      ;;
  esac
}

extract_revision() {
  local file="$1"
  local driver="$2"
  awk -v target="$driver" '
    $0 ~ "\"" target "\"" {
      if (match($0, /"src-[^"]+"/)) {
        print substr($0, RSTART + 1, RLENGTH - 2)
        exit
      }
    }
  ' "$file"
}

base_ref=""
head_ref=""
target_platform=""
driver_csv=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --base)
      base_ref="${2:-}"
      shift 2
      ;;
    --head)
      head_ref="${2:-}"
      shift 2
      ;;
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
      usage >&2
      exit 1
      ;;
  esac
done

if [[ -z "$base_ref" || -z "$head_ref" || -z "$target_platform" ]]; then
  usage >&2
  exit 1
fi
if [[ "$target_platform" != */* ]]; then
  echo "--platform 参数格式错误，应为 GOOS/GOARCH，例如 darwin/arm64" >&2
  exit 1
fi

if ! git rev-parse --verify "${base_ref}^{commit}" >/dev/null 2>&1; then
  echo "无法解析 base ref：$base_ref" >&2
  exit 1
fi
if ! git rev-parse --verify "${head_ref}^{commit}" >/dev/null 2>&1; then
  echo "无法解析 head ref：$head_ref" >&2
  exit 1
fi

base_commit="$(git rev-parse "${base_ref}^{commit}")"
head_commit="$(git rev-parse "${head_ref}^{commit}")"

if [[ "$base_commit" == "$head_commit" ]]; then
  echo ""
  exit 0
fi

declare -a drivers_to_compare=()
if [[ -n "$driver_csv" ]]; then
  seen="|"
  IFS=',' read -r -a raw_drivers <<< "$driver_csv"
  for raw_driver in "${raw_drivers[@]}"; do
    driver="$(normalize_driver_name "$raw_driver")" || continue
    if [[ "$seen" == *"|$driver|"* ]]; then
      continue
    fi
    drivers_to_compare+=("$driver")
    seen="${seen}${driver}|"
  done
else
  drivers_to_compare=("${DEFAULT_DRIVERS[@]}")
fi

if [[ ${#drivers_to_compare[@]} -eq 0 ]]; then
  echo ""
  exit 0
fi

base_worktree="$(mktemp -d "${TMPDIR:-/tmp}/gonavi-driver-rev-base.XXXXXX")"
head_worktree="$(mktemp -d "${TMPDIR:-/tmp}/gonavi-driver-rev-head.XXXXXX")"

cleanup() {
  git worktree remove --force "$base_worktree" >/dev/null 2>&1 || true
  git worktree remove --force "$head_worktree" >/dev/null 2>&1 || true
  rm -rf "$base_worktree" "$head_worktree"
}
trap cleanup EXIT

git worktree add --detach "$base_worktree" "$base_commit" >/dev/null
git worktree add --detach "$head_worktree" "$head_commit" >/dev/null

generate_revisions() {
  local worktree="$1"
  (
    cd "$worktree"
    if [[ -n "$driver_csv" ]]; then
      bash ./tools/generate-driver-agent-revisions.sh --platform "$target_platform" --drivers "$driver_csv" >/dev/null
    else
      bash ./tools/generate-driver-agent-revisions.sh --platform "$target_platform" >/dev/null
    fi
  )
}

generate_revisions "$base_worktree" &
base_pid=$!
generate_revisions "$head_worktree" &
head_pid=$!

wait "$base_pid"
wait "$head_pid"

base_file="$base_worktree/internal/db/driver_agent_revisions_gen.go"
head_file="$head_worktree/internal/db/driver_agent_revisions_gen.go"

declare -a changed_drivers=()
for driver in "${drivers_to_compare[@]}"; do
  base_revision="$(extract_revision "$base_file" "$driver")"
  head_revision="$(extract_revision "$head_file" "$driver")"
  if [[ "$base_revision" != "$head_revision" ]]; then
    changed_drivers+=("$(public_driver_name "$driver")")
  fi
done

if [[ ${#changed_drivers[@]} -eq 0 ]]; then
  echo ""
else
  join_drivers "${changed_drivers[@]}"
fi
