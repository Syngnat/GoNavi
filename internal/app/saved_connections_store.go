package app

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"time"

	"GoNavi-Wails/internal/appdata"
	"GoNavi-Wails/internal/connection"
	"GoNavi-Wails/internal/dailysecret"

	"github.com/google/uuid"
)

func (r *savedConnectionRepository) connectionsPath() string {
	return filepath.Join(r.configDir, savedConnectionsFileName)
}

func (r *savedConnectionRepository) dailySecrets() *dailysecret.Store {
	return dailysecret.NewStore(r.configDir)
}

func (r *savedConnectionRepository) withWriteLock(operation func() error) (resultErr error) {
	savedConnectionsMu.Lock()
	defer savedConnectionsMu.Unlock()
	if err := os.MkdirAll(r.configDir, 0o755); err != nil {
		return err
	}
	sharedLock, err := appdata.AcquireFileLock(appdata.SharedStorageLockPath(r.configDir))
	if err != nil {
		return err
	}
	defer func() {
		resultErr = errors.Join(resultErr, sharedLock.Close())
	}()
	fileLock, err := appdata.AcquireFileLock(r.connectionsPath() + ".lock")
	if err != nil {
		return err
	}
	defer func() {
		resultErr = errors.Join(resultErr, fileLock.Close())
	}()
	if operation == nil {
		return nil
	}
	return operation()
}

type savedConnectionFilesSnapshot struct {
	connectionsExists bool
	connectionsData   []byte
	secretsExists     bool
	secretsData       []byte
}

func (r *savedConnectionRepository) captureFilesSnapshotUnlocked() (savedConnectionFilesSnapshot, error) {
	var snapshot savedConnectionFilesSnapshot
	connectionsData, connectionsExists, err := readOptionalFile(r.connectionsPath())
	if err != nil {
		return snapshot, err
	}
	secretsData, secretsExists, err := readOptionalFile(r.dailySecrets().Path())
	if err != nil {
		return snapshot, err
	}
	snapshot.connectionsExists = connectionsExists
	snapshot.connectionsData = connectionsData
	snapshot.secretsExists = secretsExists
	snapshot.secretsData = secretsData
	return snapshot, nil
}

func (snapshot savedConnectionFilesSnapshot) restoreUnlocked(r *savedConnectionRepository) error {
	var restoreErr error
	if err := r.dailySecrets().RestoreUnlocked(snapshot.secretsExists, snapshot.secretsData); err != nil {
		restoreErr = errors.Join(restoreErr, err)
	}
	if snapshot.connectionsExists {
		if err := writeSavedConnectionsFileAtomic(r.connectionsPath(), snapshot.connectionsData); err != nil {
			restoreErr = errors.Join(restoreErr, err)
		}
	} else if err := os.Remove(r.connectionsPath()); err != nil && !os.IsNotExist(err) {
		restoreErr = errors.Join(restoreErr, err)
	}
	return restoreErr
}

// withWriteTransaction keeps the metadata and daily-secret files coherent
// when a multi-file mutation reports an error. The shared cross-process lock
// remains held while both the mutation and any rollback are performed.
func (r *savedConnectionRepository) withWriteTransaction(operation func() error) error {
	return r.withWriteLock(func() error {
		snapshot, err := r.captureFilesSnapshotUnlocked()
		if err != nil {
			return err
		}
		if operation == nil {
			return nil
		}
		if err := operation(); err != nil {
			if restoreErr := snapshot.restoreUnlocked(r); restoreErr != nil {
				return errors.Join(err, fmt.Errorf("restore saved connection files: %w", restoreErr))
			}
			return err
		}
		return nil
	})
}

func (r *savedConnectionRepository) load() ([]connection.SavedConnectionView, error) {
	connections, _, err := r.loadWithLegacyCreatedAt()
	return connections, err
}

// loadWithLegacyCreatedAt preserves the display order of legacy connection
// files while reporting whether their derived timestamps need writing back.
func (r *savedConnectionRepository) loadWithLegacyCreatedAt() ([]connection.SavedConnectionView, bool, error) {
	data, err := os.ReadFile(r.connectionsPath())
	if err != nil {
		if os.IsNotExist(err) {
			return []connection.SavedConnectionView{}, false, nil
		}
		return nil, false, err
	}

	var file savedConnectionsFile
	if err := json.Unmarshal(data, &file); err != nil {
		return nil, false, err
	}
	if file.Connections == nil {
		return []connection.SavedConnectionView{}, false, nil
	}
	// Legacy files predate CreatedAt. Derive a stable monotonic order from the
	// file timestamp so repeated restarts do not reshuffle old connections.
	legacyCreatedAt := int64(0)
	if info, statErr := os.Stat(r.connectionsPath()); statErr == nil {
		legacyCreatedAt = info.ModTime().UnixMilli()
	}
	legacyCreatedAtChanged := false
	for index := range file.Connections {
		if file.Connections[index].CreatedAt <= 0 && legacyCreatedAt > 0 {
			file.Connections[index].CreatedAt = legacyCreatedAt - int64(index)
			legacyCreatedAtChanged = true
		}
		file.Connections[index].EnvironmentType = normalizeConnectionEnvironmentType(
			file.Connections[index].EnvironmentType,
		)
		if err := validateDatabasePatterns("include", file.Connections[index].IncludeDatabasePatterns); err != nil {
			return nil, false, fmt.Errorf("invalid saved connection %q: %w", file.Connections[index].ID, err)
		}
		if err := validateDatabasePatterns("exclude", file.Connections[index].ExcludeDatabasePatterns); err != nil {
			return nil, false, fmt.Errorf("invalid saved connection %q: %w", file.Connections[index].ID, err)
		}
		file.Connections[index].IncludeDatabasePatterns = sanitizeDatabasePatterns(
			file.Connections[index].IncludeDatabasePatterns,
		)
		file.Connections[index].ExcludeDatabasePatterns = sanitizeDatabasePatterns(
			file.Connections[index].ExcludeDatabasePatterns,
		)
	}
	return file.Connections, legacyCreatedAtChanged, nil
}

func (r *savedConnectionRepository) saveAll(connections []connection.SavedConnectionView) error {
	if err := os.MkdirAll(r.configDir, 0o755); err != nil {
		return err
	}
	payload, err := json.MarshalIndent(savedConnectionsFile{Connections: connections}, "", "  ")
	if err != nil {
		return err
	}
	// 原子替换而非 os.WriteFile：后者先把目标文件截断再写，进程在该窗口内被杀
	// （或并发读者恰好进入）会得到一个空的/半截的 connections.json，全部已保存连接一次性丢失。
	// 改成临时文件 + Sync + rename 后，读者要么看到旧文件、要么看到完整新文件，
	// 因此 List/Find 这类只读路径无需加锁。
	return writeSavedConnectionsFileAtomicFunc(r.connectionsPath(), payload)
}

var writeSavedConnectionsFileAtomicFunc = writeSavedConnectionsFileAtomic

// writeSavedConnectionsFileAtomic 以「临时文件 + Sync + 原子替换」写入 connections.json。
// 复用 replaceSavedQueryTempFile 的替换逻辑（其中包含 Windows 上 rename 失败的回退处理）。
func writeSavedConnectionsFileAtomic(targetPath string, payload []byte) error {
	dir := filepath.Dir(targetPath)
	temp, err := os.CreateTemp(dir, ".connections_*.tmp")
	if err != nil {
		return err
	}
	tempPath := temp.Name()
	cleanup := true
	defer func() {
		if cleanup {
			_ = os.Remove(tempPath)
		}
	}()

	if _, err := temp.Write(payload); err != nil {
		_ = temp.Close()
		return err
	}
	if err := temp.Sync(); err != nil {
		_ = temp.Close()
		return err
	}
	if err := temp.Close(); err != nil {
		return err
	}
	// 保持与原 os.WriteFile 相同的权限位，不在本次修复中顺带调整。
	if err := os.Chmod(tempPath, 0o644); err != nil {
		return err
	}
	if err := replaceSavedQueryTempFile(tempPath, targetPath); err != nil {
		return err
	}
	cleanup = false
	return nil
}

func prepareSavedConnectionInput(input connection.SavedConnectionInput) (connection.SavedConnectionInput, error) {
	if err := validateDatabasePatterns("include", input.IncludeDatabasePatterns); err != nil {
		return connection.SavedConnectionInput{}, err
	}
	if err := validateDatabasePatterns("exclude", input.ExcludeDatabasePatterns); err != nil {
		return connection.SavedConnectionInput{}, err
	}

	if strings.TrimSpace(input.ID) == "" && strings.TrimSpace(input.Config.ID) == "" {
		input.ID = "conn-" + uuid.New().String()[:8]
	}
	if strings.TrimSpace(input.ID) == "" {
		input.ID = strings.TrimSpace(input.Config.ID)
	}
	input.Config.ID = input.ID
	if input.CreatedAt <= 0 {
		input.CreatedAt = time.Now().UnixMilli()
	}
	return input, nil
}

// saveUnlocked persists one already-normalized connection while the caller
// holds withWriteLock. Keeping this operation separate lets a multi-item import
// retain the same cross-process lock across snapshot, every item, and rollback.
func (r *savedConnectionRepository) saveUnlocked(input connection.SavedConnectionInput) (connection.SavedConnectionView, error) {
	connections, err := r.load()
	if err != nil {
		return connection.SavedConnectionView{}, err
	}

	view, bundle := splitConnectionSecrets(input)
	index := -1
	var existing connection.SavedConnectionView
	for i, item := range connections {
		if item.ID == view.ID {
			index = i
			existing = item
			break
		}
	}

	mergedBundle := bundle
	if index >= 0 && savedConnectionViewHasSecrets(existing) {
		existingBundle, bundleErr := r.loadSecretBundle(existing)
		if bundleErr != nil {
			return connection.SavedConnectionView{}, bundleErr
		}
		mergedBundle = mergeConnectionSecretBundles(existingBundle, bundle)
	}
	mergedBundle = applyConnectionSecretClears(mergedBundle, input)

	if mergedBundle.hasAny() {
		if storeErr := r.saveSecretBundle(view.ID, mergedBundle); storeErr != nil {
			return connection.SavedConnectionView{}, storeErr
		}
	} else {
		if deleteErr := r.deleteSecretBundle(view.ID); deleteErr != nil {
			return connection.SavedConnectionView{}, deleteErr
		}
	}
	view.SecretRef = ""
	applyConnectionBundleFlags(&view, mergedBundle)

	if index >= 0 {
		connections[index] = view
	} else {
		connections = append(connections, view)
	}
	if err := r.saveAll(connections); err != nil {
		return connection.SavedConnectionView{}, err
	}
	return view, nil
}

func (r *savedConnectionRepository) Save(input connection.SavedConnectionInput) (connection.SavedConnectionView, error) {
	prepared, err := prepareSavedConnectionInput(input)
	if err != nil {
		return connection.SavedConnectionView{}, err
	}

	var saved connection.SavedConnectionView
	err = r.withWriteTransaction(func() error {
		var saveErr error
		saved, saveErr = r.saveUnlocked(prepared)
		return saveErr
	})
	if err != nil {
		return connection.SavedConnectionView{}, err
	}
	return saved, nil
}
