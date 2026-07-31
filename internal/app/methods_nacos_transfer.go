package app

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"

	"GoNavi-Wails/internal/connection"
	"GoNavi-Wails/internal/logger"
	"GoNavi-Wails/internal/nacos"

	"github.com/wailsapp/wails/v2/pkg/runtime"
)

type nacosImportPreviewItem struct {
	Index    int    `json:"index"`
	DataID   string `json:"dataId"`
	Group    string `json:"group"`
	Type     string `json:"type,omitempty"`
	Exists   bool   `json:"exists"`
	Selected bool   `json:"selected"`
}

type nacosConfigIdentityKey struct {
	group  string
	dataID string
}

type nacosImportPreview struct {
	File          string                   `json:"file"`
	ExportedAt    string                   `json:"exportedAt,omitempty"`
	NamespaceID   string                   `json:"namespaceId,omitempty"`
	SourceAppName string                   `json:"sourceAppName,omitempty"`
	Total         int                      `json:"total"`
	ExistsCount   int                      `json:"existsCount"`
	NewCount      int                      `json:"newCount"`
	Items         []nacosImportPreviewItem `json:"items"`
}

// NacosExportConfigs exports configs from a namespace to a JSON file.
func (a *App) NacosExportConfigs(config connection.ConnectionConfig, options NacosExportConfigsOptions) connection.QueryResult {
	config.Type = "nacos"
	scope := strings.ToLower(strings.TrimSpace(options.Scope))
	if scope == "" {
		scope = "all"
	}
	namespaceID := strings.TrimSpace(options.NamespaceID)
	namespaceName := strings.TrimSpace(options.NamespaceName)
	if namespaceName == "" {
		if namespaceID == "" {
			namespaceName = "public"
		} else {
			namespaceName = namespaceID
		}
	}

	defaultName := fmt.Sprintf("nacos-%s-configs.json", sanitizeNacosFilename(namespaceName))
	if scope == "selected" {
		defaultName = fmt.Sprintf("nacos-%s-selected-configs.json", sanitizeNacosFilename(namespaceName))
	}
	filename, err := runtime.SaveFileDialog(a.ctx, runtime.SaveDialogOptions{
		Title:           a.appText("file.backend.dialog.export_data", nil),
		DefaultFilename: defaultName,
		Filters: []runtime.FileFilter{
			{
				DisplayName: a.appText("file.backend.filter.json_files", nil),
				Pattern:     "*.json",
			},
		},
	})
	if err != nil || strings.TrimSpace(filename) == "" {
		return connection.QueryResult{Success: false, Message: "已取消"}
	}
	filename = normalizeNacosTransferFilename(filename)

	ctx, cancel := a.nacosOperationContext(config)
	defer cancel()
	client, err := a.getNacosClientWithContext(ctx, config)
	if err != nil {
		return connection.QueryResult{Success: false, Message: err.Error()}
	}

	entries, err := collectNacosExportEntries(ctx, client, namespaceID, scope, options)
	if err != nil {
		return connection.QueryResult{Success: false, Message: err.Error()}
	}
	if len(entries) == 0 {
		return connection.QueryResult{Success: false, Message: a.appText("nacos.backend.error.export_empty", nil)}
	}

	payload := nacos.NewTransferFile(namespaceID, namespaceName)
	payload.Configs = entries
	if err := nacos.WriteTransferFile(filename, payload); err != nil {
		return connection.QueryResult{Success: false, Message: a.appText("file.backend.error.write_failed", map[string]any{"detail": err.Error()})}
	}
	logger.Infof("Nacos 配置导出成功：ns=%s count=%d file=%s", namespaceName, len(entries), filename)
	return connection.QueryResult{
		Success: true,
		Message: a.appText("nacos.backend.message.export_success", nil),
		Data: map[string]any{
			"exported": len(entries),
			"file":     filename,
		},
	}
}

// NacosPreviewImportConfigs opens a file and previews import conflicts.
func (a *App) NacosPreviewImportConfigs(config connection.ConnectionConfig, namespaceID string) connection.QueryResult {
	config.Type = "nacos"
	selection, err := a.openNacosImportTransferFileDialog()
	if err != nil {
		return connection.QueryResult{Success: false, Message: err.Error()}
	}
	if strings.TrimSpace(selection) == "" {
		return connection.QueryResult{Success: false, Message: "已取消"}
	}

	payload, err := nacos.ReadTransferFile(selection)
	if err != nil {
		if errors.Is(err, os.ErrNotExist) || errors.Is(err, os.ErrPermission) {
			return connection.QueryResult{Success: false, Message: a.appText("file.backend.error.open_file_failed", map[string]any{"detail": err.Error()})}
		}
		var syntaxErr *json.SyntaxError
		if errors.As(err, &syntaxErr) {
			return connection.QueryResult{Success: false, Message: a.appText("file.backend.error.import_json_parse_failed", map[string]any{"detail": err.Error()})}
		}
		return connection.QueryResult{Success: false, Message: err.Error()}
	}

	ctx, cancel := a.nacosOperationContext(config)
	defer cancel()
	client, err := a.getNacosClientWithContext(ctx, config)
	if err != nil {
		return connection.QueryResult{Success: false, Message: err.Error()}
	}

	preview, err := buildNacosImportPreview(ctx, client, selection, namespaceID, payload)
	if err != nil {
		return connection.QueryResult{Success: false, Message: err.Error()}
	}
	return connection.QueryResult{Success: true, Data: preview}
}

// NacosImportConfigs imports configs from a transfer file.
func (a *App) NacosImportConfigs(config connection.ConnectionConfig, options NacosImportConfigsOptions) connection.QueryResult {
	config.Type = "nacos"
	if err := a.ensureNacosDataImportAllowed(config); err != nil {
		return connection.QueryResult{Success: false, Message: err.Error()}
	}

	scope := strings.ToLower(strings.TrimSpace(options.Scope))
	selectedByIndex := make(map[int]nacosConfigIdentityKey, len(options.Items))
	selectedByIdentity := make(map[nacosConfigIdentityKey]struct{}, len(options.Items))
	invalidIndexedSelection := false
	for _, item := range options.Items {
		key, ok := normalizeNacosConfigIdentityKey(item.Group, item.DataID)
		if !ok {
			continue
		}
		if item.Index == nil {
			selectedByIdentity[key] = struct{}{}
			continue
		}
		if *item.Index < 0 {
			continue
		}
		if existing, exists := selectedByIndex[*item.Index]; exists && existing != key {
			invalidIndexedSelection = true
		}
		selectedByIndex[*item.Index] = key
	}
	if scope == "selected" && len(selectedByIndex)+len(selectedByIdentity) == 0 {
		return connection.QueryResult{
			Success: false,
			Message: a.appText("nacos.backend.error.import_selection_required", nil),
		}
	}

	selection := strings.TrimSpace(options.File)
	var err error
	if selection == "" {
		selection, err = a.openNacosImportTransferFileDialog()
		if err != nil {
			return connection.QueryResult{Success: false, Message: err.Error()}
		}
	}
	if strings.TrimSpace(selection) == "" {
		return connection.QueryResult{Success: false, Message: "已取消"}
	}

	payload, err := nacos.ReadTransferFile(selection)
	if err != nil {
		return connection.QueryResult{Success: false, Message: err.Error()}
	}

	useSelected := scope == "selected"
	if useSelected && (invalidIndexedSelection ||
		!nacosImportSelectionMatchesPayload(payload.Configs, selectedByIndex, selectedByIdentity)) {
		return connection.QueryResult{
			Success: false,
			Message: a.appText("nacos.backend.error.import_selection_required", nil),
		}
	}

	ctx, cancel := a.nacosOperationContext(config)
	defer cancel()
	client, err := a.getNacosClientWithContext(ctx, config)
	if err != nil {
		return connection.QueryResult{Success: false, Message: err.Error()}
	}

	conflictMode := strings.ToLower(strings.TrimSpace(options.ConflictMode))
	if conflictMode != "overwrite" {
		conflictMode = "skip"
	}

	imported := 0
	skipped := 0
	failed := 0
	var firstErr error
	namespaceID := strings.TrimSpace(options.NamespaceID)

	for index, item := range payload.Configs {
		key, validIdentity := normalizeNacosConfigIdentityKey(item.Group, item.DataID)
		if useSelected && (!validIdentity ||
			!nacosImportRowSelected(index, key, selectedByIndex, selectedByIdentity)) {
			continue
		}
		exists, existsErr := nacosConfigExists(ctx, client, namespaceID, item.Group, item.DataID)
		if existsErr != nil {
			failed++
			if firstErr == nil {
				firstErr = existsErr
			}
			continue
		}
		if exists && conflictMode == "skip" {
			skipped++
			continue
		}
		if err := client.PublishConfig(ctx, nacos.PublishRequest{
			NamespaceID: namespaceID,
			DataID:      item.DataID,
			Group:       item.Group,
			Content:     item.Content,
			Type:        item.Type,
			AppName:     item.AppName,
			Desc:        item.Desc,
		}); err != nil {
			failed++
			if firstErr == nil {
				firstErr = err
			}
			continue
		}
		imported++
	}

	resultData := map[string]any{
		"imported": imported,
		"skipped":  skipped,
		"failed":   failed,
		"file":     selection,
	}
	logger.Infof("Nacos 配置导入完成：imported=%d skipped=%d failed=%d file=%s", imported, skipped, failed, selection)
	if failed > 0 {
		detail := ""
		if firstErr != nil {
			detail = firstErr.Error()
		}
		return connection.QueryResult{
			Success: false,
			Message: a.appText("nacos.backend.error.import_partial_failed", map[string]any{
				"imported": imported,
				"skipped":  skipped,
				"failed":   failed,
				"detail":   detail,
			}),
			Data: resultData,
		}
	}
	return connection.QueryResult{
		Success: true,
		Message: a.appText("nacos.backend.message.import_success", nil),
		Data:    resultData,
	}
}

func (a *App) openNacosImportTransferFileDialog() (string, error) {
	return runtime.OpenFileDialog(a.ctx, runtime.OpenDialogOptions{
		Title: a.appText("file.backend.dialog.import_data", map[string]any{"table": "nacos"}),
		Filters: []runtime.FileFilter{
			{
				DisplayName: a.appText("file.backend.filter.json_files", nil),
				Pattern:     "*.json",
			},
			{
				DisplayName: a.appText("file.backend.filter.all_files", nil),
				Pattern:     "*",
			},
		},
	})
}

func collectNacosExportEntries(
	ctx context.Context,
	client nacos.Client,
	namespaceID, scope string,
	options NacosExportConfigsOptions,
) ([]nacos.TransferConfigEntry, error) {
	if scope == "selected" {
		entries := make([]nacos.TransferConfigEntry, 0, len(options.Items))
		for _, item := range options.Items {
			dataID := strings.TrimSpace(item.DataID)
			group := strings.TrimSpace(item.Group)
			if dataID == "" {
				continue
			}
			if group == "" {
				group = "DEFAULT_GROUP"
			}
			detail, err := client.GetConfig(ctx, namespaceID, group, dataID)
			if err != nil {
				return nil, err
			}
			entries = append(entries, nacos.TransferConfigEntry{
				DataID:  detail.DataID,
				Group:   detail.Group,
				Content: detail.Content,
				Type:    detail.Type,
				AppName: detail.AppName,
				Desc:    detail.Desc,
			})
		}
		return entries, nil
	}

	// Export all: page through search API then fetch each content.
	const pageSize = 100
	pageNo := 1
	entries := make([]nacos.TransferConfigEntry, 0, 64)
	seen := make(map[nacosConfigIdentityKey]struct{})
	for {
		page, err := client.SearchConfigs(ctx, nacos.ConfigQuery{
			NamespaceID: namespaceID,
			PageNo:      pageNo,
			PageSize:    pageSize,
			Search:      "blur",
		})
		if err != nil {
			return nil, err
		}
		if page == nil || len(page.PageItems) == 0 {
			break
		}
		for _, item := range page.PageItems {
			key, validIdentity := normalizeNacosConfigIdentityKey(item.Group, item.DataID)
			if !validIdentity {
				continue
			}
			if _, ok := seen[key]; ok {
				continue
			}
			seen[key] = struct{}{}
			// Prefer content from list if present; otherwise fetch.
			content := item.Content
			typ := item.Type
			appName := item.AppName
			desc := item.Desc
			if strings.TrimSpace(content) == "" {
				detail, getErr := client.GetConfig(ctx, namespaceID, item.Group, item.DataID)
				if getErr != nil {
					return nil, getErr
				}
				content = detail.Content
				if typ == "" {
					typ = detail.Type
				}
				if appName == "" {
					appName = detail.AppName
				}
				if desc == "" {
					desc = detail.Desc
				}
			}
			entries = append(entries, nacos.TransferConfigEntry{
				DataID:  item.DataID,
				Group:   item.Group,
				Content: content,
				Type:    typ,
				AppName: appName,
				Desc:    desc,
			})
		}
		if pageNo >= page.PagesAvailable || len(page.PageItems) < pageSize {
			break
		}
		pageNo++
		// safety cap
		if pageNo > 200 {
			break
		}
	}
	return entries, nil
}

func buildNacosImportPreview(
	ctx context.Context,
	client nacos.Client,
	file, namespaceID string,
	payload nacos.TransferFile,
) (nacosImportPreview, error) {
	items := make([]nacosImportPreviewItem, 0, len(payload.Configs))
	existsCount := 0
	for index, cfg := range payload.Configs {
		exists, err := nacosConfigExists(ctx, client, namespaceID, cfg.Group, cfg.DataID)
		if err != nil {
			return nacosImportPreview{}, err
		}
		if exists {
			existsCount++
		}
		items = append(items, nacosImportPreviewItem{
			Index:    index,
			DataID:   cfg.DataID,
			Group:    cfg.Group,
			Type:     cfg.Type,
			Exists:   exists,
			Selected: true,
		})
	}
	return nacosImportPreview{
		File:          file,
		ExportedAt:    payload.ExportedAt,
		NamespaceID:   payload.NamespaceID,
		SourceAppName: payload.SourceAppName,
		Total:         len(items),
		ExistsCount:   existsCount,
		NewCount:      len(items) - existsCount,
		Items:         items,
	}, nil
}

func nacosConfigExists(ctx context.Context, client nacos.Client, namespaceID, group, dataID string) (bool, error) {
	// Use short timeout so preview remains responsive.
	probeCtx, cancel := context.WithTimeout(ctx, 8*time.Second)
	defer cancel()
	_, err := client.GetConfig(probeCtx, namespaceID, group, dataID)
	if err == nil {
		return true, nil
	}
	if nacos.IsConfigNotFound(err) {
		return false, nil
	}
	if status, ok := nacos.HTTPStatusCode(err); ok {
		if status == 404 {
			return false, nil
		}
		return false, err
	}
	// Compatibility fallback for errors produced before structured status and
	// not-found types were introduced. Match complete localized prefixes only.
	msg := strings.ToLower(strings.TrimSpace(err.Error()))
	if status, ok := explicitNacosHTTPStatus(msg); ok {
		if status == 404 {
			return false, nil
		}
		return false, err
	}
	for _, prefix := range []string{
		"config not found:",
		"配置不存在：",
		"設定不存在：",
		"設定が見つかりません:",
		"konfiguration nicht gefunden:",
		"конфигурация не найдена:",
	} {
		if strings.HasPrefix(msg, prefix) {
			return false, nil
		}
	}
	return false, err
}

func explicitNacosHTTPStatus(message string) (int, bool) {
	markers := []string{
		"nacos http",
		"nacos-http-fehler",
		"http nacos",
	}
	for _, marker := range markers {
		index := strings.Index(message, marker)
		if index < 0 {
			continue
		}
		rest := message[index+len(marker):]
		start := -1
		for index, char := range rest {
			if char >= '0' && char <= '9' {
				start = index
				break
			}
		}
		if start < 0 {
			return 0, false
		}
		end := start
		for end < len(rest) && rest[end] >= '0' && rest[end] <= '9' {
			end++
		}
		if end-start != 3 {
			return 0, false
		}
		status, err := strconv.Atoi(rest[start:end])
		if err != nil || status < 100 || status > 599 {
			return 0, false
		}
		return status, true
	}
	return 0, false
}

func normalizeNacosConfigIdentityKey(group, dataID string) (nacosConfigIdentityKey, bool) {
	dataID = strings.TrimSpace(dataID)
	if dataID == "" {
		return nacosConfigIdentityKey{}, false
	}
	group = strings.TrimSpace(group)
	if group == "" {
		group = "DEFAULT_GROUP"
	}
	return nacosConfigIdentityKey{group: group, dataID: dataID}, true
}

func nacosImportSelectionMatchesPayload(
	configs []nacos.TransferConfigEntry,
	selectedByIndex map[int]nacosConfigIdentityKey,
	selectedByIdentity map[nacosConfigIdentityKey]struct{},
) bool {
	for index, selectedKey := range selectedByIndex {
		if index < 0 || index >= len(configs) {
			return false
		}
		payloadKey, ok := normalizeNacosConfigIdentityKey(configs[index].Group, configs[index].DataID)
		if !ok || payloadKey != selectedKey {
			return false
		}
	}
	for selectedKey := range selectedByIdentity {
		matched := false
		for _, config := range configs {
			payloadKey, ok := normalizeNacosConfigIdentityKey(config.Group, config.DataID)
			if ok && payloadKey == selectedKey {
				matched = true
				break
			}
		}
		if !matched {
			return false
		}
	}
	return true
}

func nacosImportRowSelected(
	index int,
	key nacosConfigIdentityKey,
	selectedByIndex map[int]nacosConfigIdentityKey,
	selectedByIdentity map[nacosConfigIdentityKey]struct{},
) bool {
	if selectedKey, ok := selectedByIndex[index]; ok && selectedKey == key {
		return true
	}
	_, ok := selectedByIdentity[key]
	return ok
}

func (a *App) ensureNacosDataImportAllowed(config connection.ConnectionConfig) error {
	if config.ReadOnly {
		return errors.New(a.appText("nacos.backend.error.read_only", nil))
	}
	if config.Protection.RestrictDataImport {
		return errors.New(readOnlyConnectionActionBlockedMessageWithText(
			"connection.backend.action.import_data",
			a.appText,
		))
	}
	return nil
}

func normalizeNacosTransferFilename(filename string) string {
	trimmed := strings.TrimSpace(filename)
	if trimmed == "" {
		return ""
	}
	if strings.EqualFold(filepath.Ext(trimmed), ".json") {
		return trimmed
	}
	return trimmed + ".json"
}

func sanitizeNacosFilename(raw string) string {
	text := strings.TrimSpace(raw)
	if text == "" {
		return "namespace"
	}
	replacer := strings.NewReplacer("/", "-", "\\", "-", ":", "-", " ", "_")
	return replacer.Replace(text)
}
