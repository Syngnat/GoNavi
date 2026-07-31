#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$SCRIPT_DIR"
SCRIPT_DIR_WINDOWS="$(pwd -W 2>/dev/null || true)"
SCRIPT_DIR_WINDOWS="${SCRIPT_DIR_WINDOWS//\\//}"

DEFAULT_DRIVERS=(mariadb oceanbase doris starrocks sphinx sqlserver sqlite duckdb dameng kingbase highgo vastbase opengauss gaussdb iris mongodb tdengine iotdb clickhouse elasticsearch trino)
TARGET_PLATFORMS=(darwin/amd64 darwin/arm64 windows/amd64 windows/arm64 linux/amd64 linux/arm64)

usage() {
  cat <<'EOF'
用法：
  ./tools/detect-changed-driver-agents.sh --base <ref> [--head <ref>]

输出：
  逗号分隔的 driver-agent 列表；没有 driver-agent 相关变更时输出空行。

说明：
  通过 go list -deps 计算每个 driver-agent 的真实源码依赖，再与 git diff 文件求交集。
  如果无法解析基准或依赖分析失败，会保守输出全部 driver。
  如果 driver 构建 / 发布工作流本身发生变化，也会保守输出全部 driver，
  避免新应用 revision 与旧 driver-assets 再次错配。
EOF
}

join_drivers() {
  local IFS=,
  echo "$*"
}

all_drivers_csv() {
  join_drivers "${DEFAULT_DRIVERS[@]}"
}

is_dependency_source_file() {
  case "$1" in
    *.go|*.c|*.cc|*.cpp|*.cxx|*.h|*.hpp|*.m|*.mm|*.s|*.S|*.syso)
      return 0
      ;;
    *)
      return 1
      ;;
  esac
}

normalize_driver() {
  local value
  value="$(printf '%s' "${1:-}" | tr '[:upper:]' '[:lower:]' | tr -d '[:space:]')"
  case "$value" in
    doris|diros) echo "doris" ;;
    open_gauss|open-gauss) echo "opengauss" ;;
    gaussdb|gauss_db|gauss-db) echo "gaussdb" ;;
    elastic|elasticsearch) echo "elasticsearch" ;;
    mariadb|oceanbase|starrocks|sphinx|sqlserver|sqlite|duckdb|dameng|kingbase|highgo|vastbase|opengauss|gaussdb|iris|mongodb|tdengine|iotdb|clickhouse|trino)
      echo "$value"
      ;;
    *)
      return 1
      ;;
  esac
}

build_driver_name() {
  case "$1" in
    doris) echo "diros" ;;
    *) echo "$1" ;;
  esac
}

driver_build_tags() {
  local driver="$1"
  local platform="$2"
  local goos="${platform%%/*}"
  local goarch="${platform##*/}"
  local build_driver tag
  build_driver="$(build_driver_name "$driver")"
  tag="gonavi_${build_driver}_driver"
  if [[ "$driver" == "duckdb" && "$goos" == "windows" && "$goarch" == "amd64" ]]; then
    tag="$tag duckdb_use_lib"
  fi
  echo "$tag"
}

all_driver_build_tags() {
  local platform="$1"
  local -a tags=()
  local driver
  for driver in "${DEFAULT_DRIVERS[@]}"; do
    tags+=("$(driver_build_tags "$driver" "$platform")")
  done
  local IFS=" "
  echo "${tags[*]}"
}

driver_cgo_enabled() {
  # Detection only needs the Go dependency graph; keeping CGO off avoids
  # cross-platform cgo toolchain requirements in the Ubuntu detection job.
  echo 0
}

relative_repo_path() {
  local path="$1"
  path="${path//\\//}"
  case "$path" in
    "$SCRIPT_DIR"/*)
      path="${path#$SCRIPT_DIR/}"
      ;;
  esac
  if [[ -n "$SCRIPT_DIR_WINDOWS" ]]; then
    case "$path" in
      "$SCRIPT_DIR_WINDOWS"/*)
        path="${path#$SCRIPT_DIR_WINDOWS/}"
        ;;
    esac
  fi
  path="${path#./}"
  printf '%s\n' "$path"
}

add_analysis_platform() {
  local platform="$1"
  if [[ "$analysis_platform_seen" == *"|$platform|"* ]]; then
    return 0
  fi
  analysis_platforms+=("$platform")
  analysis_platform_seen="${analysis_platform_seen}${platform}|"
}

add_forced_driver() {
  local driver
  driver="$(normalize_driver "$1")" || return 0
  if [[ "$forced_driver_seen" == *"|$driver|"* ]]; then
    return 0
  fi
  forced_changed_drivers+=("$driver")
  forced_driver_seen="${forced_driver_seen}${driver}|"
}

driver_tokens_from_text() {
  local text
  local emitted_seen
  text="${1,,}"
  emitted_seen="|"

  case "$text" in *mariadb*) emit_driver_token mariadb ;; esac
  case "$text" in *oceanbase*) emit_driver_token oceanbase ;; esac
  case "$text" in *doris*|*diros*) emit_driver_token doris ;; esac
  case "$text" in *starrocks*) emit_driver_token starrocks ;; esac
  case "$text" in *sphinx*) emit_driver_token sphinx ;; esac
  case "$text" in *sqlserver*) emit_driver_token sqlserver ;; esac
  case "$text" in *sqlite*) emit_driver_token sqlite ;; esac
  case "$text" in *duckdb*) emit_driver_token duckdb ;; esac
  case "$text" in *dameng*) emit_driver_token dameng ;; esac
  case "$text" in *kingbase*) emit_driver_token kingbase ;; esac
  case "$text" in *highgo*) emit_driver_token highgo ;; esac
  case "$text" in *vastbase*) emit_driver_token vastbase ;; esac
  case "$text" in *opengauss*) emit_driver_token opengauss ;; esac
  case "$text" in *gaussdb*|*gauss_db*|*gauss-db*) emit_driver_token gaussdb ;; esac
  case "$text" in *iris*) emit_driver_token iris ;; esac
  case "$text" in *mongodb*) emit_driver_token mongodb ;; esac
  case "$text" in *tdengine*) emit_driver_token tdengine ;; esac
  case "$text" in *iotdb*|*apache-iotdb*|*apache_iotdb*) emit_driver_token iotdb ;; esac
  case "$text" in *clickhouse*) emit_driver_token clickhouse ;; esac
  case "$text" in *elasticsearch*) emit_driver_token elasticsearch ;; esac
  case "$text" in *trino*) emit_driver_token trino ;; esac

  case "$text" in
    *github.com/go-sql-driver/mysql*)
      emit_driver_token mariadb
      emit_driver_token oceanbase
      emit_driver_token doris
      emit_driver_token starrocks
      emit_driver_token sphinx
      ;;
  esac
  case "$text" in *github.com/microsoft/go-mssqldb*) emit_driver_token sqlserver ;; esac
  case "$text" in *modernc.org/sqlite*) emit_driver_token sqlite ;; esac
  case "$text" in *github.com/duckdb/duckdb-go/v2*|*github.com/duckdb/duckdb-go-bindings*) emit_driver_token duckdb ;; esac
  case "$text" in *gitee.com/chunanyong/dm*) emit_driver_token dameng ;; esac
  case "$text" in *gitea.com/kingbase/gokb*) emit_driver_token kingbase ;; esac
  case "$text" in *github.com/highgo/pq-sm3*|*third_party/highgo-pq*) emit_driver_token highgo ;; esac
  case "$text" in
    *github.com/lib/pq*)
      emit_driver_token vastbase
      emit_driver_token opengauss
      ;;
  esac
  case "$text" in *github.com/!huawei!cloud!developer/gaussdb-go*|*github.com/HuaweiCloudDeveloper/gaussdb-go*) emit_driver_token gaussdb ;; esac
  case "$text" in *github.com/caretdev/go-irisnative*|*third_party/go-irisnative*) emit_driver_token iris ;; esac
  case "$text" in *go.mongodb.org/mongo-driver*|*go.mongodb.org/mongo-driver/v2*) emit_driver_token mongodb ;; esac
  case "$text" in *github.com/taosdata/driver-go/v3*) emit_driver_token tdengine ;; esac
  case "$text" in *github.com/apache/iotdb-client-go*) emit_driver_token iotdb ;; esac
  case "$text" in *github.com/clickhouse/clickhouse-go/v2*|*github.com/clickhouse/ch-go*) emit_driver_token clickhouse ;; esac
  case "$text" in *github.com/elastic/go-elasticsearch/v8*) emit_driver_token elasticsearch ;; esac
  case "$text" in *github.com/trinodb/trino-go-client*) emit_driver_token trino ;; esac
}

emit_driver_token() {
  local driver
  driver="$(normalize_driver "$1")" || return 0
  if [[ "$emitted_seen" == *"|$driver|"* ]]; then
    return 0
  fi
  printf '%s\n' "$driver"
  emitted_seen="${emitted_seen}${driver}|"
}

shared_file_driver_delta() {
  local file="$1"
  local line text tokens token added_seen removed_seen
  local touched_seen emitted_seen
  local saw_unattributed_change=false
  added_seen="|"
  removed_seen="|"
  touched_seen="|"

  while IFS= read -r line; do
    case "$line" in
      +++*|---*|@@*)
        continue
        ;;
      +*|-*)
        text="${line:1}"
        case "$text" in
          *[![:space:]]*) ;;
          *) continue ;;
        esac
        tokens="$(driver_tokens_from_text "$text")"
        if [[ -z "$tokens" ]]; then
          saw_unattributed_change=true
          continue
        fi
        while IFS= read -r token; do
          [[ -n "$token" ]] || continue
          touched_seen="${touched_seen}${token}|"
          case "$line" in
            +*) added_seen="${added_seen}${token}|" ;;
            -*) removed_seen="${removed_seen}${token}|" ;;
          esac
        done <<<"$tokens"
        ;;
    esac
  done < <(git diff --unified=0 "$base_commit" "$head_commit" -- "$file")

  if [[ "$saw_unattributed_change" == "true" ]]; then
    return 1
  fi

  if [[ "$file" == "go.mod" || "$file" == "go.sum" ]]; then
    emitted_seen="|"
    for driver in "${DEFAULT_DRIVERS[@]}"; do
      if [[ "$touched_seen" == *"|$driver|"* && "$emitted_seen" != *"|$driver|"* ]]; then
        printf '%s\n' "$driver"
        emitted_seen="${emitted_seen}${driver}|"
      fi
    done
    return 0
  fi

  emitted_seen="|"
  for driver in "${DEFAULT_DRIVERS[@]}"; do
    if [[ "$added_seen" == *"|$driver|"* && "$removed_seen" != *"|$driver|"* ]]; then
      printf '%s\n' "$driver"
      emitted_seen="${emitted_seen}${driver}|"
      continue
    fi
    if [[ "$removed_seen" == *"|$driver|"* && "$added_seen" != *"|$driver|"* ]]; then
      printf '%s\n' "$driver"
      emitted_seen="${emitted_seen}${driver}|"
    fi
  done
  if [[ "$emitted_seen" != "|" ]]; then
    return 0
  fi

  for driver in "${DEFAULT_DRIVERS[@]}"; do
    if [[ "$touched_seen" == *"|$driver|"* ]]; then
      printf '%s\n' "$driver"
    fi
  done
}

source_file_driver_tokens() {
  local file="$1"
  local line text tokens token touched_seen emitted_seen
  touched_seen="|"

  while IFS= read -r line; do
    case "$line" in
      +++*|---*|@@*)
        continue
        ;;
      +*|-*)
        text="${line:1}"
        tokens="$(driver_tokens_from_text "$text")"
        while IFS= read -r token; do
          [[ -n "$token" ]] || continue
          touched_seen="${touched_seen}${token}|"
        done <<<"$tokens"
        ;;
    esac
  done < <(git diff --unified=0 "$base_commit" "$head_commit" -- "$file")

  emitted_seen="|"
  for driver in "${DEFAULT_DRIVERS[@]}"; do
    if [[ "$touched_seen" == *"|$driver|"* && "$emitted_seen" != *"|$driver|"* ]]; then
      printf '%s\n' "$driver"
      emitted_seen="${emitted_seen}${driver}|"
    fi
  done
}

add_forced_drivers_from_tokens() {
  local tokens="$1"
  local driver
  while IFS= read -r driver; do
    [[ -n "$driver" ]] || continue
    add_forced_driver "$driver"
  done <<<"$tokens"
}

add_all_forced_drivers() {
  local driver
  for driver in "${DEFAULT_DRIVERS[@]}"; do
    add_forced_driver "$driver"
  done
}

revision_file_changed_drivers() {
  local line driver emitted_seen
  emitted_seen="|"
  while IFS= read -r line; do
    case "$line" in
      +++*|---*|@@*)
        continue
        ;;
      +*|-*)
        if [[ "$line" =~ \"([^\"]+)\"[[:space:]]*:[[:space:]]*\"src-[^\"]+\" ]]; then
          driver="$(normalize_driver "${BASH_REMATCH[1]}")" || continue
          if [[ "$emitted_seen" == *"|$driver|"* ]]; then
            continue
          fi
          printf '%s\n' "$driver"
          emitted_seen="${emitted_seen}${driver}|"
        fi
        ;;
    esac
  done < <(git diff --unified=0 "$base_commit" "$head_commit" -- internal/db/driver_agent_revisions_gen.go)
}

is_ignored_driver_agent_source_file() {
  case "$1" in
    *_test.go|frontend/*|internal/app/*|internal/appdata/*|internal/connection/*|internal/logger/*|internal/db/driver_agent_revisions_gen.go)
      return 0
      ;;
  esac
  return 1
}

attribute_source_file_change() {
  local file="$1"
  local tokens

  if is_ignored_driver_agent_source_file "$file"; then
    return 0
  fi

  tokens="$(driver_tokens_from_text "$file")"
  if [[ -n "$tokens" ]]; then
    add_forced_drivers_from_tokens "$tokens"
    return 0
  fi

  case "$file" in
    cmd/optional-driver-agent/*.go|internal/db/*.go)
      add_all_forced_drivers
      return 0
      ;;
  esac

  tokens="$(source_file_driver_tokens "$file")"
  if [[ -n "$tokens" ]]; then
    add_forced_drivers_from_tokens "$tokens"
    return 0
  fi

  return 1
}

list_dependency_files() {
  local tags="$1"
  local cgo_enabled="$2"
  local goos="$3"
  local goarch="$4"
  local output="$5"

  CGO_ENABLED="$cgo_enabled" GOOS="$goos" GOARCH="$goarch" GOTOOLCHAIN=auto \
    go list -deps \
      -tags "$tags" \
      -f '{{if not .Standard}}{{range .GoFiles}}{{$.Dir}}/{{.}}{{"\n"}}{{end}}{{range .CgoFiles}}{{$.Dir}}/{{.}}{{"\n"}}{{end}}{{range .CFiles}}{{$.Dir}}/{{.}}{{"\n"}}{{end}}{{range .CXXFiles}}{{$.Dir}}/{{.}}{{"\n"}}{{end}}{{range .MFiles}}{{$.Dir}}/{{.}}{{"\n"}}{{end}}{{range .HFiles}}{{$.Dir}}/{{.}}{{"\n"}}{{end}}{{range .SFiles}}{{$.Dir}}/{{.}}{{"\n"}}{{end}}{{range .SysoFiles}}{{$.Dir}}/{{.}}{{"\n"}}{{end}}{{end}}' \
      ./cmd/optional-driver-agent | sort -u >"$output"
}

dependency_union_contains_changed_files() {
  local platform goos goarch tags tmp file rel
  local matched_any=false
  for platform in "${TARGET_PLATFORMS[@]}"; do
    goos="${platform%%/*}"
    goarch="${platform##*/}"
    tags="$(all_driver_build_tags "$platform")"
    tmp="$(mktemp "${TMPDIR:-/tmp}/gonavi-driver-dep-union.XXXXXX")"

    if ! list_dependency_files "$tags" 0 "$goos" "$goarch" "$tmp"; then
      rm -f "$tmp"
      return 2
    fi

    while IFS= read -r file; do
      [[ -n "$file" ]] || continue
      rel="$(relative_repo_path "$file")"
      if [[ -n "${changed_file_set[$rel]:-}" ]]; then
        dependency_matched_platforms["$rel"]="${dependency_matched_platforms[$rel]:-}|$platform|"
        matched_any=true
      fi
    done <"$tmp"

    rm -f "$tmp"
  done
  if [[ "$matched_any" == "true" ]]; then
    return 0
  fi
  return 1
}

base_ref=""
head_ref="HEAD"

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

if [[ -z "$base_ref" ]]; then
  echo "缺少 --base 参数。" >&2
  usage >&2
  exit 1
fi

if [[ "$base_ref" == "all" ]]; then
  all_drivers_csv
  exit 0
fi

if ! git rev-parse --verify "${head_ref}^{commit}" >/dev/null 2>&1; then
  echo "无法解析 head ref：$head_ref" >&2
  exit 1
fi
head_commit="$(git rev-parse "${head_ref}^{commit}")"

if ! git rev-parse --verify "${base_ref}^{commit}" >/dev/null 2>&1; then
  echo "无法解析 base ref：$base_ref；保守构建全部 driver-agent。" >&2
  all_drivers_csv
  exit 0
fi
base_commit="$(git rev-parse "${base_ref}^{commit}")"

declare -A changed_file_set=()
while IFS= read -r -d '' file; do
  file="$(relative_repo_path "$file")"
  [[ -n "$file" ]] || continue
  changed_file_set["$file"]=1
done < <(git diff --name-only -z "$base_commit" "$head_commit")

if [[ ${#changed_file_set[@]} -eq 0 ]]; then
  echo ""
  exit 0
fi

has_revision_file_change=false
only_workflow_changes=true
for file in "${!changed_file_set[@]}"; do
  case "$file" in
    internal/db/driver_agent_revisions_gen.go)
      has_revision_file_change=true
      only_workflow_changes=false
      ;;
    .github/workflows/dev-build.yml|.github/workflows/release.yml)
      ;;
    *)
      only_workflow_changes=false
      ;;
  esac
done

declare -a forced_changed_drivers=()
forced_driver_seen="|"
for file in "${!changed_file_set[@]}"; do
  case "$file" in
    internal/db/driver_agent_revisions_gen.go)
      revision_delta="$(revision_file_changed_drivers)"
      if [[ -z "$revision_delta" ]]; then
        echo "检测到 driver-agent revision 文件存在无法归因的变更；保守构建全部 driver-agent：$file" >&2
        all_drivers_csv
        exit 0
      fi
      add_forced_drivers_from_tokens "$revision_delta"
      ;;
    go.mod|go.sum|build-driver-agents.sh|tools/generate-driver-agent-revisions.sh)
      set +e
      shared_delta="$(shared_file_driver_delta "$file")"
      shared_status=$?
      set -e
      if [[ "$shared_status" -ne 0 ]]; then
        echo "检测到共享 driver-agent 输入存在无法归因的变更；保守构建全部 driver-agent：$file" >&2
        all_drivers_csv
        exit 0
      fi
      add_forced_drivers_from_tokens "$shared_delta"
      ;;
    tools/compress-driver-artifact.sh)
      echo "检测到 driver-agent 构建/发布链路脚本变更；保守构建全部 driver-agent：$file" >&2
      all_drivers_csv
      exit 0
      ;;
    .github/workflows/dev-build.yml|.github/workflows/release.yml)
      if [[ "$has_revision_file_change" == "true" ]]; then
        continue
      fi
      if [[ "$only_workflow_changes" == "true" && -f internal/db/driver_agent_revisions_gen.go ]]; then
        continue
      fi
      echo "检测到 driver-agent 构建/发布工作流变更；保守构建全部 driver-agent：$file" >&2
      all_drivers_csv
      exit 0
      ;;
    tools/detect-changed-driver-agents.sh)
      echo "检测到 driver-agent 变更检测脚本更新；保守构建全部 driver-agent：$file" >&2
      all_drivers_csv
      exit 0
      ;;
  esac
done

for file in "${!changed_file_set[@]}"; do
  case "$file" in
    internal/db/duckdb_*.go)
      add_forced_driver duckdb
      ;;
  esac
done

has_unattributed_source_candidate=false
for file in "${!changed_file_set[@]}"; do
  if is_dependency_source_file "$file"; then
    if attribute_source_file_change "$file"; then
      continue
    fi
    has_unattributed_source_candidate=true
    break
  fi
done

if [[ "$has_unattributed_source_candidate" != "true" ]]; then
  join_drivers "${forced_changed_drivers[@]}"
  exit 0
fi

while IFS= read -r -d '' file; do
  file="$(relative_repo_path "$file")"
  if is_dependency_source_file "$file"; then
    if attribute_source_file_change "$file"; then
      continue
    fi
    echo "检测到源码依赖候选文件被删除；保守构建全部 driver-agent：$file" >&2
    all_drivers_csv
    exit 0
  fi
done < <(git diff --name-only --diff-filter=D -z "$base_commit" "$head_commit")

declare -A dependency_matched_platforms=()
set +e
dependency_union_contains_changed_files
dependency_union_status=$?
set -e
case "$dependency_union_status" in
  0)
    ;;
  1)
    if [[ ${#forced_changed_drivers[@]} -eq 0 ]]; then
      echo ""
      exit 0
    fi
    ;;
  *)
    echo "分析 driver-agent 依赖全集失败；保守构建全部 driver-agent。" >&2
    all_drivers_csv
    exit 0
    ;;
esac

declare -a analysis_platforms=()
analysis_platform_seen="|"
for file in "${!dependency_matched_platforms[@]}"; do
  matched_platforms="${dependency_matched_platforms[$file]}"
  if [[ "$matched_platforms" == *"|linux/amd64|"* || "$matched_platforms" == *"|linux/arm64|"* ]]; then
    add_analysis_platform "linux/amd64"
    add_analysis_platform "linux/arm64"
    continue
  fi
  for platform in "${TARGET_PLATFORMS[@]}"; do
    if [[ "$matched_platforms" == *"|$platform|"* ]]; then
      add_analysis_platform "$platform"
    fi
  done
done
if [[ ${#analysis_platforms[@]} -eq 0 ]]; then
  analysis_platforms=("${TARGET_PLATFORMS[@]}")
fi

declare -a changed_drivers=()
driver_seen="|"

add_driver() {
  local driver
  driver="$(normalize_driver "$1")" || return 0
  if [[ "$driver_seen" == *"|$driver|"* ]]; then
    return 0
  fi
  changed_drivers+=("$driver")
  driver_seen="${driver_seen}${driver}|"
}

for driver in "${forced_changed_drivers[@]}"; do
  add_driver "$driver"
done

driver_depends_on_changed_files() {
  local driver="$1"
  local platform="$2"
  local goos="${platform%%/*}"
  local goarch="${platform##*/}"
  local tags cgo_enabled file rel tmp
  tags="$(driver_build_tags "$driver" "$platform")"
  cgo_enabled="$(driver_cgo_enabled "$driver")"
  tmp="$(mktemp "${TMPDIR:-/tmp}/gonavi-driver-deps.XXXXXX")"

  if ! list_dependency_files "$tags" "$cgo_enabled" "$goos" "$goarch" "$tmp"; then
    rm -f "$tmp"
    return 2
  fi

  while IFS= read -r file; do
    [[ -n "$file" ]] || continue
    rel="$(relative_repo_path "$file")"
    if [[ -n "${changed_file_set[$rel]:-}" ]]; then
      rm -f "$tmp"
      return 0
    fi
  done <"$tmp"

  rm -f "$tmp"
  return 1
}

for driver in "${DEFAULT_DRIVERS[@]}"; do
  driver_changed=false
  for platform in "${analysis_platforms[@]}"; do
    set +e
    driver_depends_on_changed_files "$driver" "$platform"
    status=$?
    set -e
    case "$status" in
      0)
        add_driver "$driver"
        driver_changed=true
        break
        ;;
      1)
        ;;
      *)
        echo "分析 $driver driver-agent 依赖失败；保守构建全部 driver-agent。" >&2
        all_drivers_csv
        exit 0
        ;;
    esac
  done
done

join_drivers "${changed_drivers[@]}"
