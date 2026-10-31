#!/bin/sh
set -eu
umask 077
/bin/sh /usr/local/lib/gonavi-auth/init-kdc.sh
krb5kdc -n -r GONAVI.TEST &
kdc_pid=$!
kadmind -nofork -r GONAVI.TEST &
admin_pid=$!
trap 'kill "$kdc_pid" "$admin_pid" 2>/dev/null || true; wait' INT TERM EXIT
wait "$kdc_pid"
