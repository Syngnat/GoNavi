#!/usr/bin/env bash
# Validate runtime Docker build ordering and the web frontend monorepo layout.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DOCKERFILE="${ROOT}/Dockerfile.web-server"
MCP_DOCKERFILE="${ROOT}/Dockerfile.mcp-server"
COMPOSE_FILE="${ROOT}/docker-compose.web-server.yml"
ENV_EXAMPLE="${ROOT}/docker.web-server.env.example"

if [[ ! -f "${DOCKERFILE}" ]]; then
  echo "missing Dockerfile.web-server" >&2
  exit 1
fi
if [[ ! -f "${MCP_DOCKERFILE}" ]]; then
  echo "missing Dockerfile.mcp-server" >&2
  exit 1
fi
if [[ ! -f "${COMPOSE_FILE}" || ! -f "${ENV_EXAMPLE}" ]]; then
  echo "missing web-server Compose or env example" >&2
  exit 1
fi

fail() {
  echo "validate-web-server-dockerfile: $*" >&2
  exit 1
}

assert_target_driver_revisions_generated_before_build() {
  local dockerfile="$1"
  local label="$2"
  local copy_line revision_line build_line

  copy_line="$(awk '$0 == "COPY . ." { print NR; exit }' "${dockerfile}")"
  revision_line="$(awk '/generate-driver-agent-revisions\.sh/ { print NR; exit }' "${dockerfile}")"
  build_line="$(awk '/go build -trimpath/ { print NR; exit }' "${dockerfile}")"

  [[ -n "${copy_line}" ]] || fail "${label}: missing COPY . ."
  [[ -n "${revision_line}" ]] || fail "${label}: missing target-platform driver revision generation"
  [[ -n "${build_line}" ]] || fail "${label}: missing go build"
  grep -Fq -- '--platform "${TARGETOS}/${TARGETARCH}"' "${dockerfile}" \
    || fail "${label}: driver revisions must use TARGETOS/TARGETARCH"
  (( revision_line > copy_line )) \
    || fail "${label}: driver revisions must be generated after COPY . ."
  (( revision_line < build_line )) \
    || fail "${label}: driver revisions must be generated before go build"
}

grep -Fq 'WORKDIR /src/frontend' "${DOCKERFILE}" \
  || fail "expected WORKDIR /src/frontend monorepo layout"
grep -Fq 'COPY shared/ /src/shared/' "${DOCKERFILE}" \
  || fail "expected COPY shared/ so frontend ../../../shared/i18n resolves"
grep -Fq 'COPY internal/db/data_source_capability_contract.json /src/internal/db/data_source_capability_contract.json' "${DOCKERFILE}" \
  || fail "expected COPY internal/db/data_source_capability_contract.json so frontend capability imports resolve"
grep -Fq 'COPY --from=frontend /src/frontend/dist ./frontend/dist' "${DOCKERFILE}" \
  || fail "expected dist copy from /src/frontend/dist"

# Old layout only copied frontend/ and broke catalog/messages/translate imports in CI.
if grep -Eq '^WORKDIR /frontend$' "${DOCKERFILE}"; then
  fail "legacy WORKDIR /frontend would break shared/i18n relative imports"
fi
if grep -Fq 'COPY --from=frontend /frontend/dist' "${DOCKERFILE}"; then
  fail "legacy dist path /frontend/dist no longer matches frontend stage"
fi

# Frontend sources still point outside package root into shared/i18n.
FRONTEND_CATALOG="${ROOT}/frontend/src/i18n/catalog.ts"
grep -Fq '../../../shared/i18n/' "${FRONTEND_CATALOG}" \
  || fail "frontend catalog no longer imports ../../../shared/i18n (update Dockerfile if path changed)"

assert_target_driver_revisions_generated_before_build "${DOCKERFILE}" "Dockerfile.web-server"
assert_target_driver_revisions_generated_before_build "${MCP_DOCKERFILE}" "Dockerfile.mcp-server"
grep -Fq 'GONAVI_WEB_PASSWORD: ${GONAVI_WEB_PASSWORD:-}' "${COMPOSE_FILE}" \
  || fail "docker-compose.web-server.yml must forward GONAVI_WEB_PASSWORD"
grep -Eq '^GONAVI_WEB_PASSWORD=$' "${ENV_EXAMPLE}" \
  || fail "docker.web-server.env.example must declare an empty GONAVI_WEB_PASSWORD"

echo "validate-web-server-dockerfile: ok"
