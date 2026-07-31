package app

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"sync"
	"testing"

	"GoNavi-Wails/internal/connection"
	"GoNavi-Wails/internal/secretstore"
)

func newSavedConnectionTestApp(t *testing.T) *App {
	t.Helper()
	home := t.TempDir()
	t.Setenv("HOME", home)
	t.Setenv("USERPROFILE", home)
	application := NewAppWithSecretStore(secretstore.NewUnavailableStore("test"))
	application.configDir = t.TempDir()
	return application
}

// TestSaveConnectionConcurrentWritesDoNotLoseEntries 覆盖 connections.json 的并发写入。
//
// 回归背景：Save/Delete/Duplicate 的「load → 修改 → saveAll 整体重写」序列原先完全无互斥，
// 且 savedConnectionRepository() 每次返回新实例（实例级锁无效），必须包级锁。
// Wails 每个前端调用都在独立 goroutine 中派发，因此批量导入连接包、Navicat 导入、
// web-server 多请求会真并发进入写路径：每个 goroutine 各自 load 到完整列表后整体 WriteFile，
// 后写者用自己那份旧列表覆盖前写者，实测 12 条并发只剩 1 条落盘。
func TestSaveConnectionConcurrentWritesDoNotLoseEntries(t *testing.T) {
	app := newSavedConnectionTestApp(t)

	const total = 12
	var wg sync.WaitGroup
	wg.Add(total)
	errs := make([]error, total)
	for i := 0; i < total; i++ {
		go func(idx int) {
			defer wg.Done()
			id := fmt.Sprintf("conn-%02d", idx)
			_, err := app.savedConnectionRepository().Save(connection.SavedConnectionInput{
				ID:     id,
				Name:   id,
				Config: connection.ConnectionConfig{ID: id, Type: "mysql", Host: "127.0.0.1", Port: 3306},
			})
			errs[idx] = err
		}(i)
	}
	wg.Wait()

	for idx, err := range errs {
		if err != nil {
			t.Fatalf("并发 Save[%d] 返回错误：%v", idx, err)
		}
	}

	items, err := app.savedConnectionRepository().List()
	if err != nil {
		t.Fatalf("List returned error: %v", err)
	}
	if len(items) != total {
		t.Fatalf("并发保存 %d 条后只剩 %d 条（写入互相覆盖丢失）", total, len(items))
	}

	seen := make(map[string]struct{}, len(items))
	for _, item := range items {
		seen[item.ID] = struct{}{}
	}
	for i := 0; i < total; i++ {
		id := fmt.Sprintf("conn-%02d", i)
		if _, ok := seen[id]; !ok {
			t.Errorf("连接 %s 丢失", id)
		}
	}
}

// TestSaveAndDeleteConnectionsConcurrentlyKeepFileValid 并发混合 Save/Delete，
// 断言 connections.json 始终是完整可解析的 JSON（非原子截断写会留下空/半截文件）。
func TestSaveAndDeleteConnectionsConcurrentlyKeepFileValid(t *testing.T) {
	app := newSavedConnectionTestApp(t)

	// 先播种一批可供删除的连接。
	const seedCount = 8
	for i := 0; i < seedCount; i++ {
		id := fmt.Sprintf("seed-%02d", i)
		if _, err := app.savedConnectionRepository().Save(connection.SavedConnectionInput{
			ID:     id,
			Name:   id,
			Config: connection.ConnectionConfig{ID: id, Type: "mysql", Host: "127.0.0.1", Port: 3306},
		}); err != nil {
			t.Fatalf("seed Save returned error: %v", err)
		}
	}

	var wg sync.WaitGroup
	wg.Add(seedCount * 2)
	for i := 0; i < seedCount; i++ {
		go func(idx int) {
			defer wg.Done()
			_ = app.savedConnectionRepository().Delete(fmt.Sprintf("seed-%02d", idx))
		}(i)
		go func(idx int) {
			defer wg.Done()
			id := fmt.Sprintf("added-%02d", idx)
			_, _ = app.savedConnectionRepository().Save(connection.SavedConnectionInput{
				ID:     id,
				Name:   id,
				Config: connection.ConnectionConfig{ID: id, Type: "mysql", Host: "127.0.0.1", Port: 3306},
			})
		}(i)
	}
	wg.Wait()

	// 文件必须是完整合法的 JSON——原子替换保证读者只会看到旧文件或完整新文件。
	payload, err := os.ReadFile(filepath.Join(app.configDir, savedConnectionsFileName))
	if err != nil {
		t.Fatalf("读取 connections.json 失败：%v", err)
	}
	if len(payload) == 0 {
		t.Fatal("connections.json 为空（非原子截断写留下的空文件）")
	}
	var file savedConnectionsFile
	if err := json.Unmarshal(payload, &file); err != nil {
		t.Fatalf("connections.json 不是合法 JSON（被截断）：%v\n内容：%s", err, payload)
	}

	// 新增的 8 条必须全部在；被删除的不应残留。
	present := make(map[string]struct{}, len(file.Connections))
	for _, item := range file.Connections {
		present[item.ID] = struct{}{}
	}
	for i := 0; i < seedCount; i++ {
		if _, ok := present[fmt.Sprintf("added-%02d", i)]; !ok {
			t.Errorf("新增连接 added-%02d 丢失", i)
		}
		if _, ok := present[fmt.Sprintf("seed-%02d", i)]; ok {
			t.Errorf("已删除的连接 seed-%02d 仍然存在", i)
		}
	}
}

// TestWriteSavedConnectionsFileAtomicLeavesNoTempFile 原子写不得残留临时文件。
func TestWriteSavedConnectionsFileAtomicLeavesNoTempFile(t *testing.T) {
	dir := t.TempDir()
	target := filepath.Join(dir, savedConnectionsFileName)

	if err := writeSavedConnectionsFileAtomic(target, []byte(`{"connections":[]}`)); err != nil {
		t.Fatalf("writeSavedConnectionsFileAtomic returned error: %v", err)
	}
	if _, err := os.Stat(target); err != nil {
		t.Fatalf("目标文件未生成：%v", err)
	}

	entries, err := os.ReadDir(dir)
	if err != nil {
		t.Fatalf("ReadDir failed: %v", err)
	}
	for _, entry := range entries {
		if entry.Name() != savedConnectionsFileName {
			t.Errorf("残留了临时文件：%s", entry.Name())
		}
	}
}
