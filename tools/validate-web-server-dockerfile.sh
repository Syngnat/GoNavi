#!/usr/bin/env bash
# Validate runtime Docker build ordering and the web frontend monorepo layout.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DOCKERFILE="${ROOT}/Dockerfile.web-server"
MCP_DOCKERFILE="${ROOT}/Dockerfile.mcp-server"
COMPOSE_FILE="${ROOT}/docker-compose.web-server.yml"
LOCAL_COMPOSE_FILE="${ROOT}/docker-compose.web-server.local.yml"
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
if [[ ! -f "${LOCAL_COMPOSE_FILE}" ]]; then
  echo "missing docker-compose.web-server.local.yml" >&2
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

# 版本号必须注入。缺失时 AppVersion 恒为 "0.0.0"，而运行镜像里既没有
# version/dev-version.txt 也没有 frontend/package.json 可供回退，
# currentDriverReleaseTag() 会返回空 tag：驱动下载切到 releases/latest，
# 与构建现场生成的内嵌 revision 不匹配，驱动安装必然失败（见 #1318 后续反馈）。
assert_web_version_is_injected() {
  local version_arg version_default

  grep -Fq -- '-X GoNavi-Wails/internal/app.AppVersion=${VERSION}' "${DOCKERFILE}" \
    || fail "Dockerfile.web-server must inject AppVersion; without it the container resolves version 0.0.0 and the driver channel degrades to releases/latest"

  version_arg="$(awk '/^ARG VERSION=/ { print; exit }' "${DOCKERFILE}")"
  [[ -n "${version_arg}" ]] \
    || fail "Dockerfile.web-server must declare ARG VERSION so CI build-args reach ldflags"

  version_default="${version_arg#ARG VERSION=}"
  [[ -n "${version_default}" ]] \
    || fail "ARG VERSION must default to a value; an empty default silently yields AppVersion=\"\""

  # 默认值必须落在开发通道：isDevelopmentDriverReleaseVersion 只认 dev- 前缀
  # 与 -dev/-test/-local/-snapshot 后缀。裸 "dev"（Dockerfile.cli 的写法）会被
  # 判为正式版并拼出 "vdev" 这个不存在的 tag，因此这里不接受。
  case "${version_default}" in
    dev-*|*-dev|*-test|*-local|*-snapshot|*-snapshot.*|*-SNAPSHOT)
      ;;
    *)
      fail "ARG VERSION default '${version_default}' is not a dev-channel version; a plain value makes currentDriverReleaseTag() return \"v${version_default}\" and the driver download misses every published revision"
      ;;
  esac
}

# 本地 compose 必须显式传 VERSION，不能只依赖 Dockerfile 默认值——否则
# 改默认值会同时改掉 CI 与本地两条路径的行为，且本地构建静默回到 0.0.0 的风险
# 无法在评审中看见。
#
# 这里必须按行首锚定匹配键名，不能用 grep -Fq 'VERSION:'：compose 默认值写作
# ${GONAVI_WEB_VERSION:-dev-local} 时，内层变量名后面紧跟的冒号本身就能命中
# 子串，断言会在键名被改坏的情况下依旧通过。
assert_local_compose_passes_version() {
  awk '
    /^[[:space:]]*#/ { next }
    /^[[:space:]]*VERSION:[[:space:]]/ { found = 1 }
    END { exit(found ? 0 : 1) }
  ' "${LOCAL_COMPOSE_FILE}" \
    || fail "docker-compose.web-server.local.yml must pass a build arg VERSION so local source builds stay on the dev channel"
}

assert_web_version_is_injected
assert_local_compose_passes_version

grep -Fq 'WORKDIR /src/frontend' "${DOCKERFILE}" \
  || fail "expected WORKDIR /src/frontend monorepo layout"
grep -Fq 'COPY shared/ /src/shared/' "${DOCKERFILE}" \
  || fail "expected COPY shared/ so frontend ../../../shared/i18n resolves"
grep -Fq 'COPY internal/db/data_source_capability_contract.json /src/internal/db/data_source_capability_contract.json' "${DOCKERFILE}" \
  || fail "expected COPY internal/db/data_source_capability_contract.json so frontend capability imports resolve"
grep -Fq 'COPY internal/dbuser/option_contract.json /src/internal/dbuser/option_contract.json' "${DOCKERFILE}" \
  || fail "expected COPY internal/dbuser/option_contract.json so frontend user-management contract imports resolve"
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
