package app

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"

	"GoNavi-Wails/internal/connection"
	"GoNavi-Wails/internal/logger"
)

const (
	updateChannelFileName = "update_channel.json"
	updateDevReleaseTag   = "dev-latest"
)

type updateChannel string

const (
	updateChannelLatest updateChannel = "latest"
	updateChannelDev    updateChannel = "dev"
)

type updateChannelStateFile struct {
	Channel updateChannel `json:"channel"`
}

func normalizeUpdateChannel(value string) (updateChannel, error) {
	switch strings.ToLower(strings.TrimSpace(value)) {
	case "", string(updateChannelLatest):
		return updateChannelLatest, nil
	case string(updateChannelDev):
		return updateChannelDev, nil
	default:
		return "", localizedUpdateError{
			key:    "app.update.backend.error.channel_invalid",
			params: map[string]any{"channel": strings.TrimSpace(value)},
		}
	}
}

func defaultUpdateChannel() updateChannel {
	version := strings.ToLower(strings.TrimSpace(getCurrentVersion()))
	if strings.HasPrefix(version, "dev-") {
		return updateChannelDev
	}
	return updateChannelLatest
}

func updateChannelMetadataPath(configDir string) string {
	return filepath.Join(configDir, updateChannelFileName)
}

func (a *App) loadStoredUpdateChannel() (updateChannel, error) {
	if strings.TrimSpace(a.configDir) == "" {
		a.configDir = resolveAppConfigDir()
	}

	data, err := os.ReadFile(updateChannelMetadataPath(a.configDir))
	if err != nil {
		return "", err
	}

	var state updateChannelStateFile
	if err := json.Unmarshal(data, &state); err != nil {
		return "", err
	}
	return normalizeUpdateChannel(string(state.Channel))
}

func (a *App) persistUpdateChannel(channel updateChannel) error {
	if strings.TrimSpace(a.configDir) == "" {
		a.configDir = resolveAppConfigDir()
	}
	if err := os.MkdirAll(a.configDir, 0o755); err != nil {
		return err
	}

	payload, err := json.MarshalIndent(updateChannelStateFile{Channel: channel}, "", "  ")
	if err != nil {
		return err
	}

	// 先写临时文件再重命名，避免进程中断留下损坏的 JSON。
	target := updateChannelMetadataPath(a.configDir)
	tmp := target + ".tmp"
	if err := os.WriteFile(tmp, payload, 0o644); err != nil {
		return err
	}
	if err := os.Rename(tmp, target); err != nil {
		_ = os.Remove(tmp)
		return err
	}
	return nil
}

func (a *App) currentUpdateChannel() updateChannel {
	if a == nil {
		return defaultUpdateChannel()
	}
	channel, err := a.loadStoredUpdateChannel()
	if err == nil {
		return channel
	}
	if !os.IsNotExist(err) {
		logger.Error(err, "加载更新通道配置失败")
	}
	return defaultUpdateChannel()
}

func (a *App) GetUpdateChannel() connection.QueryResult {
	channel := a.currentUpdateChannel()
	return connection.QueryResult{
		Success: true,
		Message: "OK",
		Data: map[string]any{
			"channel":     string(channel),
			"installMode": string(updateResolveInstallMode()),
		},
	}
}

func (a *App) SetUpdateChannel(channel string) connection.QueryResult {
	normalized, err := normalizeUpdateChannel(channel)
	if err != nil {
		return connection.QueryResult{Success: false, Message: a.localizedUpdateError(err)}
	}

	// 检查、持久化与缓存清理必须在同一临界区内完成，
	// 否则窗口期内启动的下载会把旧通道的安装包写回缓存。
	a.updateMu.Lock()
	defer a.updateMu.Unlock()
	if a.updateState.downloading {
		return connection.QueryResult{
			Success: false,
			Message: a.appText("app.update.backend.message.channel_change_blocked_downloading", nil),
		}
	}

	if err := a.persistUpdateChannel(normalized); err != nil {
		logger.Error(err, "保存更新通道失败")
		return connection.QueryResult{
			Success: false,
			Message: a.appText("app.update.backend.message.channel_change_failed", map[string]any{"detail": err.Error()}),
		}
	}

	a.updateState.lastCheck = nil
	a.updateState.staged = nil
	a.updateState.revision++
	a.markCloudBackupDirty()

	return connection.QueryResult{
		Success: true,
		Message: a.appText("app.update.backend.message.channel_changed", map[string]any{"channel": string(normalized)}),
		Data: map[string]any{
			"channel":     string(normalized),
			"installMode": string(updateResolveInstallMode()),
		},
	}
}
