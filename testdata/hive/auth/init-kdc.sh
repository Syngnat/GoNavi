#!/bin/sh
set -eu
umask 077
state=/var/lib/gonavi-kdc
mkdir -p "$state" "$state/client" "$state/hive" "$state/ca"
chmod 700 "$state" "$state/client" "$state/hive" "$state/ca"
if [ -f "$state/initialized" ]; then
    test -s "$state/client/gonavi.keytab"
    test -s "$state/hive/hive.keytab"
    exit 0
fi
if [ -f "$state/principal" ]; then
    printf '%s\n' 'Refusing partially initialized KDC; inspect private init.log.' >&2
    exit 1
fi
openssl rand -hex 32 > "$state/master.password"
openssl rand -hex 32 > "$state/client/gonavi.password"
IFS= read -r master_password < "$state/master.password"
printf '%s\n%s\n' "$master_password" "$master_password" | \
    kdb5_util -r GONAVI.TEST create -s > "$state/init.log" 2>&1
unset master_password
IFS= read -r user_password < "$state/client/gonavi.password"
{
    printf 'addprinc -pw %s gonavi@GONAVI.TEST\n' "$user_password"
    printf '%s\n' \
        'addprinc -randkey hive/hive.gonavi.test@GONAVI.TEST' \
        'addprinc -randkey HTTP/hive.gonavi.test@GONAVI.TEST' \
        'ktadd -norandkey -k /var/lib/gonavi-kdc/client/gonavi.keytab gonavi@GONAVI.TEST' \
        'ktadd -norandkey -k /var/lib/gonavi-kdc/hive/hive.keytab hive/hive.gonavi.test@GONAVI.TEST HTTP/hive.gonavi.test@GONAVI.TEST' \
        'quit'
} | kadmin.local -r GONAVI.TEST >> "$state/init.log" 2>&1
unset user_password
test -s "$state/client/gonavi.keytab"
test -s "$state/hive/hive.keytab"
cp /etc/krb5.conf "$state/hive/krb5.conf"
/bin/sh /usr/local/lib/gonavi-auth/init-tls.sh >> "$state/init.log" 2>&1
chmod 600 "$state"/*.password "$state/client"/* "$state/hive"/* "$state/ca"/*
chown -R 1000:1000 "$state/hive"
touch "$state/initialized"
printf '%s\n' 'Dedicated GONAVI.TEST KDC initialized; credentials remain in private files.'
