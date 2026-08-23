#!/usr/bin/env bash

set -euo pipefail

usage() {
  cat <<'EOF'
Usage:
  ./tools/verify-driver-revision-contract.sh --contracts-dir <directory>

Requires the GUI and standalone CLI builds for every release target, including
the Linux WebKit41 GUI variant, to have used an identical generated
driver-agent revision map.
EOF
}

contracts_dir=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --contracts-dir)
      contracts_dir="${2:-}"
      shift 2
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "Unknown argument: $1" >&2
      usage >&2
      exit 1
      ;;
  esac
done

if [[ -z "$contracts_dir" || ! -d "$contracts_dir" ]]; then
  echo "--contracts-dir must name an existing directory" >&2
  exit 1
fi

read_contract_hash() {
  local path="$1"
  local line_count value

  if [[ ! -s "$path" ]]; then
    echo "missing driver revision contract: $path" >&2
    return 1
  fi
  line_count="$(wc -l < "$path" | tr -d '[:space:]')"
  value="$(sed -n '1p' "$path")"
  if [[ "$line_count" != "1" || ! "$value" =~ ^[0-9a-f]{64}$ ]]; then
    echo "invalid driver revision contract: $path" >&2
    return 1
  fi
  printf '%s\n' "$value"
}

contract_pairs=(
  "darwin-amd64:darwin-amd64"
  "darwin-arm64:darwin-arm64"
  "linux-amd64:linux-amd64"
  "linux-amd64-webkit41:linux-amd64"
  "linux-arm64:linux-arm64"
  "windows-amd64:windows-amd64"
  "windows-arm64:windows-arm64"
)

for pair in "${contract_pairs[@]}"; do
  gui_platform="${pair%%:*}"
  cli_platform="${pair##*:}"
  cli_contract="$contracts_dir/cli-${cli_platform}.sha256"
  gui_contract="$contracts_dir/gui-${gui_platform}.sha256"
  cli_hash="$(read_contract_hash "$cli_contract")"
  gui_hash="$(read_contract_hash "$gui_contract")"

  if [[ "$cli_hash" != "$gui_hash" ]]; then
    echo "driver revision contract mismatch for ${gui_platform}: gui=${gui_hash} cli=${cli_hash}" >&2
    exit 1
  fi
  echo "driver revision contract verified: ${gui_platform} against cli-${cli_platform} ${cli_hash}"
done
