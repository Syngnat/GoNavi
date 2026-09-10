//go:build !dev

package main

import (
	"bytes"
	"errors"
	"io/fs"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"sort"
	"testing"

	"github.com/wailsapp/wails/v2/pkg/assetserver"
	wailsassetoptions "github.com/wailsapp/wails/v2/pkg/options/assetserver"
)

// TestEmbeddedAssetsServeIndexAndDirectories 校验嵌入 zip 满足 Wails assetserver
// 的访问模式:打开 index.html、fs.WalkDir 定位页面、fs.ReadDir 列目录。
// 对 CI 的 stub zip(仅含占位 index.html)同样成立。
func TestEmbeddedAssetsServeIndexAndDirectories(t *testing.T) {
	data, err := fs.ReadFile(assets, "index.html")
	if err != nil {
		t.Fatalf("读取 index.html 失败: %v", err)
	}
	if len(bytes.TrimSpace(data)) == 0 {
		t.Fatal("index.html 内容为空")
	}

	rootEntries, err := fs.ReadDir(assets, ".")
	if err != nil {
		t.Fatalf("ReadDir(\".\") 失败: %v", err)
	}
	if !dirEntryNamesContain(rootEntries, "index.html") {
		t.Fatal("根目录缺 index.html")
	}

	walkedIndex := false
	err = fs.WalkDir(assets, ".", func(p string, d fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if p == "index.html" {
			walkedIndex = true
		}
		return nil
	})
	if err != nil {
		t.Fatalf("WalkDir 失败: %v", err)
	}
	if !walkedIndex {
		t.Fatal("WalkDir 没有走到 index.html")
	}

	if _, err := assets.Open("index.html/../index.html"); err == nil {
		t.Fatal("非法路径应被拒绝")
	}
	if _, err := assets.Open("no-such-file.js"); !errors.Is(err, fs.ErrNotExist) {
		t.Fatalf("缺失文件应返回 ErrNotExist, got %v", err)
	}
}

// TestEmbeddedAssetsMatchDistDirectory 在本机存在真实 dist 产物时,
// 交叉校验嵌入 zip 与 dist 目录的文件清单和 index.html 内容一致。
// CI 里的 stub zip 只含占位页,自动跳过。
func TestEmbeddedAssetsMatchDistDirectory(t *testing.T) {
	if info, err := os.Stat("frontend/dist"); err != nil || !info.IsDir() {
		t.Skip("本地没有 frontend/dist,跳过交叉校验")
	}
	zipStat, err := os.Stat("frontend/dist.zip")
	if err != nil || zipStat.Size() < 4096 {
		t.Skip("frontend/dist.zip 是占位 stub,跳过交叉校验")
	}

	if _, err := fs.ReadDir(assets, "assets"); err != nil {
		t.Fatalf("ReadDir(\"assets\") 失败: %v", err)
	}

	distFiles := collectRelFiles(t, "frontend/dist")
	zipFiles := map[string]bool{}
	err = fs.WalkDir(assets, ".", func(p string, d fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if !d.IsDir() {
			zipFiles[p] = true
		}
		return nil
	})
	if err != nil {
		t.Fatalf("遍历嵌入 zip 失败: %v", err)
	}

	if len(distFiles) != len(zipFiles) {
		t.Fatalf("文件数不一致: dist=%d zip=%d", len(distFiles), len(zipFiles))
	}
	for _, name := range distFiles {
		if !zipFiles[name] {
			t.Errorf("zip 缺少 dist 里的文件: %s", name)
		}
	}

	distIndex, err := os.ReadFile(filepath.Join("frontend", "dist", "index.html"))
	if err != nil {
		t.Fatalf("读取 dist/index.html 失败: %v", err)
	}
	zipIndex, err := fs.ReadFile(assets, "index.html")
	if err != nil {
		t.Fatalf("读取 zip/index.html 失败: %v", err)
	}
	if !bytes.Equal(distIndex, zipIndex) {
		t.Fatal("index.html 内容与 dist 不一致")
	}

	// 逐文件字节比对:zipFS 解出的每个文件必须与 dist 磁盘内容一致
	for _, name := range distFiles {
		distData, err := os.ReadFile(filepath.Join("frontend", "dist", filepath.FromSlash(name)))
		if err != nil {
			t.Fatalf("读取 dist/%s 失败: %v", name, err)
		}
		zipData, err := fs.ReadFile(assets, name)
		if err != nil {
			t.Fatalf("读取 zip/%s 失败: %v", name, err)
		}
		if !bytes.Equal(distData, zipData) {
			t.Errorf("zip 与 dist 内容不一致: %s", name)
		}
	}
}

// TestEmbeddedAssetsViaWailsAssetHandler 把嵌入 zip 挂到 Wails 自己的
// asset handler 上发真实 HTTP 请求,验证 GUI 资产服务路径端到端可用。
func TestEmbeddedAssetsViaWailsAssetHandler(t *testing.T) {
	if info, err := os.Stat("frontend/dist"); err != nil || !info.IsDir() {
		t.Skip("本地没有 frontend/dist,跳过 asset handler 验证")
	}
	if zipStat, err := os.Stat("frontend/dist.zip"); err != nil || zipStat.Size() < 4096 {
		t.Skip("frontend/dist.zip 是占位 stub,跳过 asset handler 验证")
	}

	handler, err := assetserver.NewAssetHandler(wailsassetoptions.Options{Assets: assets}, nil)
	if err != nil {
		t.Fatalf("创建 Wails asset handler 失败: %v", err)
	}

	resp := httptest.NewRecorder()
	handler.ServeHTTP(resp, httptest.NewRequest(http.MethodGet, "/", nil))
	if resp.Code != http.StatusOK {
		t.Fatalf("GET / 期望 200,得到 %d: %s", resp.Code, resp.Body.String())
	}
	distIndex, err := os.ReadFile(filepath.Join("frontend", "dist", "index.html"))
	if err != nil {
		t.Fatalf("读取 dist/index.html 失败: %v", err)
	}
	if !bytes.Equal(distIndex, resp.Body.Bytes()) {
		t.Fatal("asset handler 返回的 index.html 与 dist 不一致")
	}

	assetName := findMainChunk(t)
	resp = httptest.NewRecorder()
	handler.ServeHTTP(resp, httptest.NewRequest(http.MethodGet, "/assets/"+assetName, nil))
	if resp.Code != http.StatusOK {
		t.Fatalf("GET /assets/%s 期望 200,得到 %d", assetName, resp.Code)
	}
	distAsset, err := os.ReadFile(filepath.Join("frontend", "dist", "assets", assetName))
	if err != nil {
		t.Fatalf("读取 dist 资产失败: %v", err)
	}
	if !bytes.Equal(distAsset, resp.Body.Bytes()) {
		t.Fatalf("asset handler 返回的 %s 与 dist 不一致", assetName)
	}

	resp = httptest.NewRecorder()
	handler.ServeHTTP(resp, httptest.NewRequest(http.MethodGet, "/assets/no-such-chunk.js", nil))
	if resp.Code != http.StatusNotFound {
		t.Fatalf("缺失资产期望 404,得到 %d", resp.Code)
	}
}

// findMainChunk 取 dist 里体积最大的 main-*.js 作为比对样本。
func findMainChunk(t *testing.T) string {
	t.Helper()
	entries, err := filepath.Glob(filepath.Join("frontend", "dist", "assets", "main-*.js"))
	if err != nil || len(entries) == 0 {
		t.Fatalf("dist 里找不到 main-*.js: %v", err)
	}
	best := ""
	var bestSize int64
	for _, entry := range entries {
		info, err := os.Stat(entry)
		if err == nil && info.Size() > bestSize {
			best, bestSize = filepath.Base(entry), info.Size()
		}
	}
	if best == "" {
		t.Fatal("dist 里找不到非空 main-*.js")
	}
	return best
}

func dirEntryNamesContain(entries []fs.DirEntry, name string) bool {
	for _, entry := range entries {
		if entry.Name() == name {
			return true
		}
	}
	return false
}

func collectRelFiles(t *testing.T, root string) []string {
	t.Helper()
	var names []string
	err := filepath.WalkDir(root, func(p string, d fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if !d.IsDir() {
			rel, relErr := filepath.Rel(root, p)
			if relErr != nil {
				return relErr
			}
			names = append(names, filepath.ToSlash(rel))
		}
		return nil
	})
	if err != nil {
		t.Fatalf("遍历 %s 失败: %v", root, err)
	}
	sort.Strings(names)
	return names
}
