#!/bin/sh
set -eu
umask 077
base=/opt/gonavi-db-lab/hive-1584/auth
test "$(pwd -P)" = "$base/source" || { echo 'Run from the dedicated auth/source directory.' >&2; exit 1; }
test -d /opt/gonavi-db-lab/hive-1584
docker network inspect gonavi-hive-1584 >/dev/null
if docker container inspect gonavi-hive-1584-kdc >/dev/null 2>&1; then
    purpose=$(docker inspect gonavi-hive-1584-kdc --format '{{index .Config.Labels "org.gonavi.purpose"}}')
    test "$purpose" = hive-auth-validation || { echo 'KDC name belongs to another purpose.' >&2; exit 1; }
else
    if ss -H -ltnu | awk '{print $5}' | awk '/:(11188|12464)$/ {found=1} END {exit !found}'; then
        echo 'Refusing KDC deployment: loopback test ports are occupied.' >&2
        exit 1
    fi
fi
mkdir -p "$base/private"
chmod 700 "$base/private"
docker build --memory=256m --memory-swap=256m --cpu-period=100000 --cpu-quota=50000 \
    --tag gonavi-hive-1584-kdc:bookworm .
docker compose -f compose.kdc.yaml up -d --no-deps --no-recreate kdc
docker inspect gonavi-hive-1584-kdc --format \
    'name={{.Name}} mem={{.HostConfig.Memory}} cpu={{.HostConfig.NanoCpus}} ports={{json .NetworkSettings.Ports}}'
