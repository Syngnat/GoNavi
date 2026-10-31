#!/bin/sh
set -eu
umask 077
test "${GONAVI_AUTH_PHASE_APPROVED:-}" = 1 || { echo 'Require explicit Lead AUTH PHASE GO.' >&2; exit 1; }
base=/opt/gonavi-db-lab/hive-1584
cd "$base"
purpose=$(docker inspect gonavi-hive-1584 --format '{{index .Config.Labels "org.gonavi.purpose"}}')
project=$(docker inspect gonavi-hive-1584 --format '{{index .Config.Labels "com.docker.compose.project"}}')
test "$purpose" = hive-integration-test
test "$project" = gonavi-hive-1584
docker volume inspect gonavi-hive-1584-data >/dev/null
if [ ! -f auth/private/baseline.sha256 ]; then
    sha256sum compose.yaml hive-site.xml > auth/private/baseline.sha256
fi
sha256sum -c auth/private/baseline.sha256
stage=${1:?specify a phase or restore}
if [ "$stage" = restore ]; then
    HIVE_TRANSPORT_MODE=binary HIVE_AUTH_MODE=NONE \
        docker compose -f compose.yaml up -d --no-deps --wait --wait-timeout 180 hive
    # The original Compose has no healthcheck. Probe inside the container, not
    # Docker's always-listening host proxy, with six bounded backoff intervals.
    docker exec gonavi-hive-1584 bash -c '
        for delay in 1 2 4 8 16 32; do
            if (exec 3<>/dev/tcp/127.0.0.1/10000) 2>/dev/null; then
                echo "Restored binary port is ready."
                exit 0
            fi
            sleep "$delay"
        done
        echo "Restored binary port did not become ready." >&2
        exit 1
    '
else
    case "$stage" in
        binary-gssapi|binary-gssapi-tls) mode=binary; auth=KERBEROS; port=10000 ;;
        http-spnego|http-spnego-tls) mode=http; auth=KERBEROS; port=10001 ;;
        binary-tls) mode=binary; auth=NONE; port=10000 ;;
        http-tls) mode=http; auth=NONE; port=10001 ;;
        *) echo 'Unsupported dedicated authentication phase.' >&2; exit 1 ;;
    esac
    python3 auth/source/render_hive_auth.py "$stage"
    GONAVI_HIVE_STAGE="$stage" GONAVI_HIVE_STAGE_MODE="$mode" \
    GONAVI_HIVE_STAGE_AUTH="$auth" GONAVI_HIVE_STAGE_CONTAINER_PORT="$port" \
        docker compose -f compose.yaml -f auth/source/compose.hive-auth.yaml \
        up -d --no-deps --wait --wait-timeout 180 hive
fi
printf '%s\n' "Dedicated Hive phase: $stage"
docker inspect gonavi-hive-1584 --format \
    'running={{.State.Running}} health={{with index .State "Health"}}{{.Status}}{{else}}not-configured{{end}} mem={{.HostConfig.Memory}} cpu={{.HostConfig.NanoCpus}}'
docker volume inspect gonavi-hive-1584-data --format 'preserved-volume={{.Name}}'
