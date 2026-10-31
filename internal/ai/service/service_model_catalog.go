package aiservice

import (
	"context"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"GoNavi-Wails/internal/ai"
	"GoNavi-Wails/internal/ai/modelsdev"
	"GoNavi-Wails/internal/logger"
)

const (
	// modelCatalogDirName / modelCatalogFileName 决定公共目录落在配置目录下的位置。
	modelCatalogDirName  = "model-catalog"
	modelCatalogFileName = "models-dev.json"
	// modelCatalogMaxIDs 限制单次补全的模型数，避免异常输入把绑定调用拖长。
	modelCatalogMaxIDs = 500
	// modelCatalogFirstLoadTimeout 是“本地还没有副本”时的同步拉取上限：
	// 拿不到就先不给名称，不让设置页跟着网络一起卡住。
	modelCatalogFirstLoadTimeout = 8 * time.Second
	// modelCatalogWarmTimeout 是启动预热的上限。
	modelCatalogWarmTimeout = 30 * time.Second
)

// modelCatalogSource 是公共目录地址；测试指向本地服务，生产用 models.dev。
var modelCatalogSource = modelsdev.DefaultSource

// ModelCatalogEntry 是公共目录补全后的一个模型：名称与上下文窗口都可能缺省。
type ModelCatalogEntry struct {
	ID            string `json:"id"`
	Name          string `json:"name"`
	ContextWindow int    `json:"contextWindow"`
}

// modelCatalogHolder 是公共目录的懒加载状态：配置目录在启动后才确定，
// 数据根目录迁移时按新目录重建，本地副本跟着走。
type modelCatalogHolder struct {
	mu    sync.Mutex
	store *modelsdev.Store
	dir   string
}

// AIResolveModelCatalog 用 models.dev 公共目录补全模型 ID 的展示名称与上下文窗口。
//
// 内置供应商与插件供应商共用这一份目录：插件扫描出的网关 ID、上游 /models 返回的
// ID 都通过这里换成人类可读的名称与真实窗口，前端不再直连 models.dev。
// 目录缺失只是少一层增强：此时 available=false，调用方继续用原始 ID。
func (s *Service) AIResolveModelCatalog(models []string) map[string]interface{} {
	ids := normalizeCatalogModelIDs(models)
	if len(ids) == 0 {
		return map[string]interface{}{"success": true, "available": false, "entries": []ModelCatalogEntry{}, "total": 0, "matched": 0}
	}
	ctx, cancel := context.WithTimeout(context.Background(), modelCatalogFirstLoadTimeout)
	defer cancel()
	catalog, err := s.loadModelCatalog(ctx)
	if err != nil {
		localizer := s.serviceLocalizerForLanguage()
		return map[string]interface{}{
			"success":   false,
			"available": false,
			"entries":   []ModelCatalogEntry{},
			"total":     len(ids),
			"matched":   0,
			"error":     serviceTextFromLocalizer(localizer, "ai_service.backend.error.model_catalog_unavailable", map[string]any{"detail": err.Error()}),
		}
	}
	entries := make([]ModelCatalogEntry, 0, len(ids))
	for _, resolved := range catalog.Resolve(ids) {
		if !resolved.Found {
			continue
		}
		entries = append(entries, ModelCatalogEntry{ID: resolved.ID, Name: resolved.Name, ContextWindow: resolved.ContextWindow})
	}
	return map[string]interface{}{
		"success":   true,
		"available": true,
		"stale":     s.modelCatalogStore().IsStale(catalog),
		"fetchedAt": catalog.FetchedAt().UTC().Format(time.RFC3339),
		"entries":   entries,
		"total":     len(ids),
		"matched":   len(entries),
	}
}

// WarmModelCatalog 在后台准备公共目录，避免设置页第一次打开时才联网。
// 预热失败不影响任何功能：调用方仍会退回原始模型 ID。
func WarmModelCatalog(s *Service) {
	if s == nil {
		return
	}
	go func() {
		ctx, cancel := context.WithTimeout(context.Background(), modelCatalogWarmTimeout)
		defer cancel()
		if _, err := s.loadModelCatalog(ctx); err != nil {
			logger.Warnf("预热 models.dev 公共目录失败：%v", err)
		}
	}()
}

// loadModelCatalog 返回当前公共目录，需要时装载本地副本或联网；
// 装载成功后同时注入 ai 包，让内置供应商的上下文窗口解析一起用上。
func (s *Service) loadModelCatalog(ctx context.Context) (*modelsdev.Catalog, error) {
	catalog, err := s.modelCatalogStore().Load(ctx)
	if err != nil {
		return nil, err
	}
	ai.SetModelContextCatalog(catalog)
	return catalog, nil
}

// modelCatalogStore 按当前配置目录懒建目录服务。
func (s *Service) modelCatalogStore() *modelsdev.Store {
	directory := s.modelCatalogConfigDir()
	s.modelCatalog.mu.Lock()
	defer s.modelCatalog.mu.Unlock()
	if s.modelCatalog.store != nil && s.modelCatalog.dir == directory {
		return s.modelCatalog.store
	}
	path := ""
	if directory != "" {
		path = filepath.Join(directory, modelCatalogDirName, modelCatalogFileName)
	}
	s.modelCatalog.store = modelsdev.NewStore(modelsdev.Options{Path: path, Source: modelCatalogSource})
	s.modelCatalog.dir = directory
	return s.modelCatalog.store
}

func (s *Service) modelCatalogConfigDir() string {
	s.mu.RLock()
	directory := s.configDir
	s.mu.RUnlock()
	if strings.TrimSpace(directory) != "" {
		return directory
	}
	return resolveConfigDir()
}

// normalizeCatalogModelIDs 去掉空白与重复项，并限制单次数量。
func normalizeCatalogModelIDs(models []string) []string {
	ids := make([]string, 0, len(models))
	seen := make(map[string]struct{}, len(models))
	for _, model := range models {
		id := strings.TrimSpace(model)
		if id == "" || len(id) > 256 {
			continue
		}
		key := strings.ToLower(id)
		if _, ok := seen[key]; ok {
			continue
		}
		seen[key] = struct{}{}
		ids = append(ids, id)
		if len(ids) >= modelCatalogMaxIDs {
			break
		}
	}
	return ids
}
