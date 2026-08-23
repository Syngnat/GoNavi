#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$SCRIPT_DIR"

tmpdir="$(mktemp -d "${TMPDIR:-/tmp}/gonavi-driver-revision-contract.XXXXXX")"
cleanup() {
  rm -rf "$tmpdir"
}
trap cleanup EXIT

revision_file="$tmpdir/driver_agent_revisions_gen.go"
printf '%s\n' '// generated revision fixture' > "$revision_file"

platforms=(
  darwin/amd64
  darwin/arm64
  linux/amd64
  linux/arm64
  windows/amd64
  windows/arm64
)

for platform in "${platforms[@]}"; do
  bash ./tools/write-driver-revision-contract.sh \
    --role gui \
    --platform "$platform" \
    --output-dir "$tmpdir/contracts" \
    --revision-file "$revision_file"
  bash ./tools/write-driver-revision-contract.sh \
    --role cli \
    --platform "$platform" \
    --output-dir "$tmpdir/contracts" \
    --revision-file "$revision_file"
done

bash ./tools/write-driver-revision-contract.sh \
  --role gui \
  --platform linux/amd64 \
  --variant webkit41 \
  --output-dir "$tmpdir/contracts" \
  --revision-file "$revision_file"

bash ./tools/verify-driver-revision-contract.sh --contracts-dir "$tmpdir/contracts" >/dev/null

printf '%s\n' '// changed GUI revision fixture' > "$revision_file"
bash ./tools/write-driver-revision-contract.sh \
  --role gui \
  --platform darwin/arm64 \
  --output-dir "$tmpdir/contracts" \
  --revision-file "$revision_file"
if bash ./tools/verify-driver-revision-contract.sh --contracts-dir "$tmpdir/contracts" >"$tmpdir/mismatch.stdout" 2>"$tmpdir/mismatch.stderr"; then
  echo "expected a mismatched GUI/CLI contract to fail" >&2
  exit 1
fi
grep -Fq 'driver revision contract mismatch for darwin-arm64' "$tmpdir/mismatch.stderr"

printf '%s\n' '// generated revision fixture' > "$revision_file"
bash ./tools/write-driver-revision-contract.sh \
  --role gui \
  --platform darwin/arm64 \
  --output-dir "$tmpdir/contracts" \
  --revision-file "$revision_file"

printf '%s\n' '// changed WebKit41 GUI revision fixture' > "$revision_file"
bash ./tools/write-driver-revision-contract.sh \
  --role gui \
  --platform linux/amd64 \
  --variant webkit41 \
  --output-dir "$tmpdir/contracts" \
  --revision-file "$revision_file"
if bash ./tools/verify-driver-revision-contract.sh --contracts-dir "$tmpdir/contracts" >"$tmpdir/variant-mismatch.stdout" 2>"$tmpdir/variant-mismatch.stderr"; then
  echo "expected a mismatched WebKit41 GUI/CLI contract to fail" >&2
  exit 1
fi
grep -Fq 'driver revision contract mismatch for linux-amd64-webkit41' "$tmpdir/variant-mismatch.stderr"

printf '%s\n' '// generated revision fixture' > "$revision_file"
bash ./tools/write-driver-revision-contract.sh \
  --role gui \
  --platform linux/amd64 \
  --variant webkit41 \
  --output-dir "$tmpdir/contracts" \
  --revision-file "$revision_file"

rm -f "$tmpdir/contracts/cli-linux-arm64.sha256"
if bash ./tools/verify-driver-revision-contract.sh --contracts-dir "$tmpdir/contracts" >"$tmpdir/missing.stdout" 2>"$tmpdir/missing.stderr"; then
  echo "expected a missing GUI/CLI contract to fail" >&2
  exit 1
fi
grep -Fq 'missing driver revision contract' "$tmpdir/missing.stderr"

for workflow in .github/workflows/release.yml .github/workflows/dev-build.yml; do
  grep -Fq 'driver_revision_maps:' "$workflow"
  grep -Fq 'name: Generate canonical driver revision map' "$workflow"
  grep -Fq 'Generate canonical driver revision map' "$workflow"
  grep -Fq 'Upload canonical driver revision map' "$workflow"
  grep -Fq 'artifact_key: darwin-amd64' "$workflow"
  grep -Fq 'artifact_key: darwin-arm64' "$workflow"
  grep -Fq 'artifact_key: linux-amd64' "$workflow"
  grep -Fq 'artifact_key: linux-arm64' "$workflow"
  grep -Fq 'artifact_key: windows-amd64' "$workflow"
  grep -Fq 'artifact_key: windows-arm64' "$workflow"
  grep -Fq 'Download canonical driver revision map' "$workflow"
  grep -Fq 'Install canonical driver revision map' "$workflow"
  grep -Fq 'canonical_revision_map: linux-amd64' "$workflow"
  grep -Fq 'canonical_revision_map: windows-amd64' "$workflow"
  grep -Fq 'tools/write-driver-revision-contract.sh --role cli' "$workflow"
  grep -Fq 'revision_contract_args=(' "$workflow"
  grep -Fq -- '--role gui' "$workflow"
  grep -Fq 'revision_contract_args+=(--variant "${{ matrix.driver_revision_variant }}")' "$workflow"
  grep -Fq './tools/write-driver-revision-contract.sh "${revision_contract_args[@]}"' "$workflow"
  grep -Fq 'driver_revision_variant: "webkit41"' "$workflow"
  grep -Fq 'tools/verify-driver-revision-contract.sh --contracts-dir driver-revision-contract' "$workflow"
  if grep -Fq "if: \${{ matrix.wails_tags == '' }}" "$workflow"; then
    echo "WebKit41 GUI revision contract must not be excluded: $workflow" >&2
    exit 1
  fi
done

grep -Fq 'name: gui-driver-revision-contract-${{ matrix.build_name }}' .github/workflows/release.yml
grep -Fq 'name: dev-gui-driver-revision-contract-${{ matrix.build_name }}' .github/workflows/dev-build.yml

echo "driver revision contract test passed"
