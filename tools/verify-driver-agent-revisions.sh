#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$SCRIPT_DIR"

usage() {
  cat <<'EOF'
用法：
  ./tools/verify-driver-agent-revisions.sh --assets-dir <目录> --platform <GOOS/GOARCH> --drivers <列表>

说明：
  校验已构建 driver-agent 资产返回的 agentRevision 是否等于当前源码生成的 revision。
EOF
}

assets_dir=""
target_platform=""
driver_csv=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --assets-dir)
      assets_dir="${2:-}"
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

if [[ -z "$assets_dir" || -z "$target_platform" || -z "$driver_csv" ]]; then
  usage >&2
  exit 1
fi
if [[ "$target_platform" != */* ]]; then
  echo "--platform 参数格式错误，应为 GOOS/GOARCH，例如 darwin/arm64" >&2
  exit 1
fi

goos="${target_platform%%/*}"
goarch="${target_platform##*/}"
platform_dir="Unknown"
case "$goos" in
  windows) platform_dir="Windows" ;;
  darwin) platform_dir="MacOS" ;;
  linux) platform_dir="Linux" ;;
esac

normalize_driver() {
  local value
  value="$(printf '%s' "$1" | tr '[:upper:]' '[:lower:]' | tr -d '[:space:]')"
  case "$value" in
    doris|diros) echo "diros" ;;
    opengauss|open_gauss|open-gauss) echo "opengauss" ;;
    gaussdb|gauss_db|gauss-db) echo "gaussdb" ;;
    elasticsearch|elastic) echo "elasticsearch" ;;
    mariadb|oceanbase|starrocks|sphinx|sqlserver|sqlite|duckdb|dameng|kingbase|highgo|vastbase|gaussdb|iris|cache|mongodb|tdengine|iotdb|clickhouse|trino)
      echo "$value"
      ;;
    *)
      return 1
      ;;
  esac
}

public_driver_name() {
  case "$1" in
    diros) echo "doris" ;;
    *) echo "$1" ;;
  esac
}

expected_revision_for() {
  local target="$1"
  awk -v target="$target" '
    $0 ~ "\"" target "\"" {
      if (match($0, /"src-[^"]+"/)) {
        value=substr($0, RSTART + 1, RLENGTH - 2)
        print value
        exit
      }
    }
  ' internal/db/driver_agent_revisions_gen.go
}

build_tags_for_driver() {
  local driver="$1"
  local variant="${2:-}"
  local tags="gonavi_${driver}_driver"
  if [[ "$driver" == "mongodb" && "$variant" == "v1" ]]; then
    tags="gonavi_mongodb_driver_v1"
  fi
  if [[ "$driver" == "duckdb" && "$host_goos" == "windows" && "$host_goarch" == "amd64" ]]; then
    tags="${tags} duckdb_use_lib"
  fi
  printf '%s\n' "$tags"
}

agent_path_for() {
  local driver="$1"
  local variant="${2:-}"
  local public_name asset
  public_name="$(public_driver_name "$driver")"
  if [[ "$driver" == "mongodb" && -n "$variant" ]]; then
    asset="${public_name}-driver-agent-${variant}-${goos}-${goarch}"
  else
    asset="${public_name}-driver-agent-${goos}-${goarch}"
  fi
  if [[ "$goos" == "windows" ]]; then
    asset="${asset}.exe"
  fi
  printf '%s\n' "${assets_dir%/}/${platform_dir}/${asset}"
}

agent_variants_for() {
  local driver="$1"
  if [[ "$driver" == "mongodb" ]]; then
    printf '%s\n' "v1" "v2" ""
    return
  fi
  printf '%s\n' ""
}

probe_agent_revision_once() {
  local agent_path="$1"
  local stdout_file stderr_file probe_exit revision
  local request
  request='{"id":1,"method":"metadata"}'
  stdout_file="$(mktemp "${TMPDIR:-/tmp}/gonavi-agent-revision-stdout.XXXXXX")"
  stderr_file="$(mktemp "${TMPDIR:-/tmp}/gonavi-agent-revision-stderr.XXXXXX")"

  set +e
  printf '%s\n' "$request" | "$agent_path" >"$stdout_file" 2>"$stderr_file"
  probe_exit=$?
  set -e

  if [[ "$probe_exit" -ne 0 ]]; then
    echo "   probe exit=$probe_exit asset=$agent_path" >&2
    [[ -s "$stderr_file" ]] && sed "s/^/   stderr: /" "$stderr_file" >&2
    [[ -s "$stdout_file" ]] && sed "s/^/   stdout: /" "$stdout_file" >&2
    rm -f "$stdout_file" "$stderr_file"
    return 1
  fi

  revision="$(
    python3 - "$stdout_file" <<'PY'
import json
import sys
from pathlib import Path

lines = [
    line.strip()
    for line in Path(sys.argv[1]).read_text(encoding="utf-8", errors="replace").splitlines()
    if line.strip()
]
if not lines:
    raise SystemExit(1)
try:
    payload = json.loads(lines[0])
except json.JSONDecodeError as exc:
    print(f"invalid metadata json: {exc}", file=sys.stderr)
    raise SystemExit(1)
if not payload.get("success"):
    print(f"metadata success=false error={payload.get('error')!r}", file=sys.stderr)
    raise SystemExit(1)
data = payload.get("data") or {}
revision = str(data.get("agentRevision") or "").strip()
if not revision:
    print(f"metadata missing agentRevision payload={payload!r}", file=sys.stderr)
    raise SystemExit(1)
print(revision)
PY
  )" || {
    probe_exit=$?
    echo "   failed to parse metadata from $agent_path" >&2
    [[ -s "$stderr_file" ]] && sed "s/^/   stderr: /" "$stderr_file" >&2
    [[ -s "$stdout_file" ]] && sed "s/^/   stdout: /" "$stdout_file" >&2
    rm -f "$stdout_file" "$stderr_file"
    return "$probe_exit"
  }

  rm -f "$stdout_file" "$stderr_file"
  printf '%s\n' "$revision"
  return 0
}

probe_agent_revision() {
  local agent_path="$1"
  local attempt revision unpacked_path

  for attempt in 1 2 3; do
    if revision="$(probe_agent_revision_once "$agent_path")"; then
      printf '%s\n' "$revision"
      return 0
    fi
    echo "   metadata probe attempt ${attempt}/3 failed for $agent_path" >&2
    sleep "$attempt"
  done

  # UPX-packed Go binaries can occasionally fail to exec under runner pressure.
  # Fall back to an unpacked copy so CI reports the real embedded revision.
  if command -v upx >/dev/null 2>&1 && upx -t "$agent_path" >/dev/null 2>&1; then
    unpacked_path="$(mktemp "${TMPDIR:-/tmp}/gonavi-agent-unpacked.XXXXXX")"
    if cp "$agent_path" "$unpacked_path" && upx -d "$unpacked_path" >/dev/null 2>&1; then
      chmod +x "$unpacked_path" 2>/dev/null || true
      if revision="$(probe_agent_revision_once "$unpacked_path")"; then
        rm -f "$unpacked_path"
        printf '%s\n' "$revision"
        return 0
      fi
    fi
    rm -f "$unpacked_path"
  fi

  return 1
}

probe_host_agent_revision() {
  local driver="$1"
  local variant="${2:-}"
  local build_tags probe_dir probe_path revision
  build_tags="$(build_tags_for_driver "$driver" "$variant")"
  probe_dir="$(mktemp -d)"
  probe_path="${probe_dir}/probe-agent"
  if [[ "$host_goos" == "windows" ]]; then
    probe_path="${probe_path}.exe"
  fi

  CGO_ENABLED=0 go build \
    -tags "${build_tags}" \
    -trimpath \
    -ldflags "-s -w" \
    -o "${probe_path}" \
    ./cmd/optional-driver-agent >/dev/null

  chmod +x "$probe_path" 2>/dev/null || true
  revision="$(probe_agent_revision "$probe_path")"
  rm -rf "$probe_dir"
  printf '%s\n' "$revision"
}

can_execute_target_binary() {
  [[ "$target_platform" == "$host_platform" ]]
}

validate_windows_pe_machine() {
  local agent_path="$1"
  local expected_goarch="$2"
  python3 - "$agent_path" "$expected_goarch" <<'PY'
import os
import struct
import sys

path = sys.argv[1]
goarch = sys.argv[2].strip().lower()
expected = {
    "386": 0x014C,
    "amd64": 0x8664,
    "arm64": 0xAA64,
}
labels = {
    0x014C: "windows-386",
    0x8664: "windows-amd64",
    0xAA64: "windows-arm64",
}

if goarch not in expected:
    sys.exit(0)

with open(path, "rb") as fh:
    fh.seek(0, os.SEEK_END)
    size = fh.tell()
    if size < 0x40:
        raise SystemExit("文件头不完整")

    fh.seek(0)
    if fh.read(2) != b"MZ":
        raise SystemExit("缺少 MZ 头")

    fh.seek(0x3C)
    pe_offset_raw = fh.read(4)
    if len(pe_offset_raw) != 4:
        raise SystemExit("读取 PE 头偏移失败")
    pe_offset = struct.unpack("<I", pe_offset_raw)[0]
    if pe_offset < 0x40 or pe_offset + 24 > size:
        raise SystemExit("PE 头不完整")

    fh.seek(pe_offset)
    if fh.read(4) != b"PE\0\0":
        raise SystemExit("缺少 PE 签名")

    machine_raw = fh.read(2)
    if len(machine_raw) != 2:
        raise SystemExit("读取 PE 架构失败")
    machine = struct.unpack("<H", machine_raw)[0]

expected_machine = expected[goarch]
if machine != expected_machine:
    raise SystemExit(f"可执行文件架构不兼容（文件={labels.get(machine, hex(machine))}，期望={labels[expected_machine]})")
PY
}

declare -a raw_drivers=()
IFS=',' read -r -a raw_drivers <<<"$driver_csv"

host_goos="$(go env GOOS)"
host_goarch="$(go env GOARCH)"
host_platform="${host_goos}/${host_goarch}"

failed=0
for raw_driver in "${raw_drivers[@]}"; do
  [[ -n "$raw_driver" ]] || continue
  driver="$(normalize_driver "$raw_driver")"
  if [[ "$driver" == "duckdb" && "$goos" == "windows" && "$goarch" != "amd64" ]]; then
    echo "⚠️  跳过 duckdb revision 校验（$target_platform 不构建 agent）"
    continue
  fi

  expected="$(expected_revision_for "$driver")"
  if [[ -z "$expected" ]]; then
    echo "❌ $driver 缺少期望 revision"
    failed=1
    continue
  fi

  while IFS= read -r variant; do
    agent_path="$(agent_path_for "$driver" "$variant")"
    variant_label="$driver"
    if [[ -n "$variant" ]]; then
      variant_label="${driver}-${variant}"
    fi
    if [[ ! -f "$agent_path" ]]; then
      echo "❌ $variant_label 缺少 driver-agent 资产：$agent_path"
      failed=1
      continue
    fi
    chmod +x "$agent_path" 2>/dev/null || true

    if [[ "$goos" == "windows" ]]; then
      if ! validate_windows_pe_machine "$agent_path" "$goarch"; then
        echo "❌ $variant_label Windows driver-agent 架构校验失败：asset=$agent_path target=$target_platform"
        failed=1
        continue
      fi
    fi

    actual=""
    if can_execute_target_binary; then
      # Always probe the packaged asset itself. Do not fall back to a host rebuild:
      # that would hide broken UPX/corrupt artifacts while still shipping them.
      actual="$(probe_agent_revision "$agent_path" || true)"
    else
      echo "ℹ️  runner 平台 ${host_platform} 无法直接执行目标二进制 ${target_platform}，已先完成目标资产架构校验，再用 host-native probe 校验相同 build tags 的 revision"
      actual="$(probe_host_agent_revision "$driver" "$variant" || true)"
    fi

    if [[ -z "$actual" ]]; then
      echo "❌ $variant_label driver-agent revision 为空：asset=$agent_path expected=$expected"
      if [[ -f "$agent_path" ]]; then
        ls -l "$agent_path" >&2 || true
        file "$agent_path" >&2 || true
      fi
      failed=1
      continue
    fi
    if [[ "$actual" != "$expected" ]]; then
      echo "❌ $variant_label driver-agent revision 不匹配：asset=$agent_path actual=$actual expected=$expected"
      failed=1
      continue
    fi
    echo "✅ $variant_label driver-agent revision 校验通过：$actual"
  done < <(agent_variants_for "$driver")
done

exit "$failed"
