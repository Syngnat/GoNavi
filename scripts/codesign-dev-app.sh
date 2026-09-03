#!/bin/sh

# Wails ad-hoc signs every development bundle (v2 pkg/commands/build/build.go
# runs `codesign --force --deep --sign -`). An ad-hoc signature has no stable
# identity: its designated requirement is the binary's cdhash, which changes on
# every rebuild. Keychain items created by a previous build only trust that
# build's signature, so macOS re-prompts for the login keychain password after
# every rebuild. Signing dev bundles with a stable code-signing identity makes
# the Keychain ACL trust survive rebuilds.
#
# Identity resolution order:
#   1. GONAVI_MACOS_DEV_SIGNING_IDENTITY (explicit override)
#   2. a dedicated "GoNavi Dev Signing" identity — create one without an Apple
#      Developer account via scripts/create-dev-signing-cert.sh
#   3. no stable identity found: keep Wails' ad-hoc signature (Keychain ACL
#      prompts will recur on every rebuild)
set -eu

app_path=${1:-}
if [ -z "$app_path" ]; then
  echo "GoNavi dev signing: missing app bundle path" >&2
  exit 2
fi

if [ "$(uname -s)" != "Darwin" ]; then
  exit 0
fi

target_path=$app_path
case "$app_path" in
  */*.app/Contents/MacOS/*)
    # Wails passes the packaged executable, but the stable signing identity
    # must be applied to the complete bundle and its nested code.
    target_path=${app_path%%/Contents/MacOS/*}
    ;;
esac

if [ ! -e "$target_path" ]; then
  echo "GoNavi dev signing: target does not exist: $target_path" >&2
  exit 2
fi

identity=${GONAVI_MACOS_DEV_SIGNING_IDENTITY:-}
if [ -z "$identity" ]; then
  dedicated=$(security find-identity -v -p codesigning 2>/dev/null \
    | grep -F '"GoNavi Dev Signing"' \
    | head -n 1 \
    | sed 's/^ *[0-9]*) [A-F0-9]* //; s/"$//; s/^"//') || dedicated=""
  if [ -n "$dedicated" ]; then
    identity=$dedicated
  fi
fi

if [ -z "$identity" ]; then
  echo "GoNavi dev signing: no stable identity found; keeping Wails ad-hoc signature." >&2
  echo "GoNavi dev signing: run scripts/create-dev-signing-cert.sh (no Apple Developer" >&2
  echo "GoNavi dev signing: account needed) or set GONAVI_MACOS_DEV_SIGNING_IDENTITY to" >&2
  echo "GoNavi dev signing: stop the macOS Keychain prompt on every rebuild." >&2
  exit 0
fi

echo "GoNavi dev signing: $identity"
/usr/bin/codesign --force --deep --sign "$identity" "$target_path"
