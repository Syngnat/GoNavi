#!/bin/bash

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

# 配置
APP_NAME="GoNavi"
DIST_DIR="dist"
BUILD_BIN_DIR="build/bin"
DEFAULT_BINARY_NAME="GoNavi" # 对应 wails.json 中的 outputfilename
DEV_VERSION_FILE="version/dev-version.txt"
DEFAULT_DEV_VERSION="0.0.1-test"

resolve_build_version() {
    if [ -n "${GONAVI_VERSION:-}" ]; then
        printf '%s\n' "${GONAVI_VERSION}"
        return
    fi

    if [ -f "$DEV_VERSION_FILE" ]; then
        local dev_version
        dev_version=$(head -n 1 "$DEV_VERSION_FILE" | tr -d '\r' | tr -d '[:space:]')
        if [ -n "$dev_version" ]; then
            printf '%s\n' "$dev_version"
            return
        fi
    fi

    local package_version
    package_version=$(grep '"version":' frontend/package.json | head -1 | awk -F: '{ print $2 }' | sed 's/[",]//g' | tr -d '[:space:]')
    if [ -n "$package_version" ]; then
        printf '%s\n' "$package_version"
        return
    fi

    printf '%s\n' "$DEFAULT_DEV_VERSION"
}

VERSION="$(resolve_build_version)"
echo "ℹ️  检测到版本号: $VERSION"
LDFLAGS="-s -w -X GoNavi-Wails/internal/app.AppVersion=$VERSION"

# 颜色配置
GREEN='\033[0;32m'
RED='\033[0;31m'
YELLOW='\033[1;33m'
NC='\033[0m'

BUILD_FAILURES=()

record_build_failure() {
    local target="$1"
    BUILD_FAILURES+=("$target")
}

get_file_size_bytes() {
    local target="$1"
    if [ ! -f "$target" ]; then
        echo 0
        return
    fi
    if stat -f%z "$target" >/dev/null 2>&1; then
        stat -f%z "$target"
        return
    fi
    if stat -c%s "$target" >/dev/null 2>&1; then
        stat -c%s "$target"
        return
    fi
    wc -c <"$target" | tr -d '[:space:]'
}

format_size_mb() {
    local bytes="${1:-0}"
    awk -v b="$bytes" 'BEGIN { printf "%.2fMB", b / 1024 / 1024 }'
}

try_compress_binary_with_upx() {
    local exe_path="$1"
    local label="$2"
    if [ ! -f "$exe_path" ]; then
        echo -e "${RED}   ❌ 未找到 ${label} 文件：$exe_path${NC}"
        exit 1
    fi

    if ! command -v upx >/dev/null 2>&1; then
        echo -e "${RED}   ❌ 未找到 upx，${label} 必须进行压缩后才能继续打包。${NC}"
        case "$(uname -s)" in
            Darwin)
                echo "      安装命令: brew install upx"
                ;;
            Linux)
                echo "      安装命令: sudo apt-get install -y upx-ucl  (或对应发行版包管理器)"
                ;;
        esac
        exit 1
    fi

    local before_bytes after_bytes
    before_bytes=$(get_file_size_bytes "$exe_path")
    echo "   🗜️  正在使用 UPX 压缩 ${label}..."
    if upx --best --lzma --force "$exe_path" >/dev/null 2>&1; then
        if ! upx -t "$exe_path" >/dev/null 2>&1; then
            echo -e "${RED}   ❌ UPX 校验失败：${label}${NC}"
            exit 1
        fi
        after_bytes=$(get_file_size_bytes "$exe_path")
        if [ "$after_bytes" -lt "$before_bytes" ]; then
            local saved_bytes=$((before_bytes - after_bytes))
            echo "   ✅ UPX 压缩完成: $(format_size_mb "$before_bytes") -> $(format_size_mb "$after_bytes")，减少 $(format_size_mb "$saved_bytes")"
        else
            echo "   ℹ️  UPX 压缩完成: $(format_size_mb "$before_bytes") -> $(format_size_mb "$after_bytes")"
        fi
    else
        echo -e "${RED}   ❌ UPX 压缩失败：${label}${NC}"
        exit 1
    fi
}

clear_macos_bundle_xattrs() {
    local bundle_path="$1"
    if [ -z "$bundle_path" ] || [ ! -e "$bundle_path" ]; then
        return
    fi
    if command -v xattr >/dev/null 2>&1; then
        xattr -cr "$bundle_path" >/dev/null 2>&1 || true
    fi
}

package_macos_bundle_zip() {
    local app_path="$1"
    local archive_path="$2"
    local archive_abs

    if [ ! -d "$app_path" ]; then
        echo -e "${RED}   ❌ 未找到 macOS 应用包：$app_path${NC}"
        exit 1
    fi

    archive_abs="$(cd "$(dirname "$archive_path")" && pwd)/$(basename "$archive_path")"
    rm -f "$archive_path"
    if command -v ditto >/dev/null 2>&1; then
        ditto -c -k --sequesterRsrc --keepParent "$app_path" "$archive_abs"
    elif command -v zip >/dev/null 2>&1; then
        (
            cd "$(dirname "$app_path")" && \
            zip -qry "$archive_abs" "$(basename "$app_path")"
        )
    else
        echo -e "${RED}   ❌ 未找到 ditto/zip，无法打包 macOS 应用。${NC}"
        exit 1
    fi

    if [ ! -f "$archive_abs" ]; then
        echo -e "${RED}   ❌ macOS 应用归档失败：$archive_abs${NC}"
        exit 1
    fi
}

package_macos_release() {
    local platform="$1"
    local archive_suffix="$2"

    echo -e "${GREEN}🍎 正在构建 macOS (${platform})...${NC}"
    generate_driver_agent_revisions "darwin/${platform}"
    wails build -trimpath -platform "darwin/${platform}" -clean -ldflags "$LDFLAGS"
    if [ $? -ne 0 ]; then
        echo -e "${RED}   ❌ macOS ${platform} 构建失败。${NC}"
        record_build_failure "macOS ${platform}"
        return
    fi

    local app_src="$BUILD_BIN_DIR/$DEFAULT_BINARY_NAME.app"
    local app_dest_name="${APP_NAME}-${VERSION}-${archive_suffix}.app"
    local zip_name="${APP_NAME}-${VERSION}-${archive_suffix}.zip"

    mv "$app_src" "$DIST_DIR/$app_dest_name"

    local app_bin_path
    app_bin_path=$(find "$DIST_DIR/$app_dest_name/Contents/MacOS" -maxdepth 1 -type f -print -quit)
    if [ -z "$app_bin_path" ] || [ ! -f "$app_bin_path" ]; then
        echo -e "${RED}   ❌ 未找到 macOS ${platform} 主程序文件。${NC}"
        exit 1
    fi

    echo -e "${YELLOW}   ⚠️  macOS ${platform} 改为无交互 ZIP 打包，不再生成 DMG。${NC}"
    clear_macos_bundle_xattrs "$DIST_DIR/$app_dest_name"
    if [ -n "${GONAVI_MACOS_RELEASE_SIGNING_IDENTITY:-}" ]; then
        echo "   🔏 正在使用稳定身份签名 .app (${platform}): ${GONAVI_MACOS_RELEASE_SIGNING_IDENTITY}"
        codesign --force --deep --sign "$GONAVI_MACOS_RELEASE_SIGNING_IDENTITY" "$DIST_DIR/$app_dest_name"
    else
        # ad-hoc 签名的身份随每个版本变化，用户升级后 macOS 钥匙串会对既有
        # 密钥条目重新弹一次授权；设置 GONAVI_MACOS_RELEASE_SIGNING_IDENTITY
        # （如 Developer ID Application 证书）可让签名跨版本稳定。
        echo "   🔏 正在对 .app 进行 ad-hoc 签名 (${platform})..."
        codesign --force --deep --sign - "$DIST_DIR/$app_dest_name"
    fi

    echo "   📦 正在打包 macOS 应用归档 (${platform})..."
    package_macos_bundle_zip "$DIST_DIR/$app_dest_name" "$DIST_DIR/$zip_name"
    rm -rf "$DIST_DIR/$app_dest_name"
    echo "   ✅ 已生成 $zip_name"
}

generate_driver_agent_revisions() {
    local platform="$1"
    echo "   🧭 正在生成 driver-agent revision 指纹 (${platform})..."
    ./tools/generate-driver-agent-revisions.sh --platform "$platform"
}

echo -e "${GREEN}🚀 开始构建 $APP_NAME $VERSION...${NC}"

# 清理并创建输出目录
rm -rf "$DIST_DIR"
mkdir -p "$DIST_DIR"

package_macos_release "arm64" "mac-arm64"
package_macos_release "amd64" "mac-amd64"

# --- Windows AMD64 构建 ---
echo -e "${GREEN}🪟 正在构建 Windows (amd64)...${NC}"
if command -v x86_64-w64-mingw32-gcc &> /dev/null; then
    generate_driver_agent_revisions "windows/amd64"
    wails build -trimpath -platform windows/amd64 -clean -ldflags "$LDFLAGS"
    if [ $? -eq 0 ]; then
        TARGET_EXE="$DIST_DIR/${APP_NAME}-${VERSION}-windows-amd64.exe"
        mv "$BUILD_BIN_DIR/${DEFAULT_BINARY_NAME}.exe" "$TARGET_EXE"
        echo "   ✅ 已生成 ${APP_NAME}-${VERSION}-windows-amd64.exe"
    else
        echo -e "${RED}   ❌ Windows amd64 构建失败。${NC}"
        record_build_failure "Windows amd64"
    fi
else
    echo -e "${YELLOW}   ⚠️  未找到 MinGW 工具 (x86_64-w64-mingw32-gcc)，跳过 Windows amd64 构建。${NC}"
fi

# --- Windows ARM64 构建 ---
echo -e "${GREEN}🪟 正在构建 Windows (arm64)...${NC}"
if command -v aarch64-w64-mingw32-gcc &> /dev/null; then
    generate_driver_agent_revisions "windows/arm64"
    wails build -trimpath -platform windows/arm64 -clean -ldflags "$LDFLAGS"
    if [ $? -eq 0 ]; then
        TARGET_EXE="$DIST_DIR/${APP_NAME}-${VERSION}-windows-arm64.exe"
        mv "$BUILD_BIN_DIR/${DEFAULT_BINARY_NAME}.exe" "$TARGET_EXE"
        echo "   ✅ 已生成 ${APP_NAME}-${VERSION}-windows-arm64.exe"
    else
        echo -e "${RED}   ❌ Windows arm64 构建失败。${NC}"
        record_build_failure "Windows arm64"
    fi
else
    echo -e "${YELLOW}   ⚠️  未找到 MinGW ARM64 工具 (aarch64-w64-mingw32-gcc)，跳过 Windows arm64 构建。${NC}"
    echo "      安装命令: brew install mingw-w64 (需要支持 ARM64 的版本)"
fi

# --- Linux AMD64 构建 ---
echo -e "${GREEN}🐧 正在构建 Linux (amd64)...${NC}"
# 检测当前系统
CURRENT_OS=$(uname -s)
CURRENT_ARCH=$(uname -m)

if [ "$CURRENT_OS" = "Linux" ] && [ "$CURRENT_ARCH" = "x86_64" ]; then
    # 本机 Linux amd64，直接构建
    generate_driver_agent_revisions "linux/amd64"
    wails build -trimpath -platform linux/amd64 -clean -ldflags "$LDFLAGS"
    if [ $? -eq 0 ]; then
        TARGET_LINUX_BIN="$DIST_DIR/${APP_NAME}-${VERSION}-linux-amd64"
        mv "$BUILD_BIN_DIR/${DEFAULT_BINARY_NAME}" "$TARGET_LINUX_BIN"
        chmod +x "$TARGET_LINUX_BIN"
        try_compress_binary_with_upx "$TARGET_LINUX_BIN" "Linux amd64 可执行文件"
        # 打包为 tar.gz
        cd "$DIST_DIR"
        tar -czvf "${APP_NAME}-${VERSION}-linux-amd64.tar.gz" "${APP_NAME}-${VERSION}-linux-amd64"
        rm "${APP_NAME}-${VERSION}-linux-amd64"
        cd ..
        echo "   ✅ 已生成 ${APP_NAME}-${VERSION}-linux-amd64.tar.gz"
    else
        echo -e "${RED}   ❌ Linux amd64 构建失败。${NC}"
        record_build_failure "Linux amd64"
    fi
elif command -v x86_64-linux-gnu-gcc &> /dev/null; then
    # macOS 或其他系统，尝试交叉编译
    export CC=x86_64-linux-gnu-gcc
    export CXX=x86_64-linux-gnu-g++
    export CGO_ENABLED=1
    generate_driver_agent_revisions "linux/amd64"
    wails build -trimpath -platform linux/amd64 -clean -ldflags "$LDFLAGS"
    if [ $? -eq 0 ]; then
        TARGET_LINUX_BIN="$DIST_DIR/${APP_NAME}-${VERSION}-linux-amd64"
        mv "$BUILD_BIN_DIR/${DEFAULT_BINARY_NAME}" "$TARGET_LINUX_BIN"
        chmod +x "$TARGET_LINUX_BIN"
        try_compress_binary_with_upx "$TARGET_LINUX_BIN" "Linux amd64 可执行文件"
        cd "$DIST_DIR"
        tar -czvf "${APP_NAME}-${VERSION}-linux-amd64.tar.gz" "${APP_NAME}-${VERSION}-linux-amd64"
        rm "${APP_NAME}-${VERSION}-linux-amd64"
        cd ..
        echo "   ✅ 已生成 ${APP_NAME}-${VERSION}-linux-amd64.tar.gz"
    else
        echo -e "${RED}   ❌ Linux amd64 交叉编译失败。${NC}"
        record_build_failure "Linux amd64"
    fi
    unset CC CXX CGO_ENABLED
else
    echo -e "${YELLOW}   ⚠️  非 Linux 系统且未找到交叉编译工具，跳过 Linux amd64 构建。${NC}"
    echo "      在 Linux 上运行此脚本可直接构建，或安装交叉编译工具链。"
fi

# --- Linux ARM64 构建 ---
echo -e "${GREEN}🐧 正在构建 Linux (arm64)...${NC}"
if [ "$CURRENT_OS" = "Linux" ] && [ "$CURRENT_ARCH" = "aarch64" ]; then
    # 本机 Linux arm64，直接构建
    generate_driver_agent_revisions "linux/arm64"
    wails build -trimpath -platform linux/arm64 -clean -ldflags "$LDFLAGS"
    if [ $? -eq 0 ]; then
        TARGET_LINUX_BIN="$DIST_DIR/${APP_NAME}-${VERSION}-linux-arm64"
        mv "$BUILD_BIN_DIR/${DEFAULT_BINARY_NAME}" "$TARGET_LINUX_BIN"
        chmod +x "$TARGET_LINUX_BIN"
        try_compress_binary_with_upx "$TARGET_LINUX_BIN" "Linux arm64 可执行文件"
        cd "$DIST_DIR"
        tar -czvf "${APP_NAME}-${VERSION}-linux-arm64.tar.gz" "${APP_NAME}-${VERSION}-linux-arm64"
        rm "${APP_NAME}-${VERSION}-linux-arm64"
        cd ..
        echo "   ✅ 已生成 ${APP_NAME}-${VERSION}-linux-arm64.tar.gz"
    else
        echo -e "${RED}   ❌ Linux arm64 构建失败。${NC}"
        record_build_failure "Linux arm64"
    fi
elif command -v aarch64-linux-gnu-gcc &> /dev/null; then
    # 交叉编译
    export CC=aarch64-linux-gnu-gcc
    export CXX=aarch64-linux-gnu-g++
    export CGO_ENABLED=1
    generate_driver_agent_revisions "linux/arm64"
    wails build -trimpath -platform linux/arm64 -clean -ldflags "$LDFLAGS"
    if [ $? -eq 0 ]; then
        TARGET_LINUX_BIN="$DIST_DIR/${APP_NAME}-${VERSION}-linux-arm64"
        mv "$BUILD_BIN_DIR/${DEFAULT_BINARY_NAME}" "$TARGET_LINUX_BIN"
        chmod +x "$TARGET_LINUX_BIN"
        try_compress_binary_with_upx "$TARGET_LINUX_BIN" "Linux arm64 可执行文件"
        cd "$DIST_DIR"
        tar -czvf "${APP_NAME}-${VERSION}-linux-arm64.tar.gz" "${APP_NAME}-${VERSION}-linux-arm64"
        rm "${APP_NAME}-${VERSION}-linux-arm64"
        cd ..
        echo "   ✅ 已生成 ${APP_NAME}-${VERSION}-linux-arm64.tar.gz"
    else
        echo -e "${RED}   ❌ Linux arm64 交叉编译失败。${NC}"
        record_build_failure "Linux arm64"
    fi
    unset CC CXX CGO_ENABLED
else
    echo -e "${YELLOW}   ⚠️  非 Linux ARM64 系统且未找到交叉编译工具，跳过 Linux arm64 构建。${NC}"
    echo "      安装命令 (Ubuntu): sudo apt install gcc-aarch64-linux-gnu g++-aarch64-linux-gnu"
    echo "      安装命令 (macOS): brew install aarch64-linux-gnu-gcc (需要第三方 tap)"
fi

# 清理中间构建目录
rm -rf "build/bin"

echo -e "${GREEN}🔐 生成 SHA256SUMS...${NC}"
if command -v sha256sum &> /dev/null; then
    cd "$DIST_DIR"
    : > SHA256SUMS
    for f in *; do
        [ -f "$f" ] || continue
        case "$f" in
            SHA256SUMS|latest.json|latest-dev.json) continue ;;
        esac
        sha256sum "$f" >> SHA256SUMS
    done
    cd ..
elif command -v shasum &> /dev/null; then
    cd "$DIST_DIR"
    : > SHA256SUMS
    for f in *; do
        [ -f "$f" ] || continue
        case "$f" in
            SHA256SUMS|latest.json|latest-dev.json) continue ;;
        esac
        shasum -a 256 "$f" >> SHA256SUMS
    done
    cd ..
else
    echo -e "${YELLOW}   ⚠️  未找到 sha256sum/shasum，跳过校验文件生成。${NC}"
fi

echo -e "${GREEN}📄 生成静态更新清单...${NC}"
if command -v python3 &> /dev/null; then
    # 正式版：latest.json；dev/test 版本：latest-dev.json（对应客户端 dev 通道）
    case "$VERSION" in
        dev-*|*-dev*|*dev*|*test*)
            TAG_FOR_MANIFEST="dev-latest"
            CHANNEL_FOR_MANIFEST="dev"
            OUT_MANIFEST="$DIST_DIR/latest-dev.json"
            ;;
        *)
            TAG_FOR_MANIFEST="v${VERSION#v}"
            CHANNEL_FOR_MANIFEST="latest"
            OUT_MANIFEST="$DIST_DIR/latest.json"
            ;;
    esac
    if python3 tools/generate-update-latest-manifest.py \
        --assets-dir "$DIST_DIR" \
        --version "$VERSION" \
        --tag "$TAG_FOR_MANIFEST" \
        --channel "$CHANNEL_FOR_MANIFEST" \
        --output "$OUT_MANIFEST"; then
        echo -e "${GREEN}   ✅ 已生成 $OUT_MANIFEST (channel=${CHANNEL_FOR_MANIFEST})${NC}"
    else
        echo -e "${YELLOW}   ⚠️  生成更新清单失败（不影响本地产物，正式/dev 发版由 CI 生成）${NC}"
    fi
else
    echo -e "${YELLOW}   ⚠️  未找到 python3，跳过更新清单${NC}"
fi

echo ""
if [ "${#BUILD_FAILURES[@]}" -gt 0 ]; then
    echo -e "${RED}❌ 构建未完全成功，失败平台：${BUILD_FAILURES[*]}${NC}"
    echo -e "${YELLOW}📦 已成功生成的产物在 'dist/' 目录下：${NC}"
else
    echo -e "${GREEN}🎉 所有任务完成！构建产物在 'dist/' 目录下：${NC}"
fi
ls -lh "$DIST_DIR"
echo ""
echo -e "${GREEN}📋 支持的平台：${NC}"
echo "   • macOS (Intel/Apple Silicon): .zip"
echo "   • Windows (x64/ARM64): .exe"
echo "   • Linux (x64/ARM64): .tar.gz"
echo ""
echo -e "${YELLOW}💡 提示：Linux AppImage 包请使用 GitHub Actions CI/CD 构建。${NC}"

if [ "${#BUILD_FAILURES[@]}" -gt 0 ]; then
    exit 1
fi
