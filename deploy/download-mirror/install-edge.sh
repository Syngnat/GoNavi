#!/usr/bin/env bash
set -euo pipefail

if [[ "$(id -u)" -ne 0 ]]; then
  echo "this installer must run as root" >&2
  exit 1
fi
if [[ $# -ne 5 ]]; then
  echo "usage: $0 NODE_ID PUBLIC_ROOT SERVER_KIND SERVER_CONFIG SERVER_GROUP" >&2
  exit 2
fi

node_id="$1"
public_root="$2"
server_kind="$3"
server_source="$4"
server_group="$5"
deploy_user="gonavi-cdn"
script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
transaction_source="${script_dir}/../../tools/edge-release-transaction.py"
retention_source="${script_dir}/../../tools/edge-release-retention.py"
transaction_target="/usr/local/libexec/gonavi-edge-transaction"
retention_target="/usr/local/libexec/gonavi-edge-retention"

[[ "${public_root}" == /srv/* && -f "${server_source}" ]] || { echo "invalid root or server config" >&2; exit 2; }
[[ -f "${transaction_source}" && -f "${retention_source}" ]] || { echo "run installer from a complete GoNavi checkout" >&2; exit 2; }
case "${node_id}:${server_kind}" in
  cst:nginx|bero:nginx) ;;
  cst:*) echo "Cst must use the Nginx static-site configuration" >&2; exit 2 ;;
  bero:*) echo "Bero must use the Nginx static-site configuration" >&2; exit 2 ;;
  *) echo "unsupported edge node: ${node_id}" >&2; exit 2 ;;
esac
getent group "${server_group}" >/dev/null || { echo "server group does not exist" >&2; exit 2; }

if ! id "${deploy_user}" >/dev/null 2>&1; then
  useradd --create-home --shell /bin/bash "${deploy_user}"
fi
usermod -a -G "${server_group}" "${deploy_user}"
install -d -m 0755 -o root -g "${server_group}" "${public_root}"
install -d -m 0750 -o "${deploy_user}" -g "${server_group}" "${public_root}/.incoming"
for directory in .state/channels .state/ready .transactions; do
  install -d -m 0755 -o root -g "${server_group}" "${public_root}/${directory}"
done
for directory in gonavi drivers .state .transactions .tools; do
  if [[ -e "${public_root}/${directory}" ]]; then
    chown -R root:"${server_group}" "${public_root}/${directory}"
  fi
done
marker_path="${public_root}/.gonavi-mirror-root"
health_path="${public_root}/healthz"
if [[ -f "${marker_path}" ]]; then
  [[ "$(<"${marker_path}")" == gonavi-download-mirror-v1 ]] || { echo "existing mirror marker is invalid" >&2; exit 2; }
else
  printf '%s\n' 'gonavi-download-mirror-v1' > "${marker_path}"
fi
if [[ ! -f "${health_path}" ]]; then
  cat > "${health_path}" <<EOF
{"schemaVersion":1,"status":"bootstrap","ready":false,"nodeId":"${node_id}","channels":{}}
EOF
fi
chown root:"${server_group}" "${marker_path}" "${health_path}"
chmod 0644 "${marker_path}" "${health_path}"

# The SSH user can write only staging. Root-owned, repository-installed scripts
# are the sole promotion and retention boundary; CI never uploads executable
# publication logic and never receives a root password.
install -d -m 0755 /usr/local/libexec
install -m 0755 -o root -g root "${transaction_source}" "${transaction_target}"
install -m 0755 -o root -g root "${retention_source}" "${retention_target}"
command -v visudo >/dev/null || { echo "visudo is required" >&2; exit 2; }
sudoers_tmp="$(mktemp)"
cat > "${sudoers_tmp}" <<EOF
Cmnd_Alias GONAVI_EDGE_CONTROL = ${transaction_target}, ${retention_target}
${deploy_user} ALL=(root) NOPASSWD: GONAVI_EDGE_CONTROL
EOF
chmod 0440 "${sudoers_tmp}"
visudo -cf "${sudoers_tmp}"
install -m 0440 -o root -g root "${sudoers_tmp}" /etc/sudoers.d/gonavi-cdn-edge
rm -f -- "${sudoers_tmp}"

# Both static origins use Nginx on :8443 because sing-box owns the common
# public ports on Cst and Bero. The caller supplies a complete server snippet.
command -v nginx >/dev/null || { echo "nginx is not installed" >&2; exit 2; }
grep -Eq '^[[:space:]]*server_name[[:space:]]+' "${server_source}" || { echo "Nginx config must declare server_name" >&2; exit 2; }
grep -Fq "root ${public_root}" "${server_source}" || { echo "Nginx config must serve the mirror root" >&2; exit 2; }
grep -Eq '^[[:space:]]*listen[[:space:]]+8443[[:space:]]+ssl;' "${server_source}" || {
  echo "Nginx config must listen on 8443 with TLS" >&2
  exit 2
}
if grep -Eq '^[[:space:]]*listen[[:space:]]+(\[::\]:)?(80|443|2053)[[:space:];]' "${server_source}"; then
  echo "Nginx config must not claim ports 80, 443, or 2053" >&2
  exit 2
fi
site_dir="/etc/nginx/conf.d"
site_path="${site_dir}/gonavi-download.conf"
install -d -m 0755 "${site_dir}"
backup_path="$(mktemp)"
had_site=false
if [[ -f "${site_path}" ]]; then
  cp -- "${site_path}" "${backup_path}"
  had_site=true
fi
install -m 0644 "${server_source}" "${site_path}"
if ! nginx -t; then
  if [[ "${had_site}" == true ]]; then
    install -m 0644 "${backup_path}" "${site_path}"
  else
    rm -f -- "${site_path}"
  fi
  rm -f -- "${backup_path}"
  echo "Nginx validation failed; managed snippet was rolled back" >&2
  exit 1
fi
rm -f -- "${backup_path}"
if systemctl is-active --quiet nginx; then
  systemctl reload nginx
else
  systemctl enable --now nginx
fi

echo "GoNavi static edge installed: node=${node_id} server=${server_kind} root=${public_root} user=${deploy_user}"
