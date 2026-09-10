#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

DEFAULT_DRIVERS=(mariadb oceanbase doris starrocks sphinx sqlserver sqlite duckdb dameng kingbase highgo vastbase opengauss gaussdb iris cache mongodb tdengine iotdb clickhouse elasticsearch trino)
DEFAULT_PLATFORMS=(darwin/amd64 darwin/arm64 windows/amd64 windows/arm64 linux/amd64 linux/arm64)
DUCKDB_WINDOWS_LIBRARY_VERSION="v1.4.4"
DUCKDB_WINDOWS_LIBRARY_URL="https://github.com/duckdb/duckdb/releases/download/${DUCKDB_WINDOWS_LIBRARY_VERSION}/libduckdb-windows-amd64.zip"
DUCKDB_WINDOWS_SUPPORT_DLL="duckdb.dll"

usage() {
  cat <<'EOF'
用法：
  ./build-driver-agents.sh [选项]

选项：
  --drivers <列表>      指定驱动列表（逗号分隔），例如：kingbase,mongodb
  --platform <目标>      目标平台：current、all、GOOS/GOARCH，或逗号分隔列表
                        默认 current（当前 Go 环境）
  --out-dir <目录>      输出目录根路径，默认：dist/driver-agents
  --bundle-name <文件名> 驱动总包 zip 名称，默认：GoNavi-DriverAgents.zip
  --strict              任一驱动构建失败即中断（默认失败后继续，最后汇总）
  --upx                 要求使用 UPX 压缩支持的平台产物（默认 auto：有 upx 则压缩）
  --no-upx              禁用 UPX 压缩
  -h, --help            显示帮助

示例：
  ./build-driver-agents.sh
  ./build-driver-agents.sh --drivers kingbase
  ./build-driver-agents.sh --platform windows/amd64 --drivers kingbase,mongodb
  ./build-driver-agents.sh --platform all
  ./build-driver-agents.sh --platform darwin/arm64,windows/amd64,linux/amd64
EOF
}

normalize_driver() {
  local name
  name="$(echo "${1:-}" | tr '[:upper:]' '[:lower:]' | xargs)"
  case "$name" in
    doris|diros) echo "doris" ;;
    open_gauss|open-gauss) echo "opengauss" ;;
    gaussdb|gauss_db|gauss-db) echo "gaussdb" ;;
    elasticsearch|elastic) echo "elasticsearch" ;;
    mariadb|oceanbase|starrocks|sphinx|sqlserver|sqlite|duckdb|dameng|kingbase|highgo|vastbase|opengauss|gaussdb|iris|cache|mongodb|tdengine|iotdb|clickhouse|trino)
      echo "$name"
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

platform_dir_name() {
  case "$1" in
    windows) echo "Windows" ;;
    darwin) echo "MacOS" ;;
    linux) echo "Linux" ;;
    *) echo "Unknown" ;;
  esac
}

current_platform() {
  echo "$(go env GOOS)/$(go env GOARCH)"
}

append_platform() {
  local candidate
  candidate="$1"
  if [[ "$platform_seen" == *"|$candidate|"* ]]; then
    return 0
  fi
  platforms+=("$candidate")
  platform_seen="${platform_seen}${candidate}|"
}

normalize_platform() {
  local value goos goarch platform_dir
  value="$(printf '%s' "${1:-}" | tr '[:upper:]' '[:lower:]' | tr -d '[:space:]')"
  case "$value" in
    current|"")
      current_platform
      ;;
    */*)
      goos="${value%%/*}"
      goarch="${value##*/}"
      platform_dir="$(platform_dir_name "$goos")"
      if [[ -z "$goos" || -z "$goarch" || "$platform_dir" == "Unknown" ]]; then
        return 1
      fi
      echo "$goos/$goarch"
      ;;
    *)
      return 1
      ;;
  esac
}

zip_bundle() {
  local bundle_zip_path="$1"
  local bundle_stage_dir="$2"
  local -a bundle_dirs=()
  local dir

  for dir in "$bundle_stage_dir"/*; do
    [[ -d "$dir" ]] || continue
    bundle_dirs+=("$(basename "$dir")")
  done

  if [[ ${#bundle_dirs[@]} -eq 0 ]]; then
    echo "❌ 驱动总包 staging 目录为空。"
    exit 1
  fi

  rm -f "$bundle_zip_path"
  if command -v zip >/dev/null 2>&1; then
    (
      cd "$bundle_stage_dir"
      zip -qry "$bundle_zip_path" "${bundle_dirs[@]}"
    )
  elif command -v python3 >/dev/null 2>&1; then
    BUNDLE_STAGE_DIR="$bundle_stage_dir" BUNDLE_ZIP_PATH="$bundle_zip_path" python3 - <<'PY'
import os
import zipfile
from pathlib import Path

stage = Path(os.environ["BUNDLE_STAGE_DIR"])
target = Path(os.environ["BUNDLE_ZIP_PATH"])
with zipfile.ZipFile(target, "w", compression=zipfile.ZIP_DEFLATED) as zf:
    for path in stage.rglob("*"):
        if path.is_file():
            zf.write(path, path.relative_to(stage).as_posix())
PY
  else
    echo "❌ 未找到 zip 或 python3，无法生成驱动总包 zip。"
    exit 1
  fi
}

zip_duckdb_windows_package() {
  local bundle_stage_dir="$1"
  local zip_path="$2"

  rm -f "$zip_path"
  if command -v python3 >/dev/null 2>&1; then
    BUNDLE_STAGE_DIR="$bundle_stage_dir" BUNDLE_ZIP_PATH="$zip_path" python3 - <<'PY'
import os
import zipfile

stage_dir = os.environ["BUNDLE_STAGE_DIR"]
zip_path = os.environ["BUNDLE_ZIP_PATH"]
entries = [
    ("Windows/duckdb-driver-agent-windows-amd64.exe", os.path.join(stage_dir, "Windows", "duckdb-driver-agent-windows-amd64.exe")),
    ("Windows/duckdb.dll", os.path.join(stage_dir, "Windows", "duckdb.dll")),
]

with zipfile.ZipFile(zip_path, "w", compression=zipfile.ZIP_DEFLATED) as zf:
    for arcname, src in entries:
        if not os.path.isfile(src):
            raise FileNotFoundError(src)
        zf.write(src, arcname)
PY
  elif command -v zip >/dev/null 2>&1; then
    (
      cd "$bundle_stage_dir"
      zip -qry "$zip_path" "Windows/duckdb-driver-agent-windows-amd64.exe" "Windows/duckdb.dll"
    )
  else
    echo "❌ 未找到 python3 或 zip，无法生成 DuckDB Windows 专属驱动包。"
    exit 1
  fi
}

prepare_duckdb_windows_library() {
  local cache_root="$1"
  local lib_dir="$cache_root/duckdb-windows-${DUCKDB_WINDOWS_LIBRARY_VERSION}"
  local zip_path="$cache_root/libduckdb-windows-amd64.zip"

  if [[ -f "$lib_dir/duckdb.dll" && -f "$lib_dir/duckdb.lib" ]]; then
    printf '%s\n' "$lib_dir"
    return 0
  fi

  mkdir -p "$lib_dir"
  echo "⬇️  下载 DuckDB Windows 官方动态库：$DUCKDB_WINDOWS_LIBRARY_URL" >&2
  if command -v curl >/dev/null 2>&1; then
    curl -fsSL "$DUCKDB_WINDOWS_LIBRARY_URL" -o "$zip_path"
  elif command -v wget >/dev/null 2>&1; then
    wget -q "$DUCKDB_WINDOWS_LIBRARY_URL" -O "$zip_path"
  else
    echo "❌ 未找到 curl 或 wget，无法下载 DuckDB Windows 动态库。" >&2
    return 1
  fi

  if command -v unzip >/dev/null 2>&1; then
    unzip -qo "$zip_path" -d "$lib_dir"
  elif command -v python3 >/dev/null 2>&1; then
    DUCKDB_LIB_ZIP="$zip_path" DUCKDB_LIB_DIR="$lib_dir" python3 - <<'PY'
import os
import zipfile

zip_path = os.environ["DUCKDB_LIB_ZIP"]
target = os.environ["DUCKDB_LIB_DIR"]
with zipfile.ZipFile(zip_path) as zf:
    zf.extractall(target)
PY
  else
    echo "❌ 未找到 unzip 或 python3，无法解压 DuckDB Windows 动态库。" >&2
    return 1
  fi

  if [[ ! -f "$lib_dir/duckdb.dll" || ! -f "$lib_dir/duckdb.lib" ]]; then
    echo "❌ DuckDB Windows 动态库包缺少 duckdb.dll 或 duckdb.lib。" >&2
    return 1
  fi

  cp "$lib_dir/duckdb.lib" "$lib_dir/libduckdb.dll.a"
  cp "$lib_dir/duckdb.lib" "$lib_dir/libduckdb.a"
  printf '%s\n' "$lib_dir"
}

join_by_comma() {
  local IFS=,
  echo "$*"
}

driver_csv=""
target_platform=""
out_root="dist/driver-agents"
bundle_name="GoNavi-DriverAgents.zip"
duckdb_windows_zip_name="duckdb-driver.zip"
strict_mode="false"
upx_mode="${GONAVI_DRIVER_AGENT_UPX:-auto}"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --drivers)
      driver_csv="${2:-}"
      shift 2
      ;;
    --platform)
      target_platform="${2:-}"
      shift 2
      ;;
    --out-dir)
      out_root="${2:-}"
      shift 2
      ;;
    --bundle-name)
      bundle_name="${2:-}"
      shift 2
      ;;
    --strict)
      strict_mode="true"
      shift
      ;;
    --upx)
      upx_mode="required"
      shift
      ;;
    --no-upx)
      upx_mode="off"
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "❌ 未知参数：$1"
      usage
      exit 1
      ;;
  esac
done

if ! command -v go >/dev/null 2>&1; then
  echo "❌ 未找到 Go，请先安装 Go 并确保 go 在 PATH 中。"
  exit 1
fi

declare -a drivers=()
if [[ -n "$driver_csv" ]]; then
  IFS=',' read -r -a raw_drivers <<<"$driver_csv"
  for item in "${raw_drivers[@]}"; do
    normalized="$(normalize_driver "$item")" || {
      echo "❌ 不支持的驱动：$item"
      exit 1
    }
    drivers+=("$normalized")
  done
else
  drivers=("${DEFAULT_DRIVERS[@]}")
fi
revision_driver_csv="$(join_by_comma "${drivers[@]}")"

declare -a platforms=()
platform_seen="|"
if [[ -z "$target_platform" ]]; then
  target_platform="current"
fi
IFS=',' read -r -a raw_platforms <<<"$target_platform"
for item in "${raw_platforms[@]}"; do
  normalized_platform="$(printf '%s' "$item" | tr '[:upper:]' '[:lower:]' | tr -d '[:space:]')"
  if [[ "$normalized_platform" == "all" ]]; then
    for default_platform in "${DEFAULT_PLATFORMS[@]}"; do
      append_platform "$default_platform"
    done
    continue
  fi
  normalized_platform="$(normalize_platform "$item")" || {
    echo "❌ --platform 参数格式错误，应为 current、all、GOOS/GOARCH 或逗号分隔列表，例如 darwin/arm64,windows/amd64"
    exit 1
  }
  append_platform "$normalized_platform"
done

if [[ ${#platforms[@]} -eq 0 ]]; then
  echo "❌ 未指定有效目标平台。"
  exit 1
fi

mkdir -p "$out_root"
out_root_abs="$(cd "$out_root" && pwd)"
bundle_stage_dir="$(mktemp -d "${TMPDIR:-/tmp}/gonavi-driver-bundle.XXXXXX")"

cleanup() {
  rm -rf "$bundle_stage_dir"
}
trap cleanup EXIT

if [[ ${#platforms[@]} -eq 1 ]]; then
  single_platform="${platforms[0]}"
  single_platform_key="${single_platform/\//-}"
  single_output_dir="${out_root%/}/$single_platform_key"
  mkdir -p "$single_output_dir"
  bundle_zip_path="$(cd "$single_output_dir" && pwd)/$bundle_name"
else
  bundle_zip_path="$out_root_abs/$bundle_name"
fi

declare -a built_assets=()
declare -a failed_drivers=()
declare -a skipped_drivers=()

echo "🚀 开始构建 optional-driver-agent"
echo "   平台：${platforms[*]}"
echo "   输出根目录：$out_root_abs"
echo "   驱动列表：${drivers[*]}"

for platform in "${platforms[@]}"; do
  goos="${platform%%/*}"
  goarch="${platform##*/}"
  platform_key="${goos}-${goarch}"
  platform_dir="$(platform_dir_name "$goos")"
  output_dir="${out_root%/}/${platform_key}"
  bundle_platform_dir="$bundle_stage_dir/$platform_dir"

  mkdir -p "$output_dir" "$bundle_platform_dir"
  output_dir_abs="$(cd "$output_dir" && pwd)"

  echo ""
  echo "🧭 生成 driver-agent revision 指纹：$platform"
  "$SCRIPT_DIR/tools/generate-driver-agent-revisions.sh" --platform "$platform" --drivers "$revision_driver_csv"

  for driver in "${drivers[@]}"; do
    if [[ "$driver" == "duckdb" && "$goos" == "windows" && "$goarch" != "amd64" ]]; then
      echo "⚠️  跳过 duckdb（$platform 仅支持 windows/amd64）"
      skipped_drivers+=("duckdb($platform)")
      continue
    fi

    build_driver="$(build_driver_name "$driver")"
    tag="gonavi_${build_driver}_driver"
    build_tags="$tag"
    asset_name="${driver}-driver-agent-${goos}-${goarch}"
    if [[ "$goos" == "windows" ]]; then
      asset_name="${asset_name}.exe"
    fi
    output_path="$output_dir_abs/$asset_name"

    cgo_enabled=0
    if [[ "$driver" == "duckdb" ]]; then
      cgo_enabled=1
    fi
    duckdb_lib_dir=""
    if [[ "$driver" == "duckdb" && "$goos" == "windows" && "$goarch" == "amd64" ]]; then
      duckdb_lib_dir="$(prepare_duckdb_windows_library "$bundle_stage_dir")"
      build_tags="$build_tags duckdb_use_lib"
    fi

    echo "🔧 构建 $driver -> $asset_name (platform=$platform, tags=$build_tags, CGO_ENABLED=$cgo_enabled)"
    set +e
    if [[ -n "$duckdb_lib_dir" ]]; then
      CGO_ENABLED="$cgo_enabled" GOOS="$goos" GOARCH="$goarch" GOTOOLCHAIN=auto \
        CGO_LDFLAGS="-L${duckdb_lib_dir} -lduckdb" PATH="${duckdb_lib_dir}:$PATH" \
        go build -tags "$build_tags" -trimpath -ldflags "-s -w" -o "$output_path" ./cmd/optional-driver-agent
    else
      CGO_ENABLED="$cgo_enabled" GOOS="$goos" GOARCH="$goarch" GOTOOLCHAIN=auto \
        go build -tags "$build_tags" -trimpath -ldflags "-s -w" -o "$output_path" ./cmd/optional-driver-agent
    fi
    build_exit=$?
    set -e

    if [[ $build_exit -ne 0 ]]; then
      echo "❌ 构建失败：$driver ($platform)"
      failed_drivers+=("$driver($platform)")
      if [[ "$strict_mode" == "true" ]]; then
        exit $build_exit
      fi
      continue
    fi

    GONAVI_DRIVER_AGENT_UPX="$upx_mode" "$SCRIPT_DIR/tools/compress-driver-artifact.sh" "$output_path" "$platform" "$platform_dir/$asset_name"
    cp "$output_path" "$bundle_platform_dir/$asset_name"
    if [[ -n "$duckdb_lib_dir" ]]; then
      cp "$duckdb_lib_dir/$DUCKDB_WINDOWS_SUPPORT_DLL" "$output_dir_abs/$DUCKDB_WINDOWS_SUPPORT_DLL"
      GONAVI_DRIVER_AGENT_UPX="$upx_mode" "$SCRIPT_DIR/tools/compress-driver-artifact.sh" "$output_dir_abs/$DUCKDB_WINDOWS_SUPPORT_DLL" "$platform" "$platform_dir/$DUCKDB_WINDOWS_SUPPORT_DLL"
      cp "$output_dir_abs/$DUCKDB_WINDOWS_SUPPORT_DLL" "$bundle_platform_dir/$DUCKDB_WINDOWS_SUPPORT_DLL"
      built_assets+=("$platform_dir/$DUCKDB_WINDOWS_SUPPORT_DLL")
    fi
    built_assets+=("$platform_dir/$asset_name")
  done
done

if [[ ${#built_assets[@]} -eq 0 ]]; then
  echo "❌ 未成功构建任何驱动代理。"
  exit 1
fi

zip_bundle "$bundle_zip_path" "$bundle_stage_dir"

duckdb_asset_path="$out_root_abs/windows-amd64/duckdb-driver-agent-windows-amd64.exe"
duckdb_dll_path="$out_root_abs/windows-amd64/$DUCKDB_WINDOWS_SUPPORT_DLL"
if [[ -f "$duckdb_asset_path" && -f "$duckdb_dll_path" ]]; then
  duckdb_zip_path="$out_root_abs/windows-amd64/$duckdb_windows_zip_name"
  zip_duckdb_windows_package "$bundle_stage_dir" "$duckdb_zip_path"
  built_assets+=("Windows/$duckdb_windows_zip_name")
fi

echo ""
echo "✅ 构建完成"
echo "   单文件输出根目录：$out_root_abs"
echo "   驱动总包：$bundle_zip_path"
echo "   已构建：${built_assets[*]}"
if [[ ${#skipped_drivers[@]} -gt 0 ]]; then
  echo "   已跳过：${skipped_drivers[*]}"
fi
if [[ ${#failed_drivers[@]} -gt 0 ]]; then
  echo "⚠️  构建失败驱动：${failed_drivers[*]}"
  exit 2
fi
