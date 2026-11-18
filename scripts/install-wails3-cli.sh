#!/usr/bin/env bash
# Installs the pinned Wails v3 CLI used by the build workflows.
#
# The Linux CLI build defaults to the GTK4 / WebKitGTK 6.0 cgo path and fails on
# runners that only have the GTK3 / WebKitGTK 4.x development packages. The CLI
# itself never links a webview: it shells out to `go build` for application
# builds, where the tags still select the real GTK / WebKit stack. Building the
# CLI with the purego tag therefore keeps CI dependency-free on every runner
# without changing what the produced applications link against.
set -euo pipefail

VERSION="${WAILS3_CLI_VERSION:-v3.1.0}"

if [ "$(uname -s)" = "Linux" ]; then
  CGO_ENABLED=0 go install -tags purego "github.com/wailsapp/wails/v3/cmd/wails3@${VERSION}"
else
  go install "github.com/wailsapp/wails/v3/cmd/wails3@${VERSION}"
fi
