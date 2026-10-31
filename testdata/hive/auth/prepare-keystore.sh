#!/bin/sh
set -eu
umask 077
base=/opt/gonavi-db-lab/hive-1584/auth
test -f "$base/private/initialized"
test -s "$base/private/hive/server.p12"
if [ -s "$base/private/hive/hive.jks" ]; then exit 0; fi
docker run --rm --name gonavi-hive-1584-auth-keytool \
    --network none --memory 128m --memory-swap 128m --cpus 0.5 --user 1000:1000 \
    --label org.gonavi.purpose=hive-auth-validation \
    --volume "$base/private/hive:/lab:rw" \
    --entrypoint /bin/sh \
    apache/hive:4.0.1@sha256:5194161ef50b80875f937dff04936df047cbe894e9727ab8f0606349345b1bd3 \
    -c 'umask 077; keytool -J-Xmx64m -importkeystore -noprompt -srckeystore /lab/server.p12 -srcstoretype PKCS12 -srcstorepass:file /lab/keystore.password -destkeystore /lab/hive.jks -deststoretype JKS -deststorepass:file /lab/keystore.password' \
    > "$base/private/keytool.log" 2>&1
chmod 600 "$base/private/hive/hive.jks"
printf '%s\n' 'Dedicated Hive Java-8 JKS prepared; password remains private.'
