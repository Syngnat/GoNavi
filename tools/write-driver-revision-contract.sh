#!/usr/bin/env bash

set -euo pipefail

usage() {
  cat <<'EOF'
Usage:
  ./tools/write-driver-revision-contract.sh --role <gui|cli> --platform <GOOS/GOARCH> --output-dir <directory> [--variant <name>] [--revision-file <path>]

Writes the SHA-256 of the generated driver-agent revision map used by one
release build. The release aggregation job compares GUI and CLI contracts for
each target platform before publishing assets.
EOF
}

role=""
platform=""
output_dir=""
variant=""
revision_file="internal/db/driver_agent_revisions_gen.go"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --role)
      role="${2:-}"
      shift 2
      ;;
    --platform)
      platform="${2:-}"
      shift 2
      ;;
    --output-dir)
      output_dir="${2:-}"
      shift 2
      ;;
    --variant)
      variant="${2:-}"
      shift 2
      ;;
    --revision-file)
      revision_file="${2:-}"
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

if [[ "$role" != "gui" && "$role" != "cli" ]]; then
  echo "--role must be gui or cli" >&2
  exit 1
fi
if [[ ! "$platform" =~ ^(darwin|linux|windows)/(amd64|arm64)$ ]]; then
  echo "--platform must be one of darwin|linux|windows and amd64|arm64: $platform" >&2
  exit 1
fi
if [[ -z "$output_dir" ]]; then
  echo "--output-dir is required" >&2
  exit 1
fi
if [[ -n "$variant" && "$role" != "gui" ]]; then
  echo "--variant is only supported for gui contracts" >&2
  exit 1
fi
if [[ -n "$variant" && ! "$variant" =~ ^[a-z0-9][a-z0-9-]*$ ]]; then
  echo "--variant must use lowercase letters, digits, and hyphens: $variant" >&2
  exit 1
fi
if [[ ! -f "$revision_file" ]]; then
  echo "revision file does not exist: $revision_file" >&2
  exit 1
fi

if command -v sha256sum >/dev/null 2>&1; then
  revision_hash="$(sha256sum "$revision_file" | awk '{print $1}')"
elif command -v shasum >/dev/null 2>&1; then
  revision_hash="$(shasum -a 256 "$revision_file" | awk '{print $1}')"
else
  echo "sha256sum or shasum is required" >&2
  exit 1
fi

if [[ ! "$revision_hash" =~ ^[0-9a-f]{64}$ ]]; then
  echo "failed to calculate revision-map SHA-256" >&2
  exit 1
fi

platform_name="${platform//\//-}"
variant_suffix=""
if [[ -n "$variant" ]]; then
  variant_suffix="-$variant"
fi
mkdir -p "$output_dir"
printf '%s\n' "$revision_hash" > "$output_dir/${role}-${platform_name}${variant_suffix}.sha256"
