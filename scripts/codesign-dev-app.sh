#!/bin/sh

# Wails self-signs development bundles ad hoc. Keep that default for local
# development: invoking codesign with an Apple Development identity accesses
# its private key in the macOS Keychain on every hot rebuild. Set
# GONAVI_MACOS_DEV_SIGNING_IDENTITY explicitly when a stable signed bundle is
# required (for example, when testing Keychain ACL behavior).
set -eu

app_path=${1:-}
if [ -z "$app_path" ]; then
  echo "GoNavi dev signing: missing app bundle path" >&2
  exit 2
fi

if [ "$(uname -s)" != "Darwin" ]; then
  exit 0
fi

identity=${GONAVI_MACOS_DEV_SIGNING_IDENTITY:-}
if [ -z "$identity" ]; then
  echo "GoNavi dev signing: identity not configured; keeping Wails ad-hoc signature" >&2
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

echo "GoNavi dev signing: $identity"
/usr/bin/codesign --force --deep --sign "$identity" "$target_path"
