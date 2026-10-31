package app

// 本文件是智能体接入的持久化：数据根下 agents.json 记录已添加的
// 智能体（每工具一实例）。写安全模式照 saved_connections 先例：
// 包级互斥锁（防 Wails 并发 goroutine 整体覆盖）+ 跨进程文件锁 +
// 原子写（临时文件 + Sync + rename）。

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"GoNavi-Wails/internal/appdata"
	"GoNavi-Wails/internal/logger"
)

// agentIntegrationsMu 串行化单进程内 agents.json 的读改写序列。
// 必须是包级锁（与 savedConnectionsMu 同理：每调用一个新仓库实例）。
var agentIntegrationsMu sync.Mutex

const agentIntegrationsFileName = "agents.json"

// AgentIntegration 是一个已添加的智能体实例：工具类型 + 扫描数据目录。
// 每工具最多一个实例（同 kind 重复添加被拒绝）。
type AgentIntegration struct {
	Kind    string `json:"kind"`
	DataDir string `json:"dataDir"`
	// DisplayName 是展示名（ChatGPT / Claude Code），随 kind 确定。
	DisplayName string `json:"displayName"`
	AddedAt     int64  `json:"addedAt"`
}

type agentIntegrationsFile struct {
	Integrations []AgentIntegration `json:"integrations"`
}

func agentIntegrationsPath() string {
	return filepath.Join(appdata.MustResolveActiveRoot(), agentIntegrationsFileName)
}

// ListAgentIntegrations 返回已添加的智能体列表。
func (a *App) ListAgentIntegrations() ([]AgentIntegration, error) {
	agentIntegrationsMu.Lock()
	defer agentIntegrationsMu.Unlock()
	return loadAgentIntegrations()
}

// AddAgentIntegration 添加智能体实例。同 kind 已存在时报错（每工具
// 一实例）；返回添加后的实例。
func (a *App) AddAgentIntegration(kind, dataDir, displayName string) (AgentIntegration, error) {
	agentIntegrationsMu.Lock()
	defer agentIntegrationsMu.Unlock()

	normalized := strings.ToLower(strings.TrimSpace(kind))
	if normalized == "" {
		return AgentIntegration{}, errors.New("agent kind is required")
	}
	dataDirTrimmed := strings.TrimSpace(dataDir)
	if dataDirTrimmed == "" {
		return AgentIntegration{}, errors.New("agent data dir is required")
	}
	absolute, err := filepath.Abs(dataDirTrimmed)
	if err != nil {
		return AgentIntegration{}, fmt.Errorf("resolve data dir: %w", err)
	}
	existing, err := loadAgentIntegrations()
	if err != nil {
		return AgentIntegration{}, err
	}
	for _, item := range existing {
		if item.Kind == normalized {
			return AgentIntegration{}, fmt.Errorf("agent %s already added", normalized)
		}
	}
	added := AgentIntegration{
		Kind:        normalized,
		DataDir:     absolute,
		DisplayName: strings.TrimSpace(displayName),
		AddedAt:     time.Now().Unix(),
	}
	if added.DisplayName == "" {
		added.DisplayName = defaultAgentDisplayName(normalized)
	}
	existing = append(existing, added)
	if err := saveAgentIntegrations(existing); err != nil {
		return AgentIntegration{}, err
	}
	return added, nil
}

// RemoveAgentIntegration 移除已添加的智能体（只删配置，不触碰
// 工具自身的 CLI 数据）。未知 kind 报错。
func (a *App) RemoveAgentIntegration(kind string) error {
	agentIntegrationsMu.Lock()
	defer agentIntegrationsMu.Unlock()

	normalized := strings.ToLower(strings.TrimSpace(kind))
	existing, err := loadAgentIntegrations()
	if err != nil {
		return err
	}
	kept := existing[:0]
	found := false
	for _, item := range existing {
		if strings.ToLower(strings.TrimSpace(item.Kind)) == normalized {
			found = true
			continue
		}
		kept = append(kept, item)
	}
	if !found {
		return fmt.Errorf("agent %s is not added", normalized)
	}
	return saveAgentIntegrations(kept)
}

// UpdateAgentIntegration 更新已添加智能体的数据目录与展示名。未知 kind
// 报错；空参数表示保留原值。只改配置，不触碰工具自身的会话数据。
func (a *App) UpdateAgentIntegration(kind, dataDir, displayName string) (AgentIntegration, error) {
	agentIntegrationsMu.Lock()
	defer agentIntegrationsMu.Unlock()

	normalized := strings.ToLower(strings.TrimSpace(kind))
	if normalized == "" {
		return AgentIntegration{}, errors.New("agent kind is required")
	}
	absolute := ""
	if trimmed := strings.TrimSpace(dataDir); trimmed != "" {
		resolved, err := filepath.Abs(trimmed)
		if err != nil {
			return AgentIntegration{}, fmt.Errorf("resolve data dir: %w", err)
		}
		absolute = resolved
	}
	existing, err := loadAgentIntegrations()
	if err != nil {
		return AgentIntegration{}, err
	}
	updated := make([]AgentIntegration, 0, len(existing))
	var target AgentIntegration
	found := false
	for _, item := range existing {
		if strings.ToLower(strings.TrimSpace(item.Kind)) != normalized {
			updated = append(updated, item)
			continue
		}
		found = true
		if absolute != "" {
			item.DataDir = absolute
		}
		if name := strings.TrimSpace(displayName); name != "" {
			item.DisplayName = name
		}
		target = item
		updated = append(updated, item)
	}
	if !found {
		return AgentIntegration{}, fmt.Errorf("agent %s is not added", normalized)
	}
	if err := saveAgentIntegrations(updated); err != nil {
		return AgentIntegration{}, err
	}
	return target, nil
}

// defaultAgentDisplayName 工具展示名兜底。
func defaultAgentDisplayName(kind string) string {
	switch kind {
	case "codex":
		return "ChatGPT"
	case "claude":
		return "Claude Code"
	}
	return kind
}

// loadAgentIntegrations 读 agents.json；文件不存在返回空列表。
// 调用方需持有 agentIntegrationsMu（只读路径同样走锁防读到半截写）。
func loadAgentIntegrations() ([]AgentIntegration, error) {
	path := agentIntegrationsPath()
	data, err := os.ReadFile(path)
	if err != nil {
		if os.IsNotExist(err) {
			return []AgentIntegration{}, nil
		}
		return nil, fmt.Errorf("read agent integrations: %w", err)
	}
	var file agentIntegrationsFile
	if err := json.Unmarshal(data, &file); err != nil {
		// 配置损坏不静默丢弃：返回错误让绑定层给用户可见信息。
		return nil, fmt.Errorf("parse agent integrations: %w", err)
	}
	if file.Integrations == nil {
		// Go nil slice 序列化为 JSON null；前端按数组消费，这里归一。
		return []AgentIntegration{}, nil
	}
	return file.Integrations, nil
}

// saveAgentIntegrations 原子写 agents.json。调用方需持有 agentIntegrationsMu。
func saveAgentIntegrations(integrations []AgentIntegration) error {
	configDir := appdata.MustResolveActiveRoot()
	if err := os.MkdirAll(configDir, 0o755); err != nil {
		return err
	}
	sharedLock, err := appdata.AcquireFileLock(appdata.SharedStorageLockPath(configDir))
	if err != nil {
		return err
	}
	defer sharedLock.Close()
	fileLock, err := appdata.AcquireFileLock(agentIntegrationsPath() + ".lock")
	if err != nil {
		return err
	}
	defer fileLock.Close()

	payload, err := json.MarshalIndent(agentIntegrationsFile{Integrations: integrations}, "", "  ")
	if err != nil {
		return err
	}
	return writeAgentIntegrationsFileAtomic(agentIntegrationsPath(), payload)
}

// writeAgentIntegrationsFileAtomic 临时文件 + Sync + rename 原子替换
// （复用 saved_queries 的 rename 回退逻辑，防 Windows rename 失败）。
func writeAgentIntegrationsFileAtomic(targetPath string, payload []byte) error {
	dir := filepath.Dir(targetPath)
	temp, err := os.CreateTemp(dir, ".agents_*.tmp")
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
	if err := replaceSavedQueryTempFile(tempPath, targetPath); err != nil {
		return err
	}
	cleanup = false
	return nil
}

// removeLegacySessionAssetsData 清理旧 session-assets 保全链测试残留
// （catalog.sqlite + 材料库副本）。旧方案从未上线，数据根下的目录是
// 本机测试产物，新版启动时静默删除。
func removeLegacySessionAssetsData() {
	legacy := filepath.Join(appdata.MustResolveActiveRoot(), "session-assets")
	info, err := os.Stat(legacy)
	if err != nil || !info.IsDir() {
		return
	}
	if err := os.RemoveAll(legacy); err != nil {
		logger.Warnf("清理旧会话保全数据失败（可手动删除 %s）：%v", legacy, err)
		return
	}
	logger.Infof("已清理旧会话保全数据目录：%s", legacy)
}
