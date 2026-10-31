//go:build dev

package main

import (
	"io/fs"
	"os"
)

// 开发模式下由 Wails DevServer 提供前端资源，这里只提供一个稳定的占位 FS，
// 避免编译时依赖 frontend/dist 被并发重建。
var assets = os.DirFS(".")

// webServerAssets 是 web-server 模式的 dev 构建变体：assets 本就指向仓库
// 目录，无需磁盘中转；release 保持空操作以对齐生产版的 (fs.FS, func()) 签名。
func webServerAssets() (fs.FS, func()) {
	return assets, func() {}
}
