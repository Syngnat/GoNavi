package app

import (
	"context"
	"errors"
	"net/url"
	"sort"
	"strings"

	"GoNavi-Wails/internal/ai"
	aiservice "GoNavi-Wails/internal/ai/service"
)

// 导入能力的入参上限。与 docs/CONTRACT.md 第 2 节一致：单批最多 100 条，字段长度在这里
// 再收紧一次，避免插件用一个超长名字把供应商列表撑成大对象。
const (
	pluginAIProviderImportMaxItems   = 100
	pluginAIProviderImportNameMax    = 128
	pluginAIProviderImportBaseURLMax = 512
	pluginAIProviderImportModelMax   = 200
	pluginAIProviderImportModelsMax  = 64
	pluginAIProviderImportAPIKeyMax  = 4096
	pluginAIProviderImportHeadersMax = 16
	pluginAIProviderImportHeaderMax  = 256
	// 单个请求头值的上限：Authorization 里的 JWT 动辄几百到上千字节，256 太小，早期版本因此
	// 静默丢头（导入成功却鉴权头为空）。键名仍限 256，值放宽到 4096。
	pluginAIProviderImportHeaderValueMax = 4096
	// 回显名称的边界：入参名字只受 MaxArgsBytes 约束，原样回显会让一条超长名字撑破结果上限。
	pluginAIProviderImportEchoNameMaxRunes = 64
	pluginAIProviderImportEchoNameMaxBytes = 192
	pluginAIProviderImportMaxResultBytes   = 64 << 10
	pluginAIProviderImportTempMin          = 0
	pluginAIProviderImportTempMax          = 2
)

const (
	pluginAIProviderImportStatusImported = "imported"
	pluginAIProviderImportStatusSkipped  = "skipped"
	pluginAIProviderImportStatusFailed   = "failed"

	pluginAIProviderImportReasonDuplicate      = "duplicate"
	pluginAIProviderImportReasonInvalidName    = "invalid_name"
	pluginAIProviderImportReasonInvalidBaseURL = "invalid_base_url"
	pluginAIProviderImportReasonInvalidFormat  = "invalid_api_format"
	pluginAIProviderImportReasonSaveFailed     = "save_failed"
	pluginAIProviderImportReasonInvalidAPIKey  = "invalid_api_key"
	pluginAIProviderImportReasonTooManyHeaders = "too_many_headers"
	pluginAIProviderImportReasonInvalidHeaders = "invalid_headers"
	pluginAIProviderImportReasonCancelled      = "cancelled"
)

// pluginAIProviderImportAPIFormats 是导入允许的协议集合。本机 CLI 协议（codex-cli、
// claude-cli、cursor-cli 等）不在此列：它们依赖本机已登录的 CLI，导入一条配置并不能让
// 它变成可用供应商，放进来只会产出看起来存在、实际调不通的条目。
var pluginAIProviderImportAPIFormats = map[string]bool{
	"openai":           true,
	"openai-responses": true,
	"anthropic":        true,
	"gemini":           true,
}

// AIProviderStore 是导入能力唯一的写入端口，由 cmd 层注入活动 AI Service。
// 不直接读写 ai_config.json：宿主把供应商缓存在内存、保存时整表回写，绕过 Service 的
// 写入会在下一次保存时被覆盖，用户只会看到导入白做一场。
type AIProviderStore interface {
	// ListProviders 返回当前供应商的元数据（含 ID、Name、BaseURL），用于本批判重。
	ListProviders() []ai.ProviderConfig
	// SaveProvider 写入或更新一条供应商，并返回落库后的记录（宿主会为新建条目生成 ID）。
	SaveProvider(config ai.ProviderConfig) (ai.ProviderConfig, error)
}

// NewAIServiceProviderStore 把活动 AI Service 适配成导入能力使用的写入端口。
func NewAIServiceProviderStore(service *aiservice.Service) AIProviderStore {
	return aiServiceProviderStore{service: service}
}

type aiServiceProviderStore struct {
	service *aiservice.Service
}

func (s aiServiceProviderStore) ListProviders() []ai.ProviderConfig {
	if s.service == nil {
		return nil
	}
	return s.service.AIGetProviders()
}

func (s aiServiceProviderStore) SaveProvider(config ai.ProviderConfig) (ai.ProviderConfig, error) {
	if s.service == nil {
		return ai.ProviderConfig{}, errors.New("ai service unavailable")
	}
	if err := s.service.AISaveProvider(config); err != nil {
		return ai.ProviderConfig{}, err
	}
	if strings.TrimSpace(config.ID) != "" {
		return config, nil
	}
	// 新建条目的 ID 由 Service 生成，插件要在结果里指回具体条目，因此按去重身份回读一次。
	for _, provider := range s.service.AIGetProviders() {
		if pluginAIProviderImportIdentity(provider.Name, provider.BaseURL) ==
			pluginAIProviderImportIdentity(config.Name, config.BaseURL) {
			return provider, nil
		}
	}
	return config, nil
}

// SetAIProviderStore 注入导入能力的写入端口。由进程入口在创建活动 AI Service 之后调用；
// 未注入时能力返回 internal，不做「直接改配置文件」的降级。
func (a *App) SetAIProviderStore(store AIProviderStore) {
	if a == nil {
		return
	}
	a.aiProviderStoreMu.Lock()
	a.aiProviderStore = store
	a.aiProviderStoreMu.Unlock()
}

func (a *App) aiProviderStorePort() AIProviderStore {
	if a == nil {
		return nil
	}
	a.aiProviderStoreMu.RLock()
	defer a.aiProviderStoreMu.RUnlock()
	return a.aiProviderStore
}

type pluginAIProviderImportItem struct {
	Name        string            `json:"name"`
	BaseURL     string            `json:"baseUrl"`
	APIFormat   string            `json:"apiFormat"`
	Model       string            `json:"model"`
	Models      []string          `json:"models"`
	APIKey      string            `json:"apiKey"`
	Headers     map[string]string `json:"headers"`
	Temperature float64           `json:"temperature"`
	Overwrite   bool              `json:"overwrite"`
}

type pluginAIProviderImportRequest struct {
	Providers []pluginAIProviderImportItem `json:"providers"`
}

// pluginAIProviderImportEntry 是逐条结果。它只带条目名与 ID，绝不回带密钥、请求头或地址
// 里的凭据，避免插件页把刚导入的凭据又读回去。
type pluginAIProviderImportEntry struct {
	Index      int    `json:"index"`
	Name       string `json:"name"`
	Status     string `json:"status"`
	ProviderID string `json:"providerId"`
	Reason     string `json:"reason"`
}

type pluginAIProviderImportResult struct {
	Imported int `json:"imported"`
	Skipped  int `json:"skipped"`
	Failed   int `json:"failed"`
	// Cancelled 表示这一批在写入过程中被取消（超时、插件停用、调用方收手）：items 里是取消前
	// 已经落地的部分结果。调用方据此知道「已经写进去几条」，而不是把整批当成没发生。
	Cancelled bool                          `json:"cancelled,omitempty"`
	Items     []pluginAIProviderImportEntry `json:"items"`
}

// pluginCapabilityAIProvidersImport 把结构化供应商写入宿主供应商列表。判重按「名称 + 归一化
// 地址」：命中且未要求覆盖即跳过，要求覆盖则复用原 ID 就地更新，绝不静默替换用户已有供应商。
// 单条失败只记该条，不中断整批——导入 93 条时不该因为其中一条地址非法而全军覆没。
func pluginCapabilityAIProvidersImport(ctx context.Context, a *App, request pluginCapabilityRequest) (any, string) {
	store := a.aiProviderStorePort()
	if store == nil {
		return nil, "internal"
	}
	var payload pluginAIProviderImportRequest
	if !decodePluginPageArguments(request.Arguments, &payload) {
		return nil, "invalid_arguments"
	}
	if len(payload.Providers) == 0 {
		return nil, "invalid_arguments"
	}
	if len(payload.Providers) > pluginAIProviderImportMaxItems {
		return nil, "too_many_providers"
	}

	index := make(map[string]string, len(payload.Providers))
	for _, provider := range store.ListProviders() {
		key := pluginAIProviderImportIdentity(provider.Name, provider.BaseURL)
		if key == "" {
			continue
		}
		if _, exists := index[key]; !exists {
			index[key] = strings.TrimSpace(provider.ID)
		}
	}

	result := pluginAIProviderImportResult{Items: make([]pluginAIProviderImportEntry, 0, len(payload.Providers))}
	for position, item := range payload.Providers {
		// 回显名必须截断（见 pluginAIProviderImportEchoName）：入参名字最长只受 MaxArgsBytes 约束。
		entry := pluginAIProviderImportEntry{Index: position, Name: pluginAIProviderImportEchoName(item.Name)}
		// 取消后不再写任何一条：调用方已经收手（超时、插件停用、页面关闭），继续写等于替它做决定。
		// 剩余条目照样补一条 cancelled 结果，保持「一个请求条目一条结果」，调用方才能逐条对账。
		if ctx.Err() != nil {
			result.Cancelled = true
			entry.Status = pluginAIProviderImportStatusFailed
			entry.Reason = pluginAIProviderImportReasonCancelled
			result.Failed++
			result.Items = append(result.Items, entry)
			continue
		}
		config, reason := pluginImportedProviderConfig(item)
		if reason != "" {
			entry.Status = pluginAIProviderImportStatusFailed
			entry.Reason = reason
			result.Failed++
			result.Items = append(result.Items, entry)
			continue
		}
		key := pluginAIProviderImportIdentity(config.Name, config.BaseURL)
		existingID := index[key]
		if existingID != "" && !item.Overwrite {
			entry.Status = pluginAIProviderImportStatusSkipped
			entry.Reason = pluginAIProviderImportReasonDuplicate
			result.Skipped++
			result.Items = append(result.Items, entry)
			continue
		}
		if existingID != "" {
			config.ID = existingID
		}
		saved, err := store.SaveProvider(config)
		if err != nil {
			entry.Status = pluginAIProviderImportStatusFailed
			entry.Reason = pluginAIProviderImportReasonSaveFailed
			result.Failed++
			result.Items = append(result.Items, entry)
			continue
		}
		entry.Status = pluginAIProviderImportStatusImported
		entry.ProviderID = strings.TrimSpace(saved.ID)
		if entry.ProviderID != "" {
			index[key] = entry.ProviderID
		}
		result.Imported++
		result.Items = append(result.Items, entry)
	}
	return result, ""
}

// pluginImportedProviderConfig 把一条导入项收敛成宿主供应商配置，并返回失败原因（空串表示
// 通过）。校验只做「能否成为一个可用供应商」这一件事，不猜测上游语义。
func pluginImportedProviderConfig(item pluginAIProviderImportItem) (ai.ProviderConfig, string) {
	name := strings.TrimSpace(item.Name)
	if name == "" || len(name) > pluginAIProviderImportNameMax {
		return ai.ProviderConfig{}, pluginAIProviderImportReasonInvalidName
	}
	baseURL, ok := pluginImportedProviderBaseURL(item.BaseURL)
	if !ok {
		return ai.ProviderConfig{}, pluginAIProviderImportReasonInvalidBaseURL
	}
	apiFormat := strings.TrimSpace(item.APIFormat)
	if !pluginAIProviderImportAPIFormats[apiFormat] {
		return ai.ProviderConfig{}, pluginAIProviderImportReasonInvalidFormat
	}
	if len(item.APIKey) > pluginAIProviderImportAPIKeyMax {
		return ai.ProviderConfig{}, pluginAIProviderImportReasonInvalidAPIKey
	}
	config := ai.ProviderConfig{
		Type:        "custom",
		Name:        name,
		AuthMode:    "api-key",
		APIKey:      item.APIKey,
		BaseURL:     baseURL,
		APIFormat:   apiFormat,
		Model:       strings.TrimSpace(item.Model),
		Temperature: item.Temperature,
	}
	// 模型名超过上限（只可能是坏数据）按值丢弃，与 pluginImportedProviderModels 对超长模型项
	// 的处理一致；不截断——截断会把模型名改成另一个不存在的模型。
	if len(config.Model) > pluginAIProviderImportModelMax {
		config.Model = ""
	}
	config.Models = pluginImportedProviderModels(item.Models)
	headers, headerReason := pluginImportedProviderHeaders(item.Headers)
	if headerReason != "" {
		return ai.ProviderConfig{}, headerReason
	}
	config.Headers = headers
	if config.Temperature < pluginAIProviderImportTempMin || config.Temperature > pluginAIProviderImportTempMax {
		config.Temperature = 0
	}
	return config, ""
}

func pluginImportedProviderModels(models []string) []string {
	if len(models) == 0 {
		return nil
	}
	result := make([]string, 0, len(models))
	seen := make(map[string]bool, len(models))
	for _, model := range models {
		trimmed := strings.TrimSpace(model)
		if trimmed == "" || len(trimmed) > pluginAIProviderImportModelMax || seen[trimmed] {
			continue
		}
		seen[trimmed] = true
		result = append(result, trimmed)
		if len(result) == pluginAIProviderImportModelsMax {
			break
		}
	}
	if len(result) == 0 {
		return nil
	}
	return result
}

// pluginImportedProviderHeaders 收敛自定义请求头：键规范化、按折叠名去重、键值各自限长，
// 最多 16 组。**任何一条头落不进来都按该条失败，不做静默丢弃**：头常常承载鉴权
// （Authorization 的 JWT、中转站的 X-Api-Key），悄悄丢掉一个只会产出一条看起来正常、
// 实际调不通的供应商。唯一不算失败的是「同名头大小写重复」——HTTP 头大小写不敏感，
// 两个名字指同一个头，按排序保留第一条，结果确定。
func pluginImportedProviderHeaders(headers map[string]string) (map[string]string, string) {
	if len(headers) == 0 {
		return nil, ""
	}
	type headerPair struct{ key, value string }
	keys := make([]string, 0, len(headers))
	for key := range headers {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	// 按 key 排序后遍历：map 的顺序是随机的，不排序会让「哪些头算数」不确定。
	usable := make([]headerPair, 0, len(headers))
	seen := make(map[string]bool, len(headers))
	for _, key := range keys {
		trimmedKey := strings.TrimSpace(key)
		if trimmedKey == "" || len(trimmedKey) > pluginAIProviderImportHeaderMax {
			return nil, pluginAIProviderImportReasonInvalidHeaders
		}
		if len(headers[key]) > pluginAIProviderImportHeaderValueMax {
			return nil, pluginAIProviderImportReasonInvalidHeaders
		}
		// HTTP 头大小写不敏感：按折叠后的名字去重，避免 X-Foo 与 x-foo 同时下发；输出键保留原文。
		foldedKey := strings.ToLower(trimmedKey)
		if seen[foldedKey] {
			continue
		}
		seen[foldedKey] = true
		usable = append(usable, headerPair{key: trimmedKey, value: headers[key]})
	}
	if len(usable) > pluginAIProviderImportHeadersMax {
		return nil, pluginAIProviderImportReasonTooManyHeaders
	}
	if len(usable) == 0 {
		return nil, ""
	}
	result := make(map[string]string, len(usable))
	for _, pair := range usable {
		result[pair.key] = pair.value
	}
	return result, ""
}

// pluginImportedProviderBaseURL 只接受 http/https 且带主机名的地址，并去掉地址里的凭据与
// fragment：凭据属于密钥字段，混在 URL 里既会被写进供应商元数据，也会被元数据接口回显。
func pluginImportedProviderBaseURL(raw string) (string, bool) {
	trimmed := strings.TrimSpace(raw)
	if trimmed == "" || len(trimmed) > pluginAIProviderImportBaseURLMax {
		return "", false
	}
	parsed, err := url.Parse(trimmed)
	if err != nil {
		return "", false
	}
	scheme := strings.ToLower(parsed.Scheme)
	if scheme != "http" && scheme != "https" {
		return "", false
	}
	if strings.TrimSpace(parsed.Host) == "" {
		return "", false
	}
	parsed.User = nil
	parsed.Fragment = ""
	parsed.Scheme = scheme
	return parsed.String(), true
}

// pluginAIProviderImportIdentity 是导入判重身份：名称大小写不敏感；地址只小写协议与主机名，
// 路径与查询保留原样。返回空串表示两边都无法构成身份，调用方跳过即可，不参与判重。
func pluginAIProviderImportIdentity(name, baseURL string) string {
	normalizedName := strings.ToLower(strings.TrimSpace(name))
	normalizedURL := pluginAIProviderImportIdentityURL(baseURL)
	if normalizedName == "" || normalizedURL == "" {
		return ""
	}
	return normalizedName + "|" + normalizedURL
}

// pluginAIProviderImportIdentityURL 归一化判重用的地址：小写协议与主机名（大小写不敏感的那部分），
// 去掉凭据与 fragment，再去掉路径尾部的 "/"；**路径与查询大小写原样保留**——/tenant/A 与
// /tenant/a 是两个不同的地址，整串小写会把它们合成一条，覆盖模式还会改错条目。
// 解析失败就退回原文，交给上层按原样比。
func pluginAIProviderImportIdentityURL(raw string) string {
	trimmed := strings.TrimSpace(raw)
	if trimmed == "" {
		return ""
	}
	parsed, err := url.Parse(trimmed)
	if err != nil {
		return trimmed
	}
	parsed.User = nil
	parsed.Fragment = ""
	parsed.Scheme = strings.ToLower(parsed.Scheme)
	parsed.Host = strings.ToLower(parsed.Host)
	if parsed.Path != "" {
		parsed.Path = strings.TrimRight(parsed.Path, "/")
	}
	return parsed.String()
}

// pluginAIProviderImportEchoName 回显条目名：截断到有界长度并加省略号。入参名字最长只受
// MaxArgsBytes 约束，原样回显会让一条超长名字把整批结果撑破成 result_too_large——成功与失败的
// 明细一起消失，用户只看到一句「结果太大」。
func pluginAIProviderImportEchoName(raw string) string {
	trimmed := strings.TrimSpace(raw)
	if trimmed == "" {
		return ""
	}
	runes := []rune(trimmed)
	truncated := false
	if len(runes) > pluginAIProviderImportEchoNameMaxRunes {
		runes = runes[:pluginAIProviderImportEchoNameMaxRunes]
		truncated = true
	}
	for len(string(runes)) > pluginAIProviderImportEchoNameMaxBytes {
		runes = runes[:len(runes)-1]
		truncated = true
	}
	name := string(runes)
	if truncated {
		name += "…"
	}
	return name
}
