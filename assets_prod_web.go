//go:build !dev

package main

import (
	"archive/tar"
	"bytes"
	"errors"
	"io"
	"io/fs"
	"os"
	"path"
	"path/filepath"

	"github.com/andybalholm/brotli"

	"GoNavi-Wails/internal/logger"
)

// webServerAssets 为 web-server 模式准备前端资源 FS。
//
// 桌面模式把嵌入的 dist.tar.br 整包解进内存（约 27 MB 常驻堆），对交互式
// 应用无所谓；但 web-server 是长期常驻的容器进程，这批匿名内存永远不会被
// 回收。这里改为解压到临时目录后用 os.DirFS 提供：同样的文件由 OS page
// cache 承载，内存紧张时内核可以直接回收。
// 解压或写盘失败（只读 /tmp、磁盘满等）时回退到内存 FS，不影响可用性。
// 返回的 release 在服务退出后调用，负责清理临时目录。
func webServerAssets() (fs.FS, func()) {
	dir, err := os.MkdirTemp("", "gonavi-web-assets-")
	if err != nil {
		logger.Warnf("Web Server 前端资产改用内存加载：创建临时目录失败：%v", err)
		return assets, func() {}
	}
	if err := extractBundleToDisk(embeddedDistBundle, dir); err != nil {
		logger.Warnf("Web Server 前端资产改用内存加载：解压到 %s 失败：%v", dir, err)
		_ = os.RemoveAll(dir)
		return assets, func() {}
	}
	logger.Infof("Web Server 前端资产已解压到磁盘：%s", dir)
	return os.DirFS(dir), func() {
		if err := os.RemoveAll(dir); err != nil {
			logger.Warnf("清理 Web Server 前端资产临时目录失败：%v", err)
		}
	}
}

// extractBundleToDisk 把 tar.br 固实包解到 dir。条目名沿用 bundleAssetFS.load
// 的同一约定：fs.ValidPath 已拒绝 ".." 等逃逸路径，非普通文件条目跳过。
func extractBundleToDisk(bundle []byte, dir string) error {
	reader := tar.NewReader(brotli.NewReader(bytes.NewReader(bundle)))
	for {
		header, err := reader.Next()
		if errors.Is(err, io.EOF) {
			return nil
		}
		if err != nil {
			return err
		}
		if header.Typeflag != tar.TypeReg {
			continue
		}
		name := path.Clean(header.Name)
		if !fs.ValidPath(name) || name == "." {
			continue
		}
		target := filepath.Join(dir, filepath.FromSlash(name))
		if err := os.MkdirAll(filepath.Dir(target), 0o755); err != nil {
			return err
		}
		if err := writeTarEntryToFile(target, reader); err != nil {
			return err
		}
	}
}

// writeTarEntryToFile 把当前 tar 条目流式写入 target，避免整文件读进堆。
func writeTarEntryToFile(target string, reader *tar.Reader) error {
	file, err := os.OpenFile(target, os.O_WRONLY|os.O_CREATE|os.O_TRUNC, 0o644)
	if err != nil {
		return err
	}
	if _, err := io.Copy(file, reader); err != nil {
		_ = file.Close()
		return err
	}
	return file.Close()
}
