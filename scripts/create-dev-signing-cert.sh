#!/bin/sh

# Creates a dedicated self-signed code-signing identity named "GoNavi Dev
# Signing" in the login keychain. scripts/codesign-dev-app.sh picks it up
# automatically so `wails dev` bundles keep a stable signature across rebuilds
# and macOS Keychain ACLs stop prompting on every rebuild. No Apple Developer
# account is required; delete the identity from Keychain Access to undo.
set -eu

identity_name="GoNavi Dev Signing"
login_keychain="$HOME/Library/Keychains/login.keychain-db"

if security find-identity -v -p codesigning 2>/dev/null | grep -F "\"$identity_name\"" >/dev/null; then
  echo "GoNavi dev signing: identity \"$identity_name\" already exists, nothing to do"
  exit 0
fi

workdir=$(mktemp -d)
trap 'rm -rf "$workdir"' EXIT

# digitalSignature covers the codesign operation; CA:TRUE marks the self-signed
# cert as its own trust anchor so add-trusted-cert can anchor it cleanly.
openssl req -newkey rsa:2048 -nodes \
  -keyout "$workdir/key.pem" \
  -x509 -days 3650 -out "$workdir/cert.pem" \
  -subj "/CN=$identity_name/O=GoNavi" \
  -addext "basicConstraints=critical,CA:TRUE" \
  -addext "keyUsage=critical,digitalSignature,keyCertSign" \
  -addext "extendedKeyUsage=codeSigning"

# -T whitelists /usr/bin/codesign for the private key so signing does not
# prompt "codesign wants to access key ..." on every build.
security import "$workdir/key.pem" -k "$login_keychain" -T /usr/bin/codesign
security import "$workdir/cert.pem" -k "$login_keychain" -T /usr/bin/codesign
security add-trusted-cert -p codeSign -k "$login_keychain" "$workdir/cert.pem"

echo "GoNavi dev signing: created identity \"$identity_name\" (valid 10 years)"
security find-identity -v -p codesigning | grep -F "\"$identity_name\"" || {
  echo "GoNavi dev signing: WARNING — identity not listed as valid for codesigning" >&2
  exit 1
}
