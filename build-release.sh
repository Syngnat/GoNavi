#!/bin/bash

# 配置
APP_NAME="GoNavi"
DIST_DIR="dist"
BUILD_BIN_DIR="build/bin"
DEFAULT_BINARY_NAME="gonavi" # 对应 wails.json 中的 outputfilename

# 提取版本号
VERSION=$(grep '"version":' frontend/package.json | head -1 | awk -F: '{ print $2 }' | sed 's/[",]//g' | tr -d '[[:space:]]')
if [ -z "$VERSION" ]; then
    VERSION="0.0.0"
fi
echo "ℹ️  检测到版本号: $VERSION"

# 颜色配置
GREEN='\033[0;32m'
RED='\033[0;31m'
YELLOW='\033[1;33m'
NC='\033[0m'

echo -e "${GREEN}🚀 开始构建 $APP_NAME $VERSION...${NC}"

# 清理并创建输出目录
rm -rf $DIST_DIR
mkdir -p $DIST_DIR

# --- macOS ARM64 构建 ---
echo -e "${GREEN}🍎 正在构建 macOS (arm64)...${NC}"
wails build -platform darwin/arm64 -clean
if [ $? -eq 0 ]; then
    APP_SRC="$BUILD_BIN_DIR/$DEFAULT_BINARY_NAME.app"
    APP_DEST_NAME="${APP_NAME}-${VERSION}-mac-arm64.app"
    DMG_NAME="${APP_NAME}-${VERSION}-mac-arm64.dmg"
    
    # 移动 .app 到 dist
    mv "$APP_SRC" "$DIST_DIR/$APP_DEST_NAME"
    
    # 创建 DMG
    if command -v create-dmg &> /dev/null; then
        echo "   📦 正在打包 DMG (arm64)..."
        # 移除已存在的 DMG (以防万一)
        rm -f "$DIST_DIR/$DMG_NAME"
        
        create-dmg \
            --volname "${APP_NAME} ${VERSION}" \
            --volicon "build/appicon.icns" \
            --window-pos 200 120 \
            --window-size 800 400 \
            --icon-size 100 \
            --icon "$APP_DEST_NAME" 200 190 \
            --hide-extension "$APP_DEST_NAME" \
            --app-drop-link 600 185 \
            "$DIST_DIR/$DMG_NAME" \
            "$DIST_DIR/$APP_DEST_NAME"
        
        # 检查是否生成了 rw.* 的临时文件并重命名 (create-dmg 有时会有此行为)
        if [ ! -f "$DIST_DIR/$DMG_NAME" ]; then
             RW_FILE=$(find "$DIST_DIR" -name "rw.*.dmg" -print -quit)
             if [ -n "$RW_FILE" ]; then
                 echo -e "${YELLOW}   ⚠️  检测到临时文件名，正在重命名...${NC}"
                 mv "$RW_FILE" "$DIST_DIR/$DMG_NAME"
             fi
        fi

        # 删除中间的 .app 文件，保持目录整洁
        rm -rf "$DIST_DIR/$APP_DEST_NAME"
        
        if [ -f "$DIST_DIR/$DMG_NAME" ]; then
             echo "   ✅ 已生成 $DMG_NAME"
        else
             echo -e "${RED}   ❌ DMG 生成失败，请检查 create-dmg 输出。${NC}"
        fi
    else
        echo -e "${YELLOW}   ⚠️  未找到 create-dmg 工具，跳过 DMG 打包，仅保留 .app。${NC}"
        echo "      安装命令: brew install create-dmg"
    fi
else
    echo -e "${RED}   ❌ macOS arm64 构建失败。${NC}"
fi

# --- macOS AMD64 构建 ---
echo -e "${GREEN}🍎 正在构建 macOS (amd64)...${NC}"
wails build -platform darwin/amd64 -clean
if [ $? -eq 0 ]; then
    APP_SRC="$BUILD_BIN_DIR/$DEFAULT_BINARY_NAME.app"
    APP_DEST_NAME="${APP_NAME}-${VERSION}-mac-amd64.app"
    DMG_NAME="${APP_NAME}-${VERSION}-mac-amd64.dmg"
    
    mv "$APP_SRC" "$DIST_DIR/$APP_DEST_NAME"
    
    if command -v create-dmg &> /dev/null; then
        echo "   📦 正在打包 DMG (amd64)..."
        rm -f "$DIST_DIR/$DMG_NAME"
        
        create-dmg \
            --volname "${APP_NAME} ${VERSION}" \
            --volicon "build/appicon.icns" \
            --window-pos 200 120 \
            --window-size 800 400 \
            --icon-size 100 \
            --icon "$APP_DEST_NAME" 200 190 \
            --hide-extension "$APP_DEST_NAME" \
            --app-drop-link 600 185 \
            "$DIST_DIR/$DMG_NAME" \
            "$DIST_DIR/$APP_DEST_NAME"

        # 检查是否生成了 rw.* 的临时文件并重命名
        if [ ! -f "$DIST_DIR/$DMG_NAME" ]; then
             RW_FILE=$(find "$DIST_DIR" -name "rw.*.dmg" -print -quit)
             if [ -n "$RW_FILE" ]; then
                 echo -e "${YELLOW}   ⚠️  检测到临时文件名，正在重命名...${NC}"
                 mv "$RW_FILE" "$DIST_DIR/$DMG_NAME"
             fi
        fi
        
        rm -rf "$DIST_DIR/$APP_DEST_NAME"
        
        if [ -f "$DIST_DIR/$DMG_NAME" ]; then
             echo "   ✅ 已生成 $DMG_NAME"
        else
             echo -e "${RED}   ❌ DMG 生成失败。${NC}"
        fi
    else
        echo -e "${YELLOW}   ⚠️  未找到 create-dmg 工具。${NC}"
    fi
else
    echo -e "${RED}   ❌ macOS amd64 构建失败。${NC}"
fi

# --- Windows AMD64 构建 ---
echo -e "${GREEN}🪟 正在构建 Windows (amd64)...${NC}"
if command -v x86_64-w64-mingw32-gcc &> /dev/null; then
    wails build -platform windows/amd64 -clean
    if [ $? -eq 0 ]; then
        mv "$BUILD_BIN_DIR/${DEFAULT_BINARY_NAME}.exe" "$DIST_DIR/${APP_NAME}-${VERSION}-windows-amd64.exe"
        echo "   ✅ 已生成 ${APP_NAME}-${VERSION}-windows-amd64.exe"
    else
        echo -e "${RED}   ❌ Windows 构建失败。${NC}"
    fi
else
    echo -e "${YELLOW}   ⚠️  未找到 MinGW 工具 (x86_64-w64-mingw32-gcc)，跳过 Windows 构建。${NC}"
fi

# 清理中间构建目录
rm -rf "build/bin"

echo -e "${GREEN}🎉 所有任务完成！构建产物在 'dist/' 目录下：${NC}"
ls -1 "$DIST_DIR"
