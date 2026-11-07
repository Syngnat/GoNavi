#!/usr/bin/env bash
# Builds the Wails v3 desktop artifact in the layout the release packaging
# steps already consume:
#   Windows -> build/bin/<build_name>.exe (+ icon/manifest syso)
#   macOS   -> build/bin/GoNavi.app
#   Linux   -> build/bin/<build_name>
#
# Usage: scripts/ci-build-wails3-release.sh <goos/goarch> <build_name> <version>
set -euo pipefail

PLATFORM="${1:?platform is required}"
BUILD_NAME="${2:?build name is required}"
VERSION="${3:?version is required}"
GOOS="${PLATFORM%%/*}"
GOARCH="${PLATFORM##*/}"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

TAGS="$(node -e "const w=require('./wails.json'); process.stdout.write(String(w['build:tags']||''))")"
TAGSET="wails3"
if [ -n "$TAGS" ]; then
  TAGSET="wails3,$TAGS"
fi

LDFLAGS="-s -w -X GoNavi-Wails/internal/app.AppVersion=${VERSION}"

# Mirror wails: use CGO when a C toolchain is configured, otherwise build pure Go.
CGO="${CGO_ENABLED:-}"
if [ -z "$CGO" ]; then
  if [ -n "${CC:-}" ]; then
    CGO=1
  else
    CGO=0
  fi
fi
export CGO_ENABLED="$CGO"
echo "==> wails3 release build platform=${PLATFORM} tags=${TAGSET} cgo=${CGO}"

node scripts/wails-pre-build.mjs "$PLATFORM"
mkdir -p build/bin

case "$GOOS" in
  windows)
    INFO_TMP="$(mktemp)"
    node - "$VERSION" "$INFO_TMP" <<'JS'
const fs = require('node:fs');
const [version, output] = process.argv.slice(2);
let info = fs.readFileSync('build/windows/info.json', 'utf8');
const values = {
  '{{.Info.ProductVersion}}': version,
  '{{.Info.ProductName}}': 'GoNavi',
  '{{.Info.CompanyName}}': 'Syngnat',
  '{{.Info.Copyright}}': 'Copyright 2026 Syngnat',
  '{{.Info.Comments}}': 'GoNavi is licensed under the Apache License, Version 2.0.',
};
for (const [token, value] of Object.entries(values)) {
  info = info.split(token).join(value);
}
fs.writeFileSync(output, info);
JS
    SYSO="cmd/wails3app/wails_windows_${GOARCH}.syso"
    wails3 generate syso -arch "$GOARCH" -icon build/windows/icon.ico \
      -manifest build/windows/wails.exe.manifest -info "$INFO_TMP" -out "$SYSO"
    GOOS="$GOOS" GOARCH="$GOARCH" go build -tags "$TAGSET" -trimpath -buildvcs=false \
      -ldflags "$LDFLAGS -H windowsgui" -o "build/bin/${BUILD_NAME}.exe" ./cmd/wails3app
    rm -f "$SYSO" "$INFO_TMP"
    ;;
  darwin)
    APP="build/bin/GoNavi.app"
    rm -rf "$APP"
    mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"
    GOOS="$GOOS" GOARCH="$GOARCH" go build -tags "$TAGSET" -trimpath -buildvcs=false \
      -ldflags "$LDFLAGS" -o "$APP/Contents/MacOS/GoNavi" ./cmd/wails3app
    cp build/darwin/icon.icns "$APP/Contents/Resources/iconfile.icns"
    python3 - "$VERSION" "$APP/Contents/Info.plist" <<'PY'
import re
import sys

version, output = sys.argv[1], sys.argv[2]
text = open('build/darwin/Info.plist', encoding='utf-8').read()

# Drop the wails template conditionals/loops, then fill the known fields.
depth = 0
parts = []
for token in re.split(r'({{.*?}})', text):
    if token.startswith('{{if ') or token.startswith('{{range '):
        depth += 1
        continue
    if token == '{{end}}':
        depth = max(0, depth - 1)
        continue
    if depth == 0:
        parts.append(token)
text = ''.join(parts)

for token, value in {
    '{{.Info.ProductName}}': 'GoNavi',
    '{{.OutputFilename}}': 'GoNavi',
    '{{.Name}}': 'GoNavi',
    '{{.Info.ProductVersion}}': version,
    '{{.Info.Comments}}': 'GoNavi is licensed under the Apache License, Version 2.0.',
    '{{.Info.Copyright}}': 'Copyright 2026 Syngnat',
}.items():
    text = text.replace(token, value)

extras = '''        <key>CFBundleURLTypes</key>
        <array>
          <dict>
            <key>CFBundleURLName</key>
            <string>com.wails.GoNavi</string>
            <key>CFBundleURLSchemes</key>
            <array>
              <string>gonavi</string>
            </array>
            <key>CFBundleTypeRole</key>
            <string>Viewer</string>
          </dict>
        </array>
        <key>CFBundleDocumentTypes</key>
        <array>
          <dict>
            <key>CFBundleTypeExtensions</key>
            <array>
              <string>sql</string>
            </array>
            <key>CFBundleTypeName</key>
            <string>SQL File</string>
            <key>CFBundleTypeRole</key>
            <string>Editor</string>
          </dict>
        </array>
'''
text = text.replace('    </dict>\n</plist>', extras + '    </dict>\n</plist>')
open(output, 'w', encoding='utf-8').write(text)
PY
    ;;
  linux)
    GOOS="$GOOS" GOARCH="$GOARCH" go build -tags "$TAGSET" -trimpath -buildvcs=false \
      -ldflags "$LDFLAGS" -o "build/bin/${BUILD_NAME}" ./cmd/wails3app
    chmod +x "build/bin/${BUILD_NAME}"
    ;;
  *)
    echo "unsupported platform: ${PLATFORM}" >&2
    exit 1
    ;;
esac

if cmp -s frontend/dist.tar.br tools/stub-dist.tar.br; then
  echo "frontend/dist.tar.br is still a stub; build the frontend first" >&2
  exit 1
fi

echo "==> wails3 artifact ready for ${PLATFORM}"
