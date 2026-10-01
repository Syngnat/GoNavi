package app

import (
	"errors"
	"fmt"
	"os"
	"strings"

	"GoNavi-Wails/internal/connection"
	"GoNavi-Wails/internal/logger"
)

// errSavedConnectionOpaqueSecret 表示连接口令嵌在不透明 URI/DSN 中，无法只替换主口令。
var errSavedConnectionOpaqueSecret = errors.New("saved connection password is embedded in an opaque URI/DSN")

// UpdatePrimaryPassword 只替换已保存连接的主口令，其余配置与密文保持不变。
// 走与 Save 相同的 saveUnlocked 路径，保证旧版内联口令被剥离、口令写入 daily secret。
func (r *savedConnectionRepository) UpdatePrimaryPassword(id, password string) (connection.SavedConnectionView, error) {
	connectionID := strings.TrimSpace(id)
	if connectionID == "" || password == "" {
		return connection.SavedConnectionView{}, errors.New("connection id and password are required")
	}
	var updated connection.SavedConnectionView
	err := r.withWriteTransaction(func() error {
		connections, err := r.load()
		if err != nil {
			return err
		}
		for _, view := range connections {
			if view.ID != connectionID {
				continue
			}
			existing, bundleErr := r.loadSecretBundle(view)
			if bundleErr != nil && !errors.Is(bundleErr, os.ErrNotExist) {
				return bundleErr
			}
			if strings.TrimSpace(existing.OpaqueURI) != "" || strings.TrimSpace(existing.OpaqueDSN) != "" {
				return errSavedConnectionOpaqueSecret
			}
			config := view.Config
			config.Password = password
			updated, err = r.saveUnlocked(connection.SavedConnectionInput{
				ID:                         view.ID,
				Name:                       view.Name,
				CreatedAt:                  view.CreatedAt,
				EnvironmentType:            view.EnvironmentType,
				Config:                     config,
				IncludeDatabases:           view.IncludeDatabases,
				IncludeDatabasePatterns:    view.IncludeDatabasePatterns,
				ExcludeDatabasePatterns:    view.ExcludeDatabasePatterns,
				IncludeRedisDatabases:      view.IncludeRedisDatabases,
				SchemaVisibilityByDatabase: view.SchemaVisibilityByDatabase,
				IconType:                   view.IconType,
				IconColor:                  view.IconColor,
			})
			return err
		}
		return fmt.Errorf("saved connection not found: %s", connectionID)
	})
	if err != nil {
		return connection.SavedConnectionView{}, err
	}
	return updated, nil
}

// UserMgmtSyncConnectionPassword 在用户管理修改了本连接自身登录账号的口令后，
// 同步更新已保存连接的口令，避免下次连接因旧口令失败。
func (a *App) UserMgmtSyncConnectionPassword(connectionID string, password string) connection.QueryResult {
	if _, err := a.savedConnectionRepository().UpdatePrimaryPassword(connectionID, password); err != nil {
		logger.Error(err, "UserMgmtSyncConnectionPassword 失败：connection=%s", strings.TrimSpace(connectionID))
		key := "user_management.backend.error.password_sync_failed"
		if errors.Is(err, errSavedConnectionOpaqueSecret) {
			key = "user_management.backend.error.password_sync_opaque"
		}
		return connection.QueryResult{Success: false, Message: a.appText(key, nil)}
	}
	a.markCloudBackupDirty()
	return connection.QueryResult{Success: true, Message: a.appText("user_management.backend.message.password_synced", nil)}
}
