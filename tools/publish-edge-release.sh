#!/usr/bin/env bash
set -euo pipefail

# Publish one prepared generation to the Cst static edge and Bero origin.
# Secrets are consumed only from the environment and are never printed.

require_value() {
  local name="$1"
  [[ -n "${!name:-}" ]] || { echo "Required publication setting is empty: ${name}" >&2; exit 1; }
}

for name in \
  PUB_CHANNEL PUB_APP_TAG PUB_APP_DIR PUB_APP_MANIFEST PUB_DRIVER_ENABLED \
  PUB_GENERATION; do
  require_value "${name}"
done
[[ "${PUB_CHANNEL}" == stable || "${PUB_CHANNEL}" == dev ]] || { echo "Invalid publication channel" >&2; exit 1; }
[[ "${PUB_GENERATION}" =~ ^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$ ]] || { echo "Invalid publication generation" >&2; exit 1; }
PUB_THROUGHPUT_WARN_MBPS="${PUB_THROUGHPUT_WARN_MBPS:-20}"
[[ "${PUB_THROUGHPUT_WARN_MBPS}" =~ ^[0-9]+([.][0-9]+)?$ ]] || { echo "Invalid throughput warning threshold" >&2; exit 1; }
EDGE_CST_MAX_BYTES="${EDGE_CST_MAX_BYTES:-9000000000}"
EDGE_CST_RESERVE_FREE_BYTES="${EDGE_CST_RESERVE_FREE_BYTES:-2000000000}"
EDGE_BERO_MAX_BYTES="${EDGE_BERO_MAX_BYTES:-9000000000}"
EDGE_BERO_RESERVE_FREE_BYTES="${EDGE_BERO_RESERVE_FREE_BYTES:-2000000000}"
[[ "${EDGE_BERO_HOST:-}" == "94.103.173.47" ]] || {
  echo "Bero origin SSH host must be 94.103.173.47" >&2
  exit 1
}
[[ "${EDGE_BERO_PORT:-}" == "37167" ]] || {
  echo "Bero origin SSH port must be 37167" >&2
  exit 1
}
PUB_TIMEOUT_KILL_AFTER_SECONDS="${PUB_TIMEOUT_KILL_AFTER_SECONDS:-15}"
PUB_PREPARE_COMMAND_TIMEOUT_SECONDS="${PUB_PREPARE_COMMAND_TIMEOUT_SECONDS:-600}"
PUB_SSH_CONNECT_TIMEOUT_SECONDS="${PUB_SSH_CONNECT_TIMEOUT_SECONDS:-15}"
PUB_SSH_SERVER_ALIVE_INTERVAL_SECONDS="${PUB_SSH_SERVER_ALIVE_INTERVAL_SECONDS:-15}"
PUB_SSH_SERVER_ALIVE_COUNT_MAX="${PUB_SSH_SERVER_ALIVE_COUNT_MAX:-4}"
PUB_SSH_CONTROL_PERSIST_SECONDS="${PUB_SSH_CONTROL_PERSIST_SECONDS:-300}"
PUB_SSH_QUICK_COMMAND_TIMEOUT_SECONDS="${PUB_SSH_QUICK_COMMAND_TIMEOUT_SECONDS:-60}"
PUB_SSH_TRANSACTION_COMMAND_TIMEOUT_SECONDS="${PUB_SSH_TRANSACTION_COMMAND_TIMEOUT_SECONDS:-300}"
PUB_SSH_RETENTION_COMMAND_TIMEOUT_SECONDS="${PUB_SSH_RETENTION_COMMAND_TIMEOUT_SECONDS:-120}"
PUB_RSYNC_IO_TIMEOUT_SECONDS="${PUB_RSYNC_IO_TIMEOUT_SECONDS:-120}"
PUB_RSYNC_COMMAND_TIMEOUT_SECONDS="${PUB_RSYNC_COMMAND_TIMEOUT_SECONDS:-900}"
PUB_HTTP_CONNECT_TIMEOUT_SECONDS="${PUB_HTTP_CONNECT_TIMEOUT_SECONDS:-10}"
PUB_HTTP_REQUEST_TIMEOUT_SECONDS="${PUB_HTTP_REQUEST_TIMEOUT_SECONDS:-60}"
PUB_THROUGHPUT_REQUEST_TIMEOUT_SECONDS="${PUB_THROUGHPUT_REQUEST_TIMEOUT_SECONDS:-120}"
for name in \
  PUB_TIMEOUT_KILL_AFTER_SECONDS PUB_PREPARE_COMMAND_TIMEOUT_SECONDS \
  PUB_SSH_CONNECT_TIMEOUT_SECONDS PUB_SSH_SERVER_ALIVE_INTERVAL_SECONDS \
  PUB_SSH_SERVER_ALIVE_COUNT_MAX PUB_SSH_CONTROL_PERSIST_SECONDS \
  PUB_SSH_QUICK_COMMAND_TIMEOUT_SECONDS \
  PUB_SSH_TRANSACTION_COMMAND_TIMEOUT_SECONDS PUB_SSH_RETENTION_COMMAND_TIMEOUT_SECONDS \
  PUB_RSYNC_IO_TIMEOUT_SECONDS PUB_RSYNC_COMMAND_TIMEOUT_SECONDS \
  PUB_HTTP_CONNECT_TIMEOUT_SECONDS PUB_HTTP_REQUEST_TIMEOUT_SECONDS \
  PUB_THROUGHPUT_REQUEST_TIMEOUT_SECONDS; do
  [[ "${!name}" =~ ^[1-9][0-9]*$ ]] || { echo "Invalid positive timeout: ${name}" >&2; exit 1; }
done
command -v timeout >/dev/null || { echo "GNU timeout is required for edge publication" >&2; exit 1; }
command -v sha256sum >/dev/null || { echo "sha256sum is required for edge publication" >&2; exit 1; }

run_timed() {
  local limit_seconds="$1"
  shift
  timeout --signal=TERM --kill-after="${PUB_TIMEOUT_KILL_AFTER_SECONDS}s" "${limit_seconds}s" "$@"
}

stage_dir="${RUNNER_TEMP}/gonavi-edge-${PUB_GENERATION}"
credential_root="${RUNNER_TEMP}/gonavi-edge-ssh-${PUB_GENERATION}"
status_root="${RUNNER_TEMP}/gonavi-edge-status-${PUB_GENERATION}"
control_fingerprint="$(printf '%s' "${PUB_GENERATION}" | sha256sum | cut -c1-16)"
control_root="${RUNNER_TEMP%/}/gonavi-edge-control-${control_fingerprint}"

ssh_control_path() {
  local node="$1"
  printf '%s/%s.sock' "${control_root}" "${node}"
}

stop_ssh_control_master() {
  local node="$1" host port user control_path
  control_path="$(ssh_control_path "${node}")"
  [[ -S "${control_path}" ]] || return 0
  host="$(node_value "${node}" HOST)"
  port="$(node_value "${node}" PORT)"
  user="$(node_value "${node}" USER)"
  [[ -n "${host}" && -n "${port}" && -n "${user}" ]] || return 0
  ssh -o BatchMode=yes -S "${control_path}" -O exit -p "${port}" "${user}@${host}" >/dev/null 2>&1 || true
}

cleanup() {
  local exit_code=$?
  trap - EXIT
  stop_ssh_control_master cst
  stop_ssh_control_master bero
  rm -rf -- "${stage_dir}" "${credential_root}" "${status_root}" "${control_root}"
  exit "${exit_code}"
}
trap cleanup EXIT
mkdir -p "${credential_root}" "${status_root}" "${control_root}"
chmod 0700 "${credential_root}" "${control_root}"

prepare_args=(
  --channel "${PUB_CHANNEL}"
  --app-tag "${PUB_APP_TAG}"
  --app-dir "${PUB_APP_DIR}"
  --app-manifest "${PUB_APP_MANIFEST}"
  --generation "${PUB_GENERATION}"
  --output "${stage_dir}"
)
effective_driver_tag=""
case "${PUB_DRIVER_ENABLED}" in
  true)
    for name in PUB_DRIVER_TAG PUB_DRIVER_DIR PUB_DRIVER_VERSION_INDEX PUB_DRIVER_LATEST_INDEX; do
      require_value "${name}"
    done
    effective_driver_tag="${PUB_DRIVER_TAG}"
    prepare_args+=(
      --driver-tag "${effective_driver_tag}"
      --driver-dir "${PUB_DRIVER_DIR}"
      --driver-version-index "${PUB_DRIVER_VERSION_INDEX}"
      --driver-latest-index "${PUB_DRIVER_LATEST_INDEX}"
    )
    ;;
  false) ;;
  *) echo "PUB_DRIVER_ENABLED must be true or false" >&2; exit 1 ;;
esac

run_timed "${PUB_PREPARE_COMMAND_TIMEOUT_SECONDS}" \
  python3 "${GITHUB_WORKSPACE}/tools/prepare-vps-release-payload.py" "${prepare_args[@]}"

payload_bytes="$(jq -r '.payloadBytes' "${stage_dir}/deployment.json")"
[[ "${payload_bytes}" =~ ^[0-9]+$ ]] || { echo "Prepared payload has invalid byte count" >&2; exit 1; }

node_value() {
  local node="$1" suffix="$2" variable=""
  variable="EDGE_${node^^}_${suffix}"
  local value="${!variable:-}"
  if [[ "${suffix}" == BASE_URL ]]; then
    value="${value%/}"
  fi
  printf '%s' "${value}"
}

stage_node() (
  set -euo pipefail
  local node="$1" host port user private_key known_hosts root base_url max_bytes reserve_free_bytes ssh_dir remote remote_stage control_path
  host="$(node_value "${node}" HOST)"
  port="$(node_value "${node}" PORT)"
  user="$(node_value "${node}" USER)"
  private_key="$(node_value "${node}" PRIVATE_KEY)"
  known_hosts="$(node_value "${node}" KNOWN_HOSTS)"
  root="$(node_value "${node}" ROOT)"
  base_url="$(node_value "${node}" BASE_URL)"
  max_bytes="$(node_value "${node}" MAX_BYTES)"
  reserve_free_bytes="$(node_value "${node}" RESERVE_FREE_BYTES)"
  for value in "${host}" "${port}" "${user}" "${private_key}" "${known_hosts}" "${root}" "${base_url}" "${max_bytes}" "${reserve_free_bytes}"; do
    [[ -n "${value}" ]] || { echo "${node} is not configured" >&2; exit 10; }
  done
  [[ "${port}" =~ ^[0-9]+$ ]] || { echo "${node} has an invalid SSH port" >&2; exit 1; }
  [[ "${max_bytes}" =~ ^[0-9]+$ && "${reserve_free_bytes}" =~ ^[0-9]+$ ]] || { echo "${node} has an invalid disk budget" >&2; exit 1; }
  [[ "${root}" == /srv/* && "${base_url}" =~ ^https://[A-Za-z0-9.-]+(:[0-9]{1,5})?/?$ ]] || { echo "${node} root or HTTPS URL is invalid" >&2; exit 1; }
  if [[ "${node}" == cst && ( "${host}" != "189.24.81.251" || "${port}" != "19375" ) ]]; then
    echo "cst SSH target must be 189.24.81.251:19375" >&2
    exit 1
  fi
  if [[ "${node}" == bero && ( "${host}" != "94.103.173.47" || "${port}" != "37167" ) ]]; then
    echo "bero origin SSH target must be 94.103.173.47:37167" >&2
    exit 1
  fi
  if [[ "${node}" == bero ]]; then
    base_url_without_slash="${base_url%/}"
    [[ "${base_url_without_slash}" == "https://origin-download.syngnat.top:8443" ]] || {
      echo "bero base URL must be https://origin-download.syngnat.top:8443" >&2
      exit 1
    }
  fi

  ssh_dir="${credential_root}/${node}"
  mkdir -p "${ssh_dir}"
  chmod 0700 "${ssh_dir}"
  printf '%s\n' "${private_key}" > "${ssh_dir}/id_ed25519"
  printf '%s\n' "${known_hosts}" > "${ssh_dir}/known_hosts"
  chmod 0600 "${ssh_dir}/id_ed25519" "${ssh_dir}/known_hosts"
  ssh-keygen -y -f "${ssh_dir}/id_ed25519" >/dev/null
  control_path="$(ssh_control_path "${node}")"
  # The Bero SSH endpoint applies a connection-rate guard. Reusing one
  # authenticated transport keeps a multi-step publication below that guard
  # without weakening the deployment key or host-key checks.
  ssh_options=(
    -i "${ssh_dir}/id_ed25519" -p "${port}" -o BatchMode=yes -o IdentitiesOnly=yes
    -o StrictHostKeyChecking=yes -o "UserKnownHostsFile=${ssh_dir}/known_hosts"
    -o "ConnectTimeout=${PUB_SSH_CONNECT_TIMEOUT_SECONDS}"
    -o "ServerAliveInterval=${PUB_SSH_SERVER_ALIVE_INTERVAL_SECONDS}"
    -o "ServerAliveCountMax=${PUB_SSH_SERVER_ALIVE_COUNT_MAX}"
    -o ControlMaster=auto -o "ControlPersist=${PUB_SSH_CONTROL_PERSIST_SECONDS}"
    -o "ControlPath=${control_path}"
  )
  remote="${user}@${host}"
  remote_stage="${root}/.incoming/${PUB_GENERATION}"
  run_ssh() {
    local limit_seconds="$1"
    shift
    run_timed "${limit_seconds}" ssh "${ssh_options[@]}" "${remote}" "$@"
  }
  transaction_args=(
    --root "${root}" --staging-dir "${remote_stage}" --channel "${PUB_CHANNEL}"
    --app-tag "${PUB_APP_TAG}" --driver-tag "${effective_driver_tag}"
    --generation "${PUB_GENERATION}" --node-id "${node}"
  )

  echo "[${node}] checking mirror marker"
  marker="$(run_ssh "${PUB_SSH_QUICK_COMMAND_TIMEOUT_SECONDS}" "cat '${root}/.gonavi-mirror-root'")"
  [[ "${marker}" == gonavi-download-mirror-v1 ]] || { echo "${node} mirror marker is invalid" >&2; exit 1; }
  echo "[${node}] clearing previous staging"
  printf -v remote_command 'sudo -- %q %q' "/usr/local/libexec/gonavi-edge-transaction" abort
  for argument in "${transaction_args[@]}"; do printf -v remote_command '%s %q' "${remote_command}" "${argument}"; done
  run_ssh "${PUB_SSH_TRANSACTION_COMMAND_TIMEOUT_SECONDS}" "${remote_command}"
  # A release that is no longer referenced by either channel is superseded.
  # Prune before staging so a small edge cannot deadlock before it reaches the
  # post-publish cleanup below.
  printf -v retention_command 'sudo -- %q --root %q --min-age-seconds 0 --max-bytes %q --min-free-bytes %q' \
    "/usr/local/libexec/gonavi-edge-retention" "${root}" "${max_bytes}" "${reserve_free_bytes}"
  echo "[${node}] applying preflight retention"
  run_ssh "${PUB_SSH_RETENTION_COMMAND_TIMEOUT_SECONDS}" "${retention_command}"
  echo "[${node}] checking free space"
  available_kib="$(run_ssh "${PUB_SSH_QUICK_COMMAND_TIMEOUT_SECONDS}" "LC_ALL=C df -Pk '${root}' | awk 'NR == 2 { print \$4 }'")"
  [[ "${available_kib}" =~ ^[0-9]+$ ]] || { echo "${node} returned invalid free space" >&2; exit 1; }
  (( available_kib * 1024 >= payload_bytes + reserve_free_bytes )) || { echo "${node} has insufficient free space" >&2; exit 1; }
  echo "[${node}] creating staging directory"
  run_ssh "${PUB_SSH_QUICK_COMMAND_TIMEOUT_SECONDS}" "mkdir -p '${remote_stage}'"
  echo "[${node}] uploading payload"
  run_timed "${PUB_RSYNC_COMMAND_TIMEOUT_SECONDS}" \
    rsync -rlt --delete --partial --timeout="${PUB_RSYNC_IO_TIMEOUT_SECONDS}" --chmod=Du=rwx,Dgo=rx,Fu=rw,Fgo=r \
    -e "ssh -i ${ssh_dir}/id_ed25519 -p ${port} -o BatchMode=yes -o IdentitiesOnly=yes -o StrictHostKeyChecking=yes -o UserKnownHostsFile=${ssh_dir}/known_hosts -o ConnectTimeout=${PUB_SSH_CONNECT_TIMEOUT_SECONDS} -o ServerAliveInterval=${PUB_SSH_SERVER_ALIVE_INTERVAL_SECONDS} -o ServerAliveCountMax=${PUB_SSH_SERVER_ALIVE_COUNT_MAX} -o ControlMaster=auto -o ControlPersist=${PUB_SSH_CONTROL_PERSIST_SECONDS} -o ControlPath=${control_path}" \
    "${stage_dir}/" "${remote}:${remote_stage}/"
  for command in verify promote-immutable; do
    echo "[${node}] ${command}"
    printf -v remote_command 'sudo -- %q %q' "/usr/local/libexec/gonavi-edge-transaction" "${command}"
    for argument in "${transaction_args[@]}"; do printf -v remote_command '%s %q' "${remote_command}" "${argument}"; done
    run_ssh "${PUB_SSH_TRANSACTION_COMMAND_TIMEOUT_SECONDS}" "${remote_command}"
  done

  probe_path="$(jq -r '.probePath' "${stage_dir}/deployment.json")"
  probe_size="$(jq -r '.probeSize' "${stage_dir}/deployment.json")"
  probe_end=$(( probe_size < 1024 ? probe_size - 1 : 1023 ))
  headers="${status_root}/${node}.headers"
  body="${status_root}/${node}.body"
  echo "[${node}] verifying immutable Range"
  curl --fail --silent --show-error --proto '=https' --tlsv1.2 \
    --connect-timeout "${PUB_HTTP_CONNECT_TIMEOUT_SECONDS}" --max-time "${PUB_HTTP_REQUEST_TIMEOUT_SECONDS}" \
    --range "0-${probe_end}" --dump-header "${headers}" --output "${body}" \
    "${base_url}/${probe_path}?generation=${PUB_GENERATION}"
  grep -Eiq '^HTTP/[^ ]+ 206([[:space:]]|$)' "${headers}"
  grep -Eiq "^content-range:[[:space:]]*bytes 0-${probe_end}/${probe_size}([[:space:]]|$)" "${headers}"
  [[ "$(stat -c '%s' "${body}")" == "$((probe_end + 1))" ]] || { echo "${node} Range body size mismatch" >&2; exit 1; }

  # Exercise up to 100 MiB with the client's eight-way access pattern. This is
  # observability only: routing eligibility is based on TLS, ready, generation,
  # and Range correctness, not an arbitrary bandwidth tier.
  sample_bytes=$(( probe_size < 104857600 ? probe_size : 104857600 ))
  perf_dir="${status_root}/${node}-throughput"
  mkdir -p "${perf_dir}"
  perf_chunk=$(( (sample_bytes + 7) / 8 ))
  perf_started="$(date +%s%N)"
  perf_pids=()
  echo "[${node}] observing eight-range throughput"
  for index in $(seq 0 7); do
    start=$(( index * perf_chunk ))
    (( start < sample_bytes )) || continue
    end=$(( start + perf_chunk - 1 ))
    (( end < sample_bytes )) || end=$(( sample_bytes - 1 ))
    curl --fail --silent --show-error --proto '=https' --tlsv1.2 \
      --connect-timeout "${PUB_HTTP_CONNECT_TIMEOUT_SECONDS}" --max-time "${PUB_THROUGHPUT_REQUEST_TIMEOUT_SECONDS}" \
      --range "${start}-${end}" --output "${perf_dir}/${index}.part" \
      "${base_url}/${probe_path}?throughput=${PUB_GENERATION}" &
    perf_pids+=("$!")
  done
  perf_failed=false
  for pid in "${perf_pids[@]}"; do
    if ! wait "${pid}"; then
      perf_failed=true
    fi
  done
  perf_finished="$(date +%s%N)"
  received_bytes="$(find "${perf_dir}" -type f -name '*.part' -printf '%s\n' | awk '{ total += $1 } END { print total + 0 }')"
  if [[ "${perf_failed}" == true || "${received_bytes}" != "${sample_bytes}" ]]; then
    echo "::warning::Edge ${node} throughput observation did not complete; publishing with limited performance status" >&2
    printf '{"status":"limited","observedMbps":0}\n' > "${status_root}/${node}.performance.json"
  else
    python3 - "${sample_bytes}" "${perf_started}" "${perf_finished}" "${PUB_THROUGHPUT_WARN_MBPS}" "${node}" "${status_root}/${node}.performance.json" <<'PY'
import json
import sys
from pathlib import Path

size, started, finished = map(int, sys.argv[1:4])
warning_threshold = float(sys.argv[4])
node = sys.argv[5]
output = Path(sys.argv[6])
elapsed = max((finished - started) / 1_000_000_000, 0.001)
mbps = size * 8 / elapsed / 1_000_000
status = "limited" if mbps < warning_threshold else "ok"
output.write_text(json.dumps({"status": status, "observedMbps": round(mbps, 2)}) + "\n", encoding="ascii")
print(f"{node} eight-range throughput: {mbps:.2f} Mbps ({size} bytes in {elapsed:.3f}s)")
if mbps < warning_threshold:
    print(
        f"::warning::Edge {node} throughput is below the observability threshold: "
        f"{mbps:.2f} < {warning_threshold:.2f} Mbps"
    )
PY
  fi

  printf 'immutable\n' > "${status_root}/${node}.status"
)

for node in cst bero; do
  echo "[${node}] staging generation ${PUB_GENERATION}"
  stage_node "${node}"
  [[ "$(cat "${status_root}/${node}.status" 2>/dev/null || true)" == immutable ]] || {
    echo "${node} did not pass immutable verification" >&2
    exit 1
  }
done

probe_path="/$(jq -r '.probePath' "${stage_dir}/deployment.json")"
probe_size="$(jq -r '.probeSize' "${stage_dir}/deployment.json")"
probe_sha="$(jq -r '.probeSha256' "${stage_dir}/deployment.json")"

activate_node() (
  set -euo pipefail
  local node="$1" host port user private_key known_hosts root base_url max_bytes reserve_free_bytes ssh_dir remote remote_stage control_path health_file driver_tag_file
  host="$(node_value "${node}" HOST)"
  port="$(node_value "${node}" PORT)"
  user="$(node_value "${node}" USER)"
  private_key="$(node_value "${node}" PRIVATE_KEY)"
  known_hosts="$(node_value "${node}" KNOWN_HOSTS)"
  root="$(node_value "${node}" ROOT)"
  base_url="$(node_value "${node}" BASE_URL)"
  max_bytes="$(node_value "${node}" MAX_BYTES)"
  reserve_free_bytes="$(node_value "${node}" RESERVE_FREE_BYTES)"
  ssh_dir="${credential_root}/${node}"
  control_path="$(ssh_control_path "${node}")"
  ssh_options=(
    -i "${ssh_dir}/id_ed25519" -p "${port}" -o BatchMode=yes -o IdentitiesOnly=yes
    -o StrictHostKeyChecking=yes -o "UserKnownHostsFile=${ssh_dir}/known_hosts"
    -o "ConnectTimeout=${PUB_SSH_CONNECT_TIMEOUT_SECONDS}"
    -o "ServerAliveInterval=${PUB_SSH_SERVER_ALIVE_INTERVAL_SECONDS}"
    -o "ServerAliveCountMax=${PUB_SSH_SERVER_ALIVE_COUNT_MAX}"
    -o ControlMaster=auto -o "ControlPersist=${PUB_SSH_CONTROL_PERSIST_SECONDS}"
    -o "ControlPath=${control_path}"
  )
  remote="${user}@${host}"
  remote_stage="${root}/.incoming/${PUB_GENERATION}"
  run_ssh() {
    local limit_seconds="$1"
    shift
    run_timed "${limit_seconds}" ssh "${ssh_options[@]}" "${remote}" "$@"
  }
  transaction_args=(
    --root "${root}" --staging-dir "${remote_stage}" --channel "${PUB_CHANNEL}"
    --app-tag "${PUB_APP_TAG}" --driver-tag "${effective_driver_tag}"
    --generation "${PUB_GENERATION}" --node-id "${node}"
  )
  performance_status="$(jq -r '.status' "${status_root}/${node}.performance.json")"
  performance_mbps="$(jq -r '.observedMbps' "${status_root}/${node}.performance.json")"
  transaction_args+=(--performance-status "${performance_status}" --performance-mbps "${performance_mbps}")
  run_remote_transaction() {
    local command="$1" remote_command
    printf -v remote_command 'sudo -- %q %q' "/usr/local/libexec/gonavi-edge-transaction" "${command}"
    for argument in "${transaction_args[@]}"; do printf -v remote_command '%s %q' "${remote_command}" "${argument}"; done
    run_ssh "${PUB_SSH_TRANSACTION_COMMAND_TIMEOUT_SECONDS}" "${remote_command}"
  }
  echo "[${node}] promote-mutable"
  run_remote_transaction promote-mutable
  echo "[${node}] finalize"
  if ! run_remote_transaction finalize; then
    echo "[${node}] rollback-mutable"
    run_remote_transaction rollback-mutable || echo "warning: ${node} mutable rollback needs operator attention" >&2
    return 1
  fi
  echo "[${node}] verifying mutable health"
  health_file="${status_root}/${node}.health.json"
  driver_tag_file="${status_root}/${node}.driver-tag"
  curl --fail --silent --show-error --proto '=https' --tlsv1.2 \
    --connect-timeout "${PUB_HTTP_CONNECT_TIMEOUT_SECONDS}" --max-time "${PUB_HTTP_REQUEST_TIMEOUT_SECONDS}" \
    --output "${health_file}" \
    "${base_url}/healthz?generation=${PUB_GENERATION}"
  jq -e --arg channel "${PUB_CHANNEL}" --arg generation "${PUB_GENERATION}" \
    '.status == "ok" and .ready == true and .channels[$channel].generation == $generation
      and ((.channels[$channel].driverTag // "") | type == "string")' \
    "${health_file}" >/dev/null
  jq -r --arg channel "${PUB_CHANNEL}" '.channels[$channel].driverTag // ""' \
    "${health_file}" > "${driver_tag_file}"
  printf -v retention_command 'sudo -- %q --root %q --min-age-seconds 0 --max-bytes %q --min-free-bytes %q' \
    "/usr/local/libexec/gonavi-edge-retention" "${root}" "${max_bytes}" "${reserve_free_bytes}"
  echo "[${node}] applying retention"
  run_ssh "${PUB_SSH_RETENTION_COMMAND_TIMEOUT_SECONDS}" "${retention_command}" || echo "warning: ${node} retention needs operator attention" >&2
  printf 'ready\n' > "${status_root}/${node}.status"
)

for node in cst bero; do
  echo "[${node}] activating generation ${PUB_GENERATION}"
  activate_node "${node}"
  [[ "$(cat "${status_root}/${node}.status" 2>/dev/null || true)" == ready ]] || {
    echo "${node} did not pass mutable activation" >&2
    exit 1
  }
done

cst_driver_tag="$(cat "${status_root}/cst.driver-tag")"
bero_driver_tag="$(cat "${status_root}/bero.driver-tag")"
# An app-only publication inherits each node's existing driver state. Those
# states may legitimately differ when no driver payload was published.
if [[ "${PUB_DRIVER_ENABLED}" == true && "${cst_driver_tag}" != "${bero_driver_tag}" ]]; then
  echo "Activated edge driver tags disagree: cst=${cst_driver_tag} bero=${bero_driver_tag}" >&2
  exit 1
fi
if [[ "${PUB_DRIVER_ENABLED}" == true && "${cst_driver_tag}" != "${PUB_DRIVER_TAG}" ]]; then
  echo "Activated edge driver tag does not match the published driver tag" >&2
  exit 1
fi
if [[ "${PUB_DRIVER_ENABLED}" == true ]]; then
  effective_driver_tag="${cst_driver_tag}"
else
  effective_driver_tag=""
fi

echo "Published generation ${PUB_GENERATION}: cst=true bero=true (static dispatcher)"
