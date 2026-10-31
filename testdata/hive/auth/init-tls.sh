#!/bin/sh
set -eu
umask 077
state=/var/lib/gonavi-kdc
ca=$state/ca
hive=$state/hive
openssl req -x509 -newkey rsa:3072 -sha256 -nodes -days 7 \
    -subj /CN=GoNavi-Hive-1584-Test-CA \
    -keyout "$ca/ca.key" -out "$hive/ca.crt"
openssl req -new -newkey rsa:3072 -sha256 -nodes \
    -subj /CN=hive.gonavi.test \
    -keyout "$hive/server.key" -out "$ca/server.csr"
printf '%s\n' \
    'subjectAltName=DNS:hive.gonavi.test,DNS:localhost,IP:127.0.0.1' \
    'extendedKeyUsage=serverAuth' \
    'keyUsage=digitalSignature,keyEncipherment' > "$ca/server.ext"
openssl x509 -req -in "$ca/server.csr" -CA "$hive/ca.crt" \
    -CAkey "$ca/ca.key" -CAcreateserial -sha256 -days 7 \
    -extfile "$ca/server.ext" -out "$hive/server.crt"
openssl rand -hex 24 > "$hive/keystore.password"
# Legacy PBE/MAC permits importing the fixture with the Hive image's Java 8.
openssl pkcs12 -export -legacy -macalg sha1 -name hive \
    -inkey "$hive/server.key" -in "$hive/server.crt" -certfile "$hive/ca.crt" \
    -passout "file:$hive/keystore.password" -out "$hive/server.p12"
openssl req -x509 -newkey rsa:2048 -sha256 -nodes -days 7 \
    -subj /CN=GoNavi-Untrusted-Test-CA \
    -keyout "$ca/untrusted-ca.key" -out "$hive/untrusted-ca.crt"
