package app

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"sync"

	"GoNavi-Wails/internal/logger"
)

var legacyDorisStorageMigration sync.Map

// migrateLegacyDorisDriverInstall 将历史 `diros` 安装目录迁移到公开的
// `doris` 名称。连接内部键仍保留 `diros` 以兼容旧配置，但驱动管理界面
// 和磁盘路径不再出现拼写错误。
func migrateLegacyDorisDriverInstall(root string) {
	root = strings.TrimSpace(root)
	if root == "" {
		return
	}
	if _, migrated := legacyDorisStorageMigration.Load(root); migrated {
		return
	}

	legacyDir := filepath.Join(root, "diros")
	targetDir := filepath.Join(root, "doris")
	legacyInfo, legacyErr := os.Stat(legacyDir)
	if legacyErr != nil || !legacyInfo.IsDir() {
		legacyDorisStorageMigration.Store(root, struct{}{})
		return
	}

	targetInfo, targetErr := os.Stat(targetDir)
	targetExists := targetErr == nil && targetInfo.IsDir()
	if !targetExists {
		if renameErr := os.Rename(legacyDir, targetDir); renameErr != nil {
			if copyErr := copyLegacyDorisDriverInstall(legacyDir, targetDir); copyErr != nil {
				logger.Warnf("迁移 Doris 驱动目录失败：legacy=%s target=%s err=%v", legacyDir, targetDir, copyErr)
				return
			}
		}
	} else if !dorisDriverInstallHasExecutable(targetDir) {
		if copyErr := copyLegacyDorisDriverInstall(legacyDir, targetDir); copyErr != nil {
			logger.Warnf("补齐 Doris 驱动目录失败：legacy=%s target=%s err=%v", legacyDir, targetDir, copyErr)
			return
		}
	}
	if err := normalizeMigratedDorisDriverInstall(targetDir); err != nil {
		logger.Warnf("规范化 Doris 驱动目录失败：dir=%s err=%v", targetDir, err)
		return
	}
	legacyDorisStorageMigration.Store(root, struct{}{})
	if dorisDriverInstallHasExecutable(targetDir) {
		_ = os.RemoveAll(legacyDir)
	}
}

func copyLegacyDorisDriverInstall(legacyDir string, targetDir string) error {
	if err := os.MkdirAll(targetDir, 0o755); err != nil {
		return err
	}
	legacyExecutable := filepath.Join(legacyDir, optionalDriverExecutableBaseNameForType("diros"))
	if info, err := os.Stat(legacyExecutable); err == nil && !info.IsDir() {
		targetExecutable := filepath.Join(targetDir, optionalDriverExecutableBaseNameForType("doris"))
		if err := copyAgentBinary(legacyExecutable, targetExecutable); err != nil {
			return err
		}
	}
	legacyMeta := filepath.Join(legacyDir, "installed.json")
	targetMeta := filepath.Join(targetDir, "installed.json")
	if _, err := os.Stat(targetMeta); err == nil {
		return nil
	}
	if content, err := os.ReadFile(legacyMeta); err == nil {
		var meta installedDriverPackage
		if json.Unmarshal(content, &meta) == nil {
			payload, marshalErr := json.MarshalIndent(meta, "", "  ")
			if marshalErr != nil {
				return marshalErr
			}
			if err := os.WriteFile(targetMeta, payload, 0o644); err != nil {
				return err
			}
		}
	}
	return nil
}

func normalizeMigratedDorisDriverInstall(targetDir string) error {
	legacyExecutable := filepath.Join(targetDir, optionalDriverExecutableBaseNameForType("diros"))
	targetExecutable := filepath.Join(targetDir, optionalDriverExecutableBaseNameForType("doris"))
	if info, err := os.Stat(legacyExecutable); err == nil && !info.IsDir() {
		if _, targetErr := os.Stat(targetExecutable); os.IsNotExist(targetErr) {
			if renameErr := os.Rename(legacyExecutable, targetExecutable); renameErr != nil {
				if copyErr := copyAgentBinary(legacyExecutable, targetExecutable); copyErr != nil {
					return copyErr
				}
				_ = os.Remove(legacyExecutable)
			}
		}
	}

	metaPath := filepath.Join(targetDir, "installed.json")
	content, err := os.ReadFile(metaPath)
	if err != nil {
		if os.IsNotExist(err) {
			return nil
		}
		return err
	}
	var meta installedDriverPackage
	if err := json.Unmarshal(content, &meta); err != nil {
		return nil
	}
	if info, statErr := os.Stat(targetExecutable); statErr == nil && !info.IsDir() {
		meta.FilePath = targetExecutable
		meta.FileName = filepath.Base(targetExecutable)
		meta.ExecutablePath = targetExecutable
	}
	payload, err := json.MarshalIndent(meta, "", "  ")
	if err != nil {
		return err
	}
	return os.WriteFile(metaPath, payload, 0o644)
}

func dorisDriverInstallHasExecutable(targetDir string) bool {
	info, err := os.Stat(filepath.Join(targetDir, optionalDriverExecutableBaseNameForType("doris")))
	return err == nil && !info.IsDir()
}
