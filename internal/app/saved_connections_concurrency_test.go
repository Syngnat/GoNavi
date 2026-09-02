package app

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"GoNavi-Wails/internal/appdata"
	"GoNavi-Wails/internal/connection"
	"GoNavi-Wails/internal/dailysecret"
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

func TestSavedConnectionRepositoryWaitsForExternalFileLock(t *testing.T) {
	app := newSavedConnectionTestApp(t)
	repository := app.savedConnectionRepository()
	externalLock, err := appdata.AcquireFileLock(repository.connectionsPath() + ".lock")
	if err != nil {
		t.Fatalf("acquire external connections lock: %v", err)
	}
	defer externalLock.Close()

	finished := make(chan error, 1)
	go func() {
		_, err := repository.Save(connection.SavedConnectionInput{
			ID:     "locked-connection",
			Name:   "Locked connection",
			Config: connection.ConnectionConfig{ID: "locked-connection", Type: "mysql"},
		})
		finished <- err
	}()
	select {
	case err := <-finished:
		t.Fatalf("Save acquired connections lock before external release: %v", err)
	case <-time.After(50 * time.Millisecond):
	}
	if err := externalLock.Close(); err != nil {
		t.Fatalf("release external connections lock: %v", err)
	}
	select {
	case err := <-finished:
		if err != nil {
			t.Fatalf("Save after external lock release: %v", err)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("Save did not acquire connections lock after external release")
	}
}

func TestSavedConnectionRepositoryWaitsForSharedStorageLock(t *testing.T) {
	app := newSavedConnectionTestApp(t)
	repository := app.savedConnectionRepository()
	sharedLock, err := appdata.AcquireFileLock(appdata.SharedStorageLockPath(app.configDir))
	if err != nil {
		t.Fatalf("acquire shared storage lock: %v", err)
	}

	finished := make(chan error, 1)
	go func() {
		_, saveErr := repository.Save(connection.SavedConnectionInput{
			ID:     "shared-locked-connection",
			Name:   "Shared locked connection",
			Config: connection.ConnectionConfig{ID: "shared-locked-connection", Type: "mysql"},
		})
		finished <- saveErr
	}()
	select {
	case err := <-finished:
		t.Fatalf("Save acquired shared lock before external release: %v", err)
	case <-time.After(50 * time.Millisecond):
	}
	if err := sharedLock.Close(); err != nil {
		t.Fatalf("release shared storage lock: %v", err)
	}
	select {
	case err := <-finished:
		if err != nil {
			t.Fatalf("Save after shared lock release: %v", err)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("Save did not acquire shared lock after external release")
	}
}

const (
	crossProcessConnectionWriterRootEnv   = "GONAVI_TEST_CONNECTION_WRITER_ROOT"
	crossProcessConnectionWriterPrefixEnv = "GONAVI_TEST_CONNECTION_WRITER_PREFIX"
	crossProcessConnectionWriterCount     = 12
)

// TestSavedConnectionCrossProcessWriterHelper is executed in child test
// processes by TestSavedConnectionRepositoryCrossProcessWritesKeepConnectionsAndSecrets.
func TestSavedConnectionCrossProcessWriterHelper(t *testing.T) {
	root := os.Getenv(crossProcessConnectionWriterRootEnv)
	prefix := os.Getenv(crossProcessConnectionWriterPrefixEnv)
	if root == "" || prefix == "" {
		return
	}

	application := NewAppWithSecretStore(secretstore.NewUnavailableStore("test"))
	application.configDir = root
	repository := application.savedConnectionRepository()
	for index := 0; index < crossProcessConnectionWriterCount; index++ {
		id := fmt.Sprintf("%s-%02d", prefix, index)
		_, err := repository.Save(connection.SavedConnectionInput{
			ID:   id,
			Name: id,
			Config: connection.ConnectionConfig{
				ID:       id,
				Type:     "mysql",
				Host:     "127.0.0.1",
				Port:     3306,
				Password: id + "-secret",
			},
		})
		if err != nil {
			t.Fatalf("Save(%s): %v", id, err)
		}
	}
}

func TestSavedConnectionRepositoryCrossProcessWritesKeepConnectionsAndSecrets(t *testing.T) {
	root := t.TempDir()
	commands := make([]*exec.Cmd, 0, 2)
	for _, prefix := range []string{"desktop", "cli"} {
		command := exec.Command(os.Args[0], "-test.run=^TestSavedConnectionCrossProcessWriterHelper$")
		command.Env = append(
			os.Environ(),
			crossProcessConnectionWriterRootEnv+"="+root,
			crossProcessConnectionWriterPrefixEnv+"="+prefix,
		)
		command.Stdout = os.Stderr
		command.Stderr = os.Stderr
		if err := command.Start(); err != nil {
			t.Fatalf("start %s writer: %v", prefix, err)
		}
		commands = append(commands, command)
	}
	for _, command := range commands {
		if err := command.Wait(); err != nil {
			t.Fatalf("cross-process writer failed: %v", err)
		}
	}

	application := NewAppWithSecretStore(secretstore.NewUnavailableStore("test"))
	application.configDir = root
	items, err := application.savedConnectionRepository().List()
	if err != nil {
		t.Fatalf("List after cross-process writes: %v", err)
	}
	want := 2 * crossProcessConnectionWriterCount
	if len(items) != want {
		t.Fatalf("cross-process connection count = %d, want %d", len(items), want)
	}

	secrets := dailysecret.NewStore(root)
	for _, prefix := range []string{"desktop", "cli"} {
		for index := 0; index < crossProcessConnectionWriterCount; index++ {
			id := fmt.Sprintf("%s-%02d", prefix, index)
			bundle, found, err := secrets.GetConnection(id)
			if err != nil {
				t.Fatalf("GetConnection(%s): %v", id, err)
			}
			if !found || bundle.Password != id+"-secret" {
				t.Fatalf("connection secret %s was lost or changed: %#v found=%t", id, bundle, found)
			}
		}
	}
}

func TestSavedConnectionMutationsRollBackSecretsWhenMetadataWriteFails(t *testing.T) {
	app := newSavedConnectionTestApp(t)
	repository := app.savedConnectionRepository()
	_, err := repository.Save(connection.SavedConnectionInput{
		ID:   "atomic-connection",
		Name: "Before",
		Config: connection.ConnectionConfig{
			ID:       "atomic-connection",
			Type:     "postgres",
			Host:     "before.local",
			Password: "before-secret",
		},
	})
	if err != nil {
		t.Fatalf("seed connection: %v", err)
	}

	originalWriter := writeSavedConnectionsFileAtomicFunc
	t.Cleanup(func() { writeSavedConnectionsFileAtomicFunc = originalWriter })
	writeSavedConnectionsFileAtomicFunc = func(string, []byte) error {
		return errors.New("injected metadata write failure")
	}

	_, err = repository.Save(connection.SavedConnectionInput{
		ID:   "atomic-connection",
		Name: "After",
		Config: connection.ConnectionConfig{
			ID:       "atomic-connection",
			Type:     "postgres",
			Host:     "after.local",
			Password: "after-secret",
		},
	})
	if err == nil || !strings.Contains(err.Error(), "injected metadata write failure") {
		t.Fatalf("Save error = %v, want injected metadata failure", err)
	}

	resolved, err := app.resolveConnectionSecrets(connection.ConnectionConfig{ID: "atomic-connection"})
	if err != nil {
		t.Fatalf("resolve rolled-back connection: %v", err)
	}
	if resolved.Host != "before.local" || resolved.Password != "before-secret" {
		t.Fatalf("failed Save left mixed state: host=%q password=%q", resolved.Host, resolved.Password)
	}
}

func TestDeleteConnectionRollsBackSecretWhenMetadataWriteFails(t *testing.T) {
	app := newSavedConnectionTestApp(t)
	repository := app.savedConnectionRepository()
	_, err := repository.Save(connection.SavedConnectionInput{
		ID:   "delete-atomic",
		Name: "Delete atomic",
		Config: connection.ConnectionConfig{
			ID:       "delete-atomic",
			Type:     "mysql",
			Host:     "db.local",
			Password: "keep-secret",
		},
	})
	if err != nil {
		t.Fatalf("seed connection: %v", err)
	}

	originalWriter := writeSavedConnectionsFileAtomicFunc
	t.Cleanup(func() { writeSavedConnectionsFileAtomicFunc = originalWriter })
	writeSavedConnectionsFileAtomicFunc = func(string, []byte) error {
		return errors.New("injected delete metadata failure")
	}
	if err := repository.Delete("delete-atomic"); err == nil || !strings.Contains(err.Error(), "injected delete metadata failure") {
		t.Fatalf("Delete error = %v, want injected metadata failure", err)
	}

	resolved, err := app.resolveConnectionSecrets(connection.ConnectionConfig{ID: "delete-atomic"})
	if err != nil {
		t.Fatalf("resolve rolled-back deleted connection: %v", err)
	}
	if resolved.Password != "keep-secret" {
		t.Fatalf("failed Delete removed stored password: %q", resolved.Password)
	}
}

func TestDeleteManyConnectionsDeletesMetadataAndSecretsTogether(t *testing.T) {
	app := newSavedConnectionTestApp(t)
	repository := app.savedConnectionRepository()
	for _, id := range []string{"delete-many-a", "delete-many-b", "keep-many"} {
		if _, err := repository.Save(connection.SavedConnectionInput{
			ID:   id,
			Name: id,
			Config: connection.ConnectionConfig{
				ID:       id,
				Type:     "mysql",
				Password: id + "-secret",
			},
		}); err != nil {
			t.Fatalf("seed %s: %v", id, err)
		}
	}

	if err := repository.DeleteMany([]string{" delete-many-a ", "delete-many-b", "delete-many-a"}); err != nil {
		t.Fatalf("DeleteMany: %v", err)
	}
	items, err := repository.List()
	if err != nil {
		t.Fatalf("List after DeleteMany: %v", err)
	}
	if len(items) != 1 || items[0].ID != "keep-many" {
		t.Fatalf("metadata after DeleteMany = %#v, want only keep-many", items)
	}
	secrets, err := repository.dailySecrets().Load()
	if err != nil {
		t.Fatalf("load secrets after DeleteMany: %v", err)
	}
	if len(secrets.Connections) != 1 || secrets.Connections["keep-many"].Password != "keep-many-secret" {
		t.Fatalf("secrets after DeleteMany = %#v, want only keep-many", secrets.Connections)
	}
}

func TestDeleteManyConnectionsRollsBackWhenMetadataWriteFails(t *testing.T) {
	app := newSavedConnectionTestApp(t)
	repository := app.savedConnectionRepository()
	for _, id := range []string{"rollback-many-a", "rollback-many-b"} {
		if _, err := repository.Save(connection.SavedConnectionInput{
			ID:   id,
			Name: id,
			Config: connection.ConnectionConfig{
				ID:       id,
				Type:     "mysql",
				Password: id + "-secret",
			},
		}); err != nil {
			t.Fatalf("seed %s: %v", id, err)
		}
	}

	originalWriter := writeSavedConnectionsFileAtomicFunc
	t.Cleanup(func() { writeSavedConnectionsFileAtomicFunc = originalWriter })
	writeSavedConnectionsFileAtomicFunc = func(string, []byte) error {
		return errors.New("injected DeleteMany metadata failure")
	}
	if err := repository.DeleteMany([]string{"rollback-many-a", "rollback-many-b"}); err == nil || !strings.Contains(err.Error(), "injected DeleteMany metadata failure") {
		t.Fatalf("DeleteMany error = %v, want injected metadata failure", err)
	}

	items, err := repository.List()
	if err != nil {
		t.Fatalf("List after failed DeleteMany: %v", err)
	}
	if len(items) != 2 {
		t.Fatalf("failed DeleteMany changed metadata: %#v", items)
	}
	for _, id := range []string{"rollback-many-a", "rollback-many-b"} {
		resolved, err := app.resolveConnectionSecrets(connection.ConnectionConfig{ID: id})
		if err != nil {
			t.Fatalf("resolve %s after failed DeleteMany: %v", id, err)
		}
		if resolved.Password != id+"-secret" {
			t.Fatalf("failed DeleteMany removed %s secret: %q", id, resolved.Password)
		}
	}
}

func TestGetSavedConnectionsPersistsLegacyCreatedAt(t *testing.T) {
	app := newSavedConnectionTestApp(t)
	repository := app.savedConnectionRepository()
	payload, err := json.Marshal(savedConnectionsFile{Connections: []connection.SavedConnectionView{{
		ID:     "legacy-created-at",
		Name:   "Legacy created time",
		Config: connection.ConnectionConfig{ID: "legacy-created-at", Type: "mysql"},
	}}})
	if err != nil {
		t.Fatalf("marshal legacy saved connection: %v", err)
	}
	if err := os.WriteFile(repository.connectionsPath(), payload, 0o644); err != nil {
		t.Fatalf("write legacy connections: %v", err)
	}

	items, err := app.GetSavedConnections()
	if err != nil {
		t.Fatalf("GetSavedConnections: %v", err)
	}
	if len(items) != 1 || items[0].CreatedAt <= 0 {
		t.Fatalf("migrated createdAt = %#v, want nonzero timestamp", items)
	}
	persisted, err := repository.List()
	if err != nil {
		t.Fatalf("List migrated connections: %v", err)
	}
	if len(persisted) != 1 || persisted[0].CreatedAt != items[0].CreatedAt {
		t.Fatalf("persisted createdAt = %#v, want %#v", persisted, items)
	}
}

func TestDuplicateConnectionRollsBackNewSecretWhenMetadataWriteFails(t *testing.T) {
	app := newSavedConnectionTestApp(t)
	repository := app.savedConnectionRepository()
	_, err := repository.Save(connection.SavedConnectionInput{
		ID:   "duplicate-source",
		Name: "Duplicate source",
		Config: connection.ConnectionConfig{
			ID:       "duplicate-source",
			Type:     "mysql",
			Password: "source-secret",
		},
	})
	if err != nil {
		t.Fatalf("seed connection: %v", err)
	}

	originalWriter := writeSavedConnectionsFileAtomicFunc
	t.Cleanup(func() { writeSavedConnectionsFileAtomicFunc = originalWriter })
	writeSavedConnectionsFileAtomicFunc = func(string, []byte) error {
		return errors.New("injected duplicate metadata failure")
	}
	if _, err := repository.Duplicate("duplicate-source", "Unnamed", " Copy"); err == nil || !strings.Contains(err.Error(), "injected duplicate metadata failure") {
		t.Fatalf("Duplicate error = %v, want injected metadata failure", err)
	}

	secrets, err := repository.dailySecrets().Load()
	if err != nil {
		t.Fatalf("load daily secrets after failed Duplicate: %v", err)
	}
	if len(secrets.Connections) != 1 {
		t.Fatalf("failed Duplicate left %d secret bundles, want only the source", len(secrets.Connections))
	}
	if _, ok := secrets.Connections["duplicate-source"]; !ok {
		t.Fatal("failed Duplicate removed source secret")
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
