package app

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"net/url"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"

	"GoNavi-Wails/internal/connection"
	"GoNavi-Wails/internal/logger"
	"GoNavi-Wails/internal/redis"

	"github.com/wailsapp/wails/v2/pkg/runtime"
)

// Redis client cache
var (
	redisCache         = make(map[string]redis.RedisClient)
	redisCacheConfigs  = make(map[string]connection.ConnectionConfig)
	redisCacheMu       sync.Mutex
	newRedisClientFunc = redis.NewRedisClient
)

const (
	redisTransferFileFormat         = "gonavi.redis.keys"
	redisTransferFileVersion        = 1
	redisExportScanBatchSize  int64 = 500
	redisExportStreamPageSize int64 = 500
)

var errRedisExportNoKeys = errors.New("redis export scope matched no keys")
var errRedisImportNoKeysSelected = errors.New("redis import scope selected no keys")

type RedisExportKeysOptions struct {
	Scope   string   `json:"scope,omitempty"`
	Keys    []string `json:"keys,omitempty"`
	Pattern string   `json:"pattern,omitempty"`
}

type RedisImportKeysOptions struct {
	ConflictMode string   `json:"conflictMode,omitempty"`
	Scope        string   `json:"scope,omitempty"`
	Keys         []string `json:"keys,omitempty"`
	File         string   `json:"file,omitempty"`
}

type RedisListPushOptions struct {
	Values   []string `json:"values"`
	Position string   `json:"position"`
}

type RedisImportPreview struct {
	File          string               `json:"file"`
	ExportedAt    string               `json:"exportedAt,omitempty"`
	Database      int                  `json:"database"`
	Scope         string               `json:"scope,omitempty"`
	Pattern       string               `json:"pattern,omitempty"`
	SourceAppName string               `json:"sourceAppName,omitempty"`
	Total         int                  `json:"total"`
	Keys          []redis.RedisKeyInfo `json:"keys"`
}

type redisTransferFile struct {
	Format        string               `json:"format"`
	Version       int                  `json:"version"`
	ExportedAt    string               `json:"exportedAt"`
	Database      int                  `json:"database"`
	Scope         string               `json:"scope,omitempty"`
	Pattern       string               `json:"pattern,omitempty"`
	Keys          []redisTransferEntry `json:"keys"`
	SourceAppName string               `json:"sourceAppName,omitempty"`
}

type redisTransferEntry struct {
	Key   string      `json:"key"`
	Type  string      `json:"type"`
	TTL   int64       `json:"ttl"`
	Value interface{} `json:"value"`
}

func normalizeRedisExportScope(raw string) string {
	switch strings.ToLower(strings.TrimSpace(raw)) {
	case "selected":
		return "selected"
	default:
		return "all"
	}
}

func normalizeRedisImportConflictMode(raw string) string {
	switch strings.ToLower(strings.TrimSpace(raw)) {
	case "skip":
		return "skip"
	default:
		return "overwrite"
	}
}

func normalizeRedisImportScope(raw string) string {
	switch strings.ToLower(strings.TrimSpace(raw)) {
	case "selected":
		return "selected"
	default:
		return "all"
	}
}

func normalizeRedisTransferFilename(filename string) string {
	trimmed := strings.TrimSpace(filename)
	if trimmed == "" {
		return ""
	}
	if strings.EqualFold(filepath.Ext(trimmed), ".json") {
		return trimmed
	}
	return trimmed + ".json"
}

func normalizeRedisTransferKeys(keys []string) []string {
	seen := make(map[string]struct{}, len(keys))
	normalized := make([]string, 0, len(keys))
	for _, raw := range keys {
		key := strings.TrimSpace(raw)
		if key == "" {
			continue
		}
		if _, exists := seen[key]; exists {
			continue
		}
		seen[key] = struct{}{}
		normalized = append(normalized, key)
	}
	return normalized
}

func collectRedisKeysByPattern(client redis.RedisClient, pattern string) ([]string, error) {
	normalizedPattern := strings.TrimSpace(pattern)
	if normalizedPattern == "" {
		normalizedPattern = "*"
	}

	seen := make(map[string]struct{})
	keys := make([]string, 0)
	var cursor uint64
	for {
		result, err := client.ScanKeys(normalizedPattern, cursor, redisExportScanBatchSize)
		if err != nil {
			return nil, err
		}
		if result == nil {
			break
		}
		for _, item := range result.Keys {
			key := strings.TrimSpace(item.Key)
			if key == "" {
				continue
			}
			if _, exists := seen[key]; exists {
				continue
			}
			seen[key] = struct{}{}
			keys = append(keys, key)
		}
		nextCursor, err := parseRedisScanCursor(result.Cursor)
		if err != nil {
			return nil, err
		}
		if nextCursor == 0 {
			break
		}
		cursor = nextCursor
	}

	sort.Strings(keys)
	return keys, nil
}

func loadAllRedisStreamEntries(client redis.RedisClient, key string, pageSize int64) ([]redis.StreamEntry, error) {
	if pageSize <= 0 {
		pageSize = redisExportStreamPageSize
	}

	streamEntries := make([]redis.StreamEntry, 0)
	start := "-"
	lastID := ""

	for {
		batch, err := client.GetStream(key, start, "+", pageSize+1)
		if err != nil {
			return nil, err
		}
		rawCount := len(batch)
		if rawCount == 0 {
			break
		}
		if lastID != "" && batch[0].ID == lastID {
			batch = batch[1:]
		}
		if len(batch) == 0 {
			break
		}
		streamEntries = append(streamEntries, batch...)
		lastID = batch[len(batch)-1].ID
		if rawCount < int(pageSize+1) {
			break
		}
		start = lastID
	}

	return streamEntries, nil
}

func buildRedisTransferEntry(client redis.RedisClient, key string) (redisTransferEntry, error) {
	key = strings.TrimSpace(key)
	if key == "" {
		return redisTransferEntry{}, fmt.Errorf("redis key is empty")
	}

	keyType, err := client.GetKeyType(key)
	if err != nil {
		return redisTransferEntry{}, err
	}

	ttl, err := client.GetTTL(key)
	if err != nil {
		return redisTransferEntry{}, err
	}
	if ttl < -1 {
		ttl = -1
	}

	entry := redisTransferEntry{
		Key:  key,
		Type: strings.TrimSpace(keyType),
		TTL:  ttl,
	}

	switch entry.Type {
	case "string":
		value, err := client.GetString(key)
		if err != nil {
			return redisTransferEntry{}, err
		}
		entry.Value = value
	case "hash":
		value, err := client.GetHash(key)
		if err != nil {
			return redisTransferEntry{}, err
		}
		entry.Value = value
	case "list":
		value, err := client.GetList(key, 0, -1)
		if err != nil {
			return redisTransferEntry{}, err
		}
		entry.Value = value
	case "set":
		value, err := client.GetSet(key)
		if err != nil {
			return redisTransferEntry{}, err
		}
		sort.Strings(value)
		entry.Value = value
	case "zset":
		value, err := client.GetZSet(key, 0, -1)
		if err != nil {
			return redisTransferEntry{}, err
		}
		entry.Value = value
	case "stream":
		value, err := loadAllRedisStreamEntries(client, key, redisExportStreamPageSize)
		if err != nil {
			return redisTransferEntry{}, err
		}
		entry.Value = value
	default:
		return redisTransferEntry{}, fmt.Errorf("unsupported redis type: %s", entry.Type)
	}

	return entry, nil
}

func buildRedisExportPayload(client redis.RedisClient, dbIndex int, options RedisExportKeysOptions) (redisTransferFile, error) {
	scope := normalizeRedisExportScope(options.Scope)
	pattern := strings.TrimSpace(options.Pattern)

	var (
		keys []string
		err  error
	)
	if scope == "selected" {
		keys = normalizeRedisTransferKeys(options.Keys)
	} else {
		keys, err = collectRedisKeysByPattern(client, pattern)
		if err != nil {
			return redisTransferFile{}, err
		}
	}
	if len(keys) == 0 {
		return redisTransferFile{}, errRedisExportNoKeys
	}

	entries := make([]redisTransferEntry, 0, len(keys))
	for _, key := range keys {
		entry, err := buildRedisTransferEntry(client, key)
		if err != nil {
			return redisTransferFile{}, fmt.Errorf("%s: %w", key, err)
		}
		entries = append(entries, entry)
	}

	return redisTransferFile{
		Format:        redisTransferFileFormat,
		Version:       redisTransferFileVersion,
		ExportedAt:    time.Now().UTC().Format(time.RFC3339),
		Database:      dbIndex,
		Scope:         scope,
		Pattern:       pattern,
		Keys:          entries,
		SourceAppName: "GoNavi",
	}, nil
}

func normalizeRedisTransferStringMap(raw interface{}) (map[string]string, error) {
	switch value := raw.(type) {
	case map[string]string:
		result := make(map[string]string, len(value))
		for key, item := range value {
			result[key] = item
		}
		return result, nil
	case map[string]interface{}:
		result := make(map[string]string, len(value))
		for key, item := range value {
			result[strings.TrimSpace(key)] = fmt.Sprint(item)
		}
		return result, nil
	default:
		return nil, fmt.Errorf("expected object value")
	}
}

func normalizeRedisTransferStringSlice(raw interface{}) ([]string, error) {
	switch value := raw.(type) {
	case []string:
		return append([]string(nil), value...), nil
	case []interface{}:
		items := make([]string, 0, len(value))
		for _, item := range value {
			items = append(items, fmt.Sprint(item))
		}
		return items, nil
	default:
		return nil, fmt.Errorf("expected array value")
	}
}

func normalizeRedisTransferFloat(raw interface{}) (float64, error) {
	switch value := raw.(type) {
	case float64:
		return value, nil
	case float32:
		return float64(value), nil
	case int:
		return float64(value), nil
	case int64:
		return float64(value), nil
	case int32:
		return float64(value), nil
	case json.Number:
		return value.Float64()
	case string:
		parsed, err := strconv.ParseFloat(strings.TrimSpace(value), 64)
		if err != nil {
			return 0, err
		}
		return parsed, nil
	default:
		return 0, fmt.Errorf("expected numeric score")
	}
}

func normalizeRedisTransferZSetMembers(raw interface{}) ([]redis.ZSetMember, error) {
	switch value := raw.(type) {
	case []redis.ZSetMember:
		return append([]redis.ZSetMember(nil), value...), nil
	case []interface{}:
		members := make([]redis.ZSetMember, 0, len(value))
		for _, item := range value {
			row, ok := item.(map[string]interface{})
			if !ok {
				return nil, fmt.Errorf("expected zset member object")
			}
			score, err := normalizeRedisTransferFloat(row["score"])
			if err != nil {
				return nil, err
			}
			members = append(members, redis.ZSetMember{
				Member: fmt.Sprint(row["member"]),
				Score:  score,
			})
		}
		return members, nil
	default:
		return nil, fmt.Errorf("expected array value")
	}
}

func normalizeRedisTransferStreamEntries(raw interface{}) ([]redis.StreamEntry, error) {
	switch value := raw.(type) {
	case []redis.StreamEntry:
		return append([]redis.StreamEntry(nil), value...), nil
	case []interface{}:
		entries := make([]redis.StreamEntry, 0, len(value))
		for _, item := range value {
			row, ok := item.(map[string]interface{})
			if !ok {
				return nil, fmt.Errorf("expected stream entry object")
			}
			fields, err := normalizeRedisTransferStringMap(row["fields"])
			if err != nil {
				return nil, err
			}
			entries = append(entries, redis.StreamEntry{
				ID:     strings.TrimSpace(fmt.Sprint(row["id"])),
				Fields: fields,
			})
		}
		return entries, nil
	default:
		return nil, fmt.Errorf("expected array value")
	}
}

func normalizeRedisTransferEntry(entry redisTransferEntry) (redisTransferEntry, error) {
	entry.Key = strings.TrimSpace(entry.Key)
	entry.Type = strings.ToLower(strings.TrimSpace(entry.Type))
	if entry.Key == "" {
		return redisTransferEntry{}, fmt.Errorf("redis key is empty")
	}
	if entry.TTL < -1 {
		entry.TTL = -1
	}

	switch entry.Type {
	case "string":
		entry.Value = fmt.Sprint(entry.Value)
	case "hash":
		value, err := normalizeRedisTransferStringMap(entry.Value)
		if err != nil {
			return redisTransferEntry{}, err
		}
		entry.Value = value
	case "list", "set":
		value, err := normalizeRedisTransferStringSlice(entry.Value)
		if err != nil {
			return redisTransferEntry{}, err
		}
		entry.Value = value
	case "zset":
		value, err := normalizeRedisTransferZSetMembers(entry.Value)
		if err != nil {
			return redisTransferEntry{}, err
		}
		entry.Value = value
	case "stream":
		value, err := normalizeRedisTransferStreamEntries(entry.Value)
		if err != nil {
			return redisTransferEntry{}, err
		}
		entry.Value = value
	default:
		return redisTransferEntry{}, fmt.Errorf("unsupported redis type: %s", entry.Type)
	}

	return entry, nil
}

func parseRedisTransferFile(raw []byte) (redisTransferFile, error) {
	if strings.TrimSpace(string(raw)) == "" {
		return redisTransferFile{}, fmt.Errorf("redis transfer file is empty")
	}

	var payload redisTransferFile
	if err := json.Unmarshal(raw, &payload); err != nil {
		return redisTransferFile{}, err
	}
	if strings.TrimSpace(payload.Format) != redisTransferFileFormat {
		return redisTransferFile{}, fmt.Errorf("unsupported redis transfer format: %s", strings.TrimSpace(payload.Format))
	}
	if payload.Version != redisTransferFileVersion {
		return redisTransferFile{}, fmt.Errorf("unsupported redis transfer version: %d", payload.Version)
	}

	normalizedKeys := make([]redisTransferEntry, 0, len(payload.Keys))
	for _, entry := range payload.Keys {
		normalized, err := normalizeRedisTransferEntry(entry)
		if err != nil {
			return redisTransferFile{}, fmt.Errorf("%s: %w", strings.TrimSpace(entry.Key), err)
		}
		normalizedKeys = append(normalizedKeys, normalized)
	}
	payload.Keys = normalizedKeys
	payload.Scope = normalizeRedisExportScope(payload.Scope)
	payload.Pattern = strings.TrimSpace(payload.Pattern)

	return payload, nil
}

func readRedisTransferFileFromPath(path string) (redisTransferFile, error) {
	content, err := os.ReadFile(path)
	if err != nil {
		return redisTransferFile{}, err
	}
	return parseRedisTransferFile(content)
}

func buildRedisImportPreview(file string, payload redisTransferFile) RedisImportPreview {
	keys := make([]redis.RedisKeyInfo, 0, len(payload.Keys))
	for _, entry := range payload.Keys {
		keys = append(keys, redis.RedisKeyInfo{
			Key:  entry.Key,
			Type: entry.Type,
			TTL:  entry.TTL,
		})
	}
	sort.Slice(keys, func(i, j int) bool {
		return strings.ToLower(keys[i].Key) < strings.ToLower(keys[j].Key)
	})
	return RedisImportPreview{
		File:          strings.TrimSpace(file),
		ExportedAt:    payload.ExportedAt,
		Database:      payload.Database,
		Scope:         payload.Scope,
		Pattern:       payload.Pattern,
		SourceAppName: payload.SourceAppName,
		Total:         len(keys),
		Keys:          keys,
	}
}

func selectRedisTransferEntriesForImport(payload redisTransferFile, options RedisImportKeysOptions) ([]redisTransferEntry, error) {
	scope := normalizeRedisImportScope(options.Scope)
	if scope != "selected" {
		return append([]redisTransferEntry(nil), payload.Keys...), nil
	}

	selectedKeys := normalizeRedisTransferKeys(options.Keys)
	if len(selectedKeys) == 0 {
		return nil, errRedisImportNoKeysSelected
	}

	selectedKeySet := make(map[string]struct{}, len(selectedKeys))
	for _, key := range selectedKeys {
		selectedKeySet[key] = struct{}{}
	}

	entries := make([]redisTransferEntry, 0, len(selectedKeys))
	for _, entry := range payload.Keys {
		if _, ok := selectedKeySet[entry.Key]; !ok {
			continue
		}
		entries = append(entries, entry)
	}
	if len(entries) == 0 {
		return nil, errRedisImportNoKeysSelected
	}
	return entries, nil
}

func setRedisImportedTTL(client redis.RedisClient, key string, ttl int64) error {
	if ttl < 0 {
		return nil
	}
	return client.SetTTL(key, ttl)
}

func importRedisTransferEntry(client redis.RedisClient, entry redisTransferEntry) error {
	switch entry.Type {
	case "string":
		return client.SetString(entry.Key, entry.Value.(string), entry.TTL)
	case "hash":
		fields := entry.Value.(map[string]string)
		fieldNames := make([]string, 0, len(fields))
		for field := range fields {
			fieldNames = append(fieldNames, field)
		}
		sort.Strings(fieldNames)
		for _, field := range fieldNames {
			if err := client.SetHashField(entry.Key, field, fields[field]); err != nil {
				return err
			}
		}
		return setRedisImportedTTL(client, entry.Key, entry.TTL)
	case "list":
		items := entry.Value.([]string)
		if len(items) == 0 {
			return fmt.Errorf("redis list payload is empty")
		}
		if err := client.ListPush(entry.Key, items...); err != nil {
			return err
		}
		return setRedisImportedTTL(client, entry.Key, entry.TTL)
	case "set":
		items := entry.Value.([]string)
		if len(items) == 0 {
			return fmt.Errorf("redis set payload is empty")
		}
		if err := client.SetAdd(entry.Key, items...); err != nil {
			return err
		}
		return setRedisImportedTTL(client, entry.Key, entry.TTL)
	case "zset":
		items := entry.Value.([]redis.ZSetMember)
		if len(items) == 0 {
			return fmt.Errorf("redis zset payload is empty")
		}
		if err := client.ZSetAdd(entry.Key, items...); err != nil {
			return err
		}
		return setRedisImportedTTL(client, entry.Key, entry.TTL)
	case "stream":
		items := entry.Value.([]redis.StreamEntry)
		if len(items) == 0 {
			return fmt.Errorf("redis stream payload is empty")
		}
		for _, item := range items {
			if _, err := client.StreamAdd(entry.Key, item.Fields, item.ID); err != nil {
				return err
			}
		}
		return setRedisImportedTTL(client, entry.Key, entry.TTL)
	default:
		return fmt.Errorf("unsupported redis type: %s", entry.Type)
	}
}

func importRedisTransferPayload(client redis.RedisClient, payload redisTransferFile, options RedisImportKeysOptions) (map[string]int, error) {
	conflictMode := normalizeRedisImportConflictMode(options.ConflictMode)
	entries, err := selectRedisTransferEntriesForImport(payload, options)
	if err != nil {
		return nil, err
	}
	result := map[string]int{
		"total": len(entries),
	}

	for _, entry := range entries {
		exists, err := client.KeyExists(entry.Key)
		if err != nil {
			return nil, fmt.Errorf("%s: %w", entry.Key, err)
		}
		if exists {
			if conflictMode == "skip" {
				result["skipped"]++
				continue
			}
			if _, err := client.DeleteKeys([]string{entry.Key}); err != nil {
				return nil, fmt.Errorf("%s: %w", entry.Key, err)
			}
		}
		if err := importRedisTransferEntry(client, entry); err != nil {
			return nil, fmt.Errorf("%s: %w", entry.Key, err)
		}
		result["imported"]++
	}

	return result, nil
}

// getRedisClient gets or creates a Redis client from cache
func (a *App) getRedisClient(config connection.ConnectionConfig) (redis.RedisClient, error) {
	resolvedConfig, err := a.resolveConnectionSecrets(config)
	if err != nil {
		wrapped := wrapConnectError(config, err)
		logger.Error(wrapped, "Redis 密文解析失败：%s", formatRedisConnSummary(config))
		return nil, wrapped
	}

	effectiveConfig := resolvedConfig
	connectConfig, proxyErr := resolveDialConfigWithProxyFunc(effectiveConfig)
	if proxyErr != nil {
		wrapped := wrapConnectError(effectiveConfig, proxyErr)
		logger.Error(wrapped, "Redis 代理准备失败：%s", formatRedisConnSummary(effectiveConfig))
		return nil, wrapped
	}

	key := getRedisClientCacheKey(connectConfig)
	shortKey := key
	if len(shortKey) > 12 {
		shortKey = shortKey[:12]
	}
	logger.Infof("获取 Redis 连接：%s 缓存Key=%s", formatRedisConnSummary(effectiveConfig), shortKey)

	redisCacheMu.Lock()
	defer redisCacheMu.Unlock()

	if client, ok := redisCache[key]; ok {
		logger.Infof("命中 Redis 连接缓存，开始检测可用性：缓存Key=%s", shortKey)
		if err := client.Ping(); err == nil {
			logger.Infof("缓存 Redis 连接可用：缓存Key=%s", shortKey)
			return client, nil
		} else {
			logger.Error(err, "缓存 Redis 连接不可用，准备重建：缓存Key=%s", shortKey)
		}
		client.Close()
		delete(redisCache, key)
		delete(redisCacheConfigs, key)
	}

	logger.Infof("创建 Redis 客户端实例：缓存Key=%s", shortKey)
	client, connectedConfig, connectErr := connectRedisClientWithLegacyRootFallback(connectConfig)
	if connectErr != nil {
		wrapped := wrapConnectError(connectedConfig, connectErr)
		logger.Error(wrapped, "Redis 连接失败：%s 缓存Key=%s", formatRedisConnSummary(connectedConfig), shortKey)
		return nil, wrapped
	}

	redisCache[key] = client
	redisCacheConfigs[key] = normalizeCacheKeyConfig(connectedConfig)
	logger.Infof("Redis 连接成功并写入缓存：%s 缓存Key=%s", formatRedisConnSummary(connectedConfig), shortKey)
	return client, nil
}

func (a *App) openRedisClientIsolated(config connection.ConnectionConfig) (redis.RedisClient, error) {
	resolvedConfig, err := a.resolveConnectionSecrets(config)
	if err != nil {
		wrapped := wrapConnectError(config, err)
		logger.Error(wrapped, "Redis 密文解析失败：%s", formatRedisConnSummary(config))
		return nil, wrapped
	}

	effectiveConfig := resolvedConfig
	connectConfig, proxyErr := resolveDialConfigWithProxyFunc(effectiveConfig)
	if proxyErr != nil {
		wrapped := wrapConnectError(effectiveConfig, proxyErr)
		logger.Error(wrapped, "Redis 代理准备失败：%s", formatRedisConnSummary(effectiveConfig))
		return nil, wrapped
	}

	client, connectedConfig, connectErr := connectRedisClientWithLegacyRootFallback(connectConfig)
	if connectErr != nil {
		wrapped := wrapConnectError(connectedConfig, connectErr)
		logger.Error(wrapped, "Redis 临时连接失败：%s", formatRedisConnSummary(connectedConfig))
		return nil, wrapped
	}
	return client, nil
}

func connectRedisClientWithLegacyRootFallback(config connection.ConnectionConfig) (redis.RedisClient, connection.ConnectionConfig, error) {
	client := newRedisClientFunc()
	if err := client.Connect(config); err == nil {
		return client, config, nil
	} else {
		client.Close()
		if !shouldRetryRedisWithClearedLegacyRoot(config, err) {
			return nil, config, err
		}

		fallbackConfig := config
		fallbackConfig.User = ""
		logger.Warnf("Redis 使用用户名 root 认证失败，已按历史默认值回退为空用户名重试：%s", formatRedisConnSummary(config))

		fallbackClient := newRedisClientFunc()
		if retryErr := fallbackClient.Connect(fallbackConfig); retryErr != nil {
			fallbackClient.Close()
			return nil, fallbackConfig, retryErr
		}
		return fallbackClient, fallbackConfig, nil
	}
}

func shouldRetryRedisWithClearedLegacyRoot(config connection.ConnectionConfig, err error) bool {
	if err == nil || strings.ToLower(strings.TrimSpace(config.Type)) != "redis" {
		return false
	}
	if strings.TrimSpace(config.User) != "root" {
		return false
	}
	if _, ok := extractExplicitRedisUsername(config.URI); ok {
		return false
	}

	lower := strings.ToLower(strings.TrimSpace(err.Error()))
	return strings.Contains(lower, "wrongpass") ||
		strings.Contains(lower, "invalid username-password pair") ||
		strings.Contains(lower, "auth failed") ||
		strings.Contains(lower, "wrong number of arguments for 'auth' command") ||
		strings.Contains(lower, "authentication failed")
}

func extractExplicitRedisUsername(rawURI string) (string, bool) {
	trimmed := strings.TrimSpace(rawURI)
	if trimmed == "" {
		return "", false
	}

	parsed, err := url.Parse(trimmed)
	if err != nil || parsed.User == nil {
		return "", false
	}

	username := strings.TrimSpace(parsed.User.Username())
	if username == "" {
		return "", false
	}
	return username, true
}

func getRedisClientCacheKey(config connection.ConnectionConfig) string {
	normalized := normalizeCacheKeyConfig(config)
	b, _ := json.Marshal(normalized)
	sum := sha256.Sum256(b)
	return hex.EncodeToString(sum[:])
}

func (a *App) releaseRedisClientsForConfig(config connection.ConnectionConfig) (int, error) {
	resolvedConfig, err := a.resolveConnectionSecrets(config)
	if err != nil {
		return 0, wrapConnectError(config, err)
	}
	targetKey := getConnectionReleaseMatchKey(resolvedConfig)
	closed := 0

	redisCacheMu.Lock()
	defer redisCacheMu.Unlock()

	for key, client := range redisCache {
		entryConfig := redisCacheConfigs[key]
		if strings.TrimSpace(entryConfig.Type) == "" {
			continue
		}
		if getConnectionReleaseMatchKey(entryConfig) != targetKey {
			continue
		}
		if client != nil {
			client.Close()
		}
		delete(redisCache, key)
		delete(redisCacheConfigs, key)
		closed++
	}
	return closed, nil
}

func formatRedisConnSummary(config connection.ConnectionConfig) string {
	var b strings.Builder
	b.WriteString("类型=redis 地址=")
	b.WriteString(config.Host)
	b.WriteString(":")
	b.WriteString(strconv.Itoa(config.Port))
	if topology := strings.TrimSpace(config.Topology); topology != "" {
		b.WriteString(" 模式=")
		b.WriteString(topology)
	}
	if len(config.Hosts) > 0 {
		b.WriteString(" 节点数=")
		b.WriteString(strconv.Itoa(len(config.Hosts)))
	}
	b.WriteString(" DB=")
	b.WriteString(strconv.Itoa(config.RedisDB))

	if config.UseSSH {
		b.WriteString(" SSH=")
		b.WriteString(config.SSH.Host)
		b.WriteString(":")
		b.WriteString(strconv.Itoa(config.SSH.Port))
		b.WriteString(" 用户=")
		b.WriteString(config.SSH.User)
	}
	if config.UseProxy {
		b.WriteString(" 代理=")
		b.WriteString(strings.ToLower(strings.TrimSpace(config.Proxy.Type)))
		b.WriteString("://")
		b.WriteString(config.Proxy.Host)
		b.WriteString(":")
		b.WriteString(strconv.Itoa(config.Proxy.Port))
		if strings.TrimSpace(config.Proxy.User) != "" {
			b.WriteString(" 代理认证=已配置")
		}
	}
	if config.UseHTTPTunnel {
		b.WriteString(" HTTP隧道=")
		b.WriteString(strings.TrimSpace(config.HTTPTunnel.Host))
		b.WriteString(":")
		b.WriteString(strconv.Itoa(config.HTTPTunnel.Port))
		if strings.TrimSpace(config.HTTPTunnel.User) != "" {
			b.WriteString(" HTTP隧道认证=已配置")
		}
	}

	return b.String()
}

// RedisConnect tests a Redis connection
func (a *App) RedisConnect(config connection.ConnectionConfig) connection.QueryResult {
	config.Type = "redis"
	_, err := a.getRedisClient(config)
	if err != nil {
		logger.Error(err, "RedisConnect 连接失败：%s", formatRedisConnSummary(config))
		return connection.QueryResult{Success: false, Message: err.Error()}
	}
	logger.Infof("RedisConnect 连接成功：%s", formatRedisConnSummary(config))
	return connection.QueryResult{Success: true, Message: a.appText("redis.backend.message.connect_success", nil)}
}

// RedisTestConnection tests a Redis connection (alias for RedisConnect)
func (a *App) RedisTestConnection(config connection.ConnectionConfig) connection.QueryResult {
	config.Type = "redis"
	client, err := a.openRedisClientIsolated(config)
	if err != nil {
		logger.Error(err, "RedisTestConnection 连接失败：%s", formatRedisConnSummary(config))
		return connection.QueryResult{Success: false, Message: err.Error()}
	}
	if client != nil {
		if closeErr := client.Close(); closeErr != nil {
			logger.Error(closeErr, "RedisTestConnection 释放临时连接失败：%s", formatRedisConnSummary(config))
			return connection.QueryResult{Success: false, Message: a.appText("redis.backend.error.test_connection_close_failed", map[string]any{"detail": closeErr.Error()})}
		}
	}
	logger.Infof("RedisTestConnection 连接成功：%s", formatRedisConnSummary(config))
	return connection.QueryResult{Success: true, Message: a.appText("redis.backend.message.connect_success", nil)}
}

// RedisScanKeys scans keys matching a pattern
func (a *App) RedisScanKeys(config connection.ConnectionConfig, pattern string, cursor any, count int64) connection.QueryResult {
	config.Type = "redis"
	client, err := a.getRedisClient(config)
	if err != nil {
		return connection.QueryResult{Success: false, Message: err.Error()}
	}

	parsedCursor, err := parseRedisScanCursor(cursor)
	if err != nil {
		logger.Warnf("RedisScanKeys 游标解析失败，已回退到起始游标：cursor=%v err=%v", cursor, err)
		parsedCursor = 0
	}

	result, err := client.ScanKeys(pattern, parsedCursor, count)
	if err != nil {
		logger.Error(err, "RedisScanKeys 扫描失败：pattern=%s", pattern)
		return connection.QueryResult{Success: false, Message: err.Error()}
	}

	return connection.QueryResult{Success: true, Data: result}
}

func parseRedisScanCursor(cursor any) (uint64, error) {
	switch v := cursor.(type) {
	case nil:
		return 0, nil
	case uint64:
		return v, nil
	case uint32:
		return uint64(v), nil
	case uint16:
		return uint64(v), nil
	case uint8:
		return uint64(v), nil
	case uint:
		return uint64(v), nil
	case int64:
		if v < 0 {
			return 0, fmt.Errorf("cursor must not be negative: %d", v)
		}
		return uint64(v), nil
	case int32:
		if v < 0 {
			return 0, fmt.Errorf("cursor must not be negative: %d", v)
		}
		return uint64(v), nil
	case int16:
		if v < 0 {
			return 0, fmt.Errorf("cursor must not be negative: %d", v)
		}
		return uint64(v), nil
	case int8:
		if v < 0 {
			return 0, fmt.Errorf("cursor must not be negative: %d", v)
		}
		return uint64(v), nil
	case int:
		if v < 0 {
			return 0, fmt.Errorf("cursor must not be negative: %d", v)
		}
		return uint64(v), nil
	case float64:
		return parseRedisScanCursorFromFloat(v)
	case float32:
		return parseRedisScanCursorFromFloat(float64(v))
	case json.Number:
		return parseRedisScanCursor(strings.TrimSpace(v.String()))
	case string:
		trimmed := strings.TrimSpace(v)
		if trimmed == "" {
			return 0, nil
		}
		parsed, err := strconv.ParseUint(trimmed, 10, 64)
		if err != nil {
			return 0, fmt.Errorf("invalid cursor: %q", v)
		}
		return parsed, nil
	default:
		return 0, fmt.Errorf("unsupported cursor type: %T", cursor)
	}
}

func parseRedisScanCursorFromFloat(value float64) (uint64, error) {
	if math.IsNaN(value) || math.IsInf(value, 0) {
		return 0, fmt.Errorf("invalid float cursor: %v", value)
	}
	if value < 0 {
		return 0, fmt.Errorf("cursor must not be negative: %v", value)
	}
	if math.Trunc(value) != value {
		return 0, fmt.Errorf("cursor must be an integer: %v", value)
	}
	if value > float64(math.MaxUint64) {
		return 0, fmt.Errorf("cursor is out of range: %v", value)
	}
	return uint64(value), nil
}

// RedisGetValue gets the value of a key
func (a *App) RedisGetValue(config connection.ConnectionConfig, key string) connection.QueryResult {
	config.Type = "redis"
	client, err := a.getRedisClient(config)
	if err != nil {
		return connection.QueryResult{Success: false, Message: err.Error()}
	}

	value, err := client.GetValue(key)
	if err != nil {
		logger.Error(err, "RedisGetValue 获取失败：key=%s", key)
		return connection.QueryResult{Success: false, Message: err.Error()}
	}

	return connection.QueryResult{Success: true, Data: value}
}

// RedisGetListValue gets a list in its requested display order.
func (a *App) RedisGetListValue(config connection.ConnectionConfig, key string, descending bool) connection.QueryResult {
	config.Type = "redis"
	client, err := a.getRedisClient(config)
	if err != nil {
		return connection.QueryResult{Success: false, Message: err.Error()}
	}

	value, err := client.GetValue(key)
	if err != nil {
		logger.Error(err, "RedisGetListValue 获取失败：key=%s", key)
		return connection.QueryResult{Success: false, Message: err.Error()}
	}
	if value.Type != "list" {
		return connection.QueryResult{Success: false, Message: a.appText("redis.backend.error.argument_invalid_type", map[string]any{"name": "Redis Key"})}
	}

	values, ok := value.Value.([]string)
	if !ok {
		return connection.QueryResult{Success: false, Message: a.appText("redis.backend.error.argument_invalid_type", map[string]any{"name": "Redis List"})}
	}
	if !descending {
		return connection.QueryResult{Success: true, Data: value}
	}

	windowSize := int64(len(values))
	needsTailFetch := value.Length > windowSize
	if windowSize == 0 && value.Length > 0 {
		windowSize = 1000
		if value.Length < windowSize {
			windowSize = value.Length
		}
		needsTailFetch = true
	}
	if needsTailFetch {
		values, err = client.GetList(key, value.Length-windowSize, -1)
		if err != nil {
			logger.Error(err, "RedisGetListValue 获取尾部数据失败：key=%s", key)
			return connection.QueryResult{Success: false, Message: err.Error()}
		}
	} else {
		values = append([]string(nil), values...)
	}
	for left, right := 0, len(values)-1; left < right; left, right = left+1, right-1 {
		values[left], values[right] = values[right], values[left]
	}
	value.Value = values

	return connection.QueryResult{Success: true, Data: value}
}

// RedisSetString sets a string value
func (a *App) RedisSetString(config connection.ConnectionConfig, key, value string, ttl int64) connection.QueryResult {
	config.Type = "redis"
	client, err := a.getRedisClient(config)
	if err != nil {
		return connection.QueryResult{Success: false, Message: err.Error()}
	}

	if err := client.SetString(key, value, ttl); err != nil {
		logger.Error(err, "RedisSetString 设置失败：key=%s", key)
		return connection.QueryResult{Success: false, Message: err.Error()}
	}

	return connection.QueryResult{Success: true, Message: a.appText("redis.backend.message.set_success", nil)}
}

// RedisSetHashField sets a field in a hash
func (a *App) RedisSetHashField(config connection.ConnectionConfig, key, field, value string) connection.QueryResult {
	config.Type = "redis"
	client, err := a.getRedisClient(config)
	if err != nil {
		return connection.QueryResult{Success: false, Message: err.Error()}
	}

	if err := client.SetHashField(key, field, value); err != nil {
		logger.Error(err, "RedisSetHashField 设置失败：key=%s field=%s", key, field)
		return connection.QueryResult{Success: false, Message: err.Error()}
	}

	return connection.QueryResult{Success: true, Message: a.appText("redis.backend.message.set_success", nil)}
}

// RedisDeleteKeys deletes one or more keys
func (a *App) RedisDeleteKeys(config connection.ConnectionConfig, keys []string) connection.QueryResult {
	config.Type = "redis"
	client, err := a.getRedisClient(config)
	if err != nil {
		return connection.QueryResult{Success: false, Message: err.Error()}
	}

	deleted, err := client.DeleteKeys(keys)
	if err != nil {
		logger.Error(err, "RedisDeleteKeys 删除失败：keys=%v", keys)
		return connection.QueryResult{Success: false, Message: err.Error()}
	}

	return connection.QueryResult{Success: true, Data: map[string]int64{"deleted": deleted}}
}

// RedisSetTTL sets the TTL of a key
func (a *App) RedisSetTTL(config connection.ConnectionConfig, key string, ttl int64) connection.QueryResult {
	config.Type = "redis"
	client, err := a.getRedisClient(config)
	if err != nil {
		return connection.QueryResult{Success: false, Message: err.Error()}
	}

	if err := client.SetTTL(key, ttl); err != nil {
		logger.Error(err, "RedisSetTTL 设置失败：key=%s ttl=%d", key, ttl)
		return connection.QueryResult{Success: false, Message: err.Error()}
	}

	return connection.QueryResult{Success: true, Message: a.appText("redis.backend.message.set_success", nil)}
}

// RedisExecuteCommand executes a raw Redis command
func (a *App) RedisExecuteCommand(config connection.ConnectionConfig, command string) connection.QueryResult {
	config.Type = "redis"
	client, err := a.getRedisClient(config)
	if err != nil {
		return connection.QueryResult{Success: false, Message: err.Error()}
	}

	// Parse command string into args
	args := parseRedisCommand(command)
	if len(args) == 0 {
		return connection.QueryResult{Success: false, Message: a.appText("redis.backend.error.command_required", nil)}
	}

	result, err := client.ExecuteCommand(args)
	if err != nil {
		logger.Error(err, "RedisExecuteCommand 执行失败：command=%s", command)
		return connection.QueryResult{Success: false, Message: err.Error()}
	}

	return connection.QueryResult{Success: true, Data: result}
}

// parseRedisCommand parses a Redis command string into arguments
func parseRedisCommand(command string) []string {
	command = strings.TrimSpace(command)
	if command == "" {
		return nil
	}

	var args []string
	var current strings.Builder
	inQuote := false
	quoteChar := rune(0)

	for _, ch := range command {
		if inQuote {
			if ch == quoteChar {
				inQuote = false
				args = append(args, current.String())
				current.Reset()
			} else {
				current.WriteRune(ch)
			}
		} else {
			if ch == '"' || ch == '\'' {
				inQuote = true
				quoteChar = ch
			} else if ch == ' ' || ch == '\t' {
				if current.Len() > 0 {
					args = append(args, current.String())
					current.Reset()
				}
			} else {
				current.WriteRune(ch)
			}
		}
	}

	if current.Len() > 0 {
		args = append(args, current.String())
	}

	return args
}

// RedisGetServerInfo returns server information
func (a *App) RedisGetServerInfo(config connection.ConnectionConfig) connection.QueryResult {
	config.Type = "redis"
	client, err := a.getRedisClient(config)
	if err != nil {
		return connection.QueryResult{Success: false, Message: err.Error()}
	}

	info, err := client.GetServerInfo()
	if err != nil {
		logger.Error(err, "RedisGetServerInfo 获取失败")
		return connection.QueryResult{Success: false, Message: err.Error()}
	}

	return connection.QueryResult{Success: true, Data: info}
}

// RedisGetDatabases returns information about all databases
func (a *App) RedisGetDatabases(config connection.ConnectionConfig) connection.QueryResult {
	config.Type = "redis"
	client, err := a.getRedisClient(config)
	if err != nil {
		return connection.QueryResult{Success: false, Message: err.Error()}
	}

	dbs, err := client.GetDatabases()
	if err != nil {
		logger.Error(err, "RedisGetDatabases 获取失败")
		return connection.QueryResult{Success: false, Message: err.Error()}
	}

	return connection.QueryResult{Success: true, Data: dbs}
}

// RedisSelectDB selects a database
func (a *App) RedisSelectDB(config connection.ConnectionConfig, dbIndex int) connection.QueryResult {
	config.Type = "redis"
	config.RedisDB = dbIndex
	client, err := a.getRedisClient(config)
	if err != nil {
		return connection.QueryResult{Success: false, Message: err.Error()}
	}

	if err := client.SelectDB(dbIndex); err != nil {
		logger.Error(err, "RedisSelectDB 切换失败：db=%d", dbIndex)
		return connection.QueryResult{Success: false, Message: err.Error()}
	}

	return connection.QueryResult{Success: true, Message: a.appText("redis.backend.message.select_db_success", nil)}
}

// RedisRenameKey renames a key
func (a *App) RedisRenameKey(config connection.ConnectionConfig, oldKey, newKey string) connection.QueryResult {
	config.Type = "redis"
	client, err := a.getRedisClient(config)
	if err != nil {
		return connection.QueryResult{Success: false, Message: err.Error()}
	}

	if err := client.RenameKey(oldKey, newKey); err != nil {
		logger.Error(err, "RedisRenameKey 重命名失败：%s -> %s", oldKey, newKey)
		return connection.QueryResult{Success: false, Message: err.Error()}
	}

	return connection.QueryResult{Success: true, Message: a.appText("redis.backend.message.rename_success", nil)}
}

// RedisKeyExists checks whether a key already exists
func (a *App) RedisKeyExists(config connection.ConnectionConfig, key string) connection.QueryResult {
	config.Type = "redis"
	client, err := a.getRedisClient(config)
	if err != nil {
		return connection.QueryResult{Success: false, Message: err.Error()}
	}

	exists, err := client.KeyExists(key)
	if err != nil {
		logger.Error(err, "RedisKeyExists 检查失败：key=%s", key)
		return connection.QueryResult{Success: false, Message: err.Error()}
	}

	return connection.QueryResult{Success: true, Data: map[string]bool{"exists": exists}}
}

func localizedRedisArgumentError(text func(string, map[string]any) string, key string, argName string) error {
	if text == nil {
		return fmt.Errorf("%s", key)
	}
	return fmt.Errorf("%s", text(key, map[string]any{"name": argName}))
}

func normalizeRedisStringArgs(raw any, argName string, text func(string, map[string]any) string) ([]string, error) {
	switch v := raw.(type) {
	case nil:
		return nil, localizedRedisArgumentError(text, "redis.backend.error.argument_required", argName)
	case string:
		itemText := strings.TrimSpace(v)
		if itemText == "" {
			return nil, localizedRedisArgumentError(text, "redis.backend.error.argument_required", argName)
		}
		return []string{itemText}, nil
	case []string:
		items := make([]string, 0, len(v))
		for _, item := range v {
			itemText := strings.TrimSpace(item)
			if itemText == "" {
				continue
			}
			items = append(items, itemText)
		}
		if len(items) == 0 {
			return nil, localizedRedisArgumentError(text, "redis.backend.error.argument_required", argName)
		}
		return items, nil
	case []interface{}:
		items := make([]string, 0, len(v))
		for _, item := range v {
			itemText := strings.TrimSpace(fmt.Sprintf("%v", item))
			if itemText == "" || itemText == "<nil>" {
				continue
			}
			items = append(items, itemText)
		}
		if len(items) == 0 {
			return nil, localizedRedisArgumentError(text, "redis.backend.error.argument_required", argName)
		}
		return items, nil
	default:
		return nil, localizedRedisArgumentError(text, "redis.backend.error.argument_invalid_type", argName)
	}
}

// RedisDeleteHashField deletes fields from a hash
func (a *App) RedisDeleteHashField(config connection.ConnectionConfig, key string, fields any) connection.QueryResult {
	config.Type = "redis"
	client, err := a.getRedisClient(config)
	if err != nil {
		return connection.QueryResult{Success: false, Message: err.Error()}
	}

	normalizedFields, err := normalizeRedisStringArgs(fields, "fields", a.appText)
	if err != nil {
		return connection.QueryResult{Success: false, Message: err.Error()}
	}

	if err := client.DeleteHashField(key, normalizedFields...); err != nil {
		logger.Error(err, "RedisDeleteHashField 删除失败：key=%s fields=%v", key, normalizedFields)
		return connection.QueryResult{Success: false, Message: err.Error()}
	}

	return connection.QueryResult{Success: true, Message: a.appText("redis.backend.message.delete_success", nil)}
}

// RedisListPush pushes values to a list
func (a *App) RedisListPush(config connection.ConnectionConfig, key string, options RedisListPushOptions) connection.QueryResult {
	if len(options.Values) == 0 {
		return connection.QueryResult{
			Success: false,
			Message: a.appText("redis.backend.error.argument_required", map[string]any{"name": "values"}),
		}
	}
	if options.Position != "left" && options.Position != "right" {
		return connection.QueryResult{
			Success: false,
			Message: a.appText("redis.backend.error.list_position_invalid", nil),
		}
	}

	config.Type = "redis"
	client, err := a.getRedisClient(config)
	if err != nil {
		return connection.QueryResult{Success: false, Message: err.Error()}
	}

	push := client.ListPush
	if options.Position == "left" {
		push = client.ListPushLeft
	}
	if err := push(key, options.Values...); err != nil {
		logger.Error(err, "RedisListPush 添加失败：key=%s", key)
		return connection.QueryResult{Success: false, Message: err.Error()}
	}

	return connection.QueryResult{Success: true, Message: a.appText("redis.backend.message.add_success", nil)}
}

// RedisListSet sets a value at an index in a list
func (a *App) RedisListSet(config connection.ConnectionConfig, key string, index int64, value string) connection.QueryResult {
	config.Type = "redis"
	client, err := a.getRedisClient(config)
	if err != nil {
		return connection.QueryResult{Success: false, Message: err.Error()}
	}

	if err := client.ListSet(key, index, value); err != nil {
		logger.Error(err, "RedisListSet 设置失败：key=%s index=%d", key, index)
		return connection.QueryResult{Success: false, Message: err.Error()}
	}

	return connection.QueryResult{Success: true, Message: a.appText("redis.backend.message.set_success", nil)}
}

// RedisListRemove removes the expected value at an index in a list.
func (a *App) RedisListRemove(config connection.ConnectionConfig, key string, index int64, value string) connection.QueryResult {
	config.Type = "redis"
	client, err := a.getRedisClient(config)
	if err != nil {
		return connection.QueryResult{Success: false, Message: err.Error()}
	}

	if err := client.ListRemoveAt(key, index, value); err != nil {
		if errors.Is(err, redis.ErrRedisListItemChanged) {
			return connection.QueryResult{
				Success: false,
				Message: a.appText("redis.backend.error.list_item_changed", nil),
			}
		}
		logger.Error(err, "RedisListRemove 删除失败：key=%s index=%d", key, index)
		return connection.QueryResult{Success: false, Message: err.Error()}
	}

	return connection.QueryResult{Success: true, Message: a.appText("redis.backend.message.delete_success", nil)}
}

// RedisSetAdd adds members to a set
func (a *App) RedisSetAdd(config connection.ConnectionConfig, key string, members []string) connection.QueryResult {
	config.Type = "redis"
	client, err := a.getRedisClient(config)
	if err != nil {
		return connection.QueryResult{Success: false, Message: err.Error()}
	}

	if err := client.SetAdd(key, members...); err != nil {
		logger.Error(err, "RedisSetAdd 添加失败：key=%s", key)
		return connection.QueryResult{Success: false, Message: err.Error()}
	}

	return connection.QueryResult{Success: true, Message: a.appText("redis.backend.message.add_success", nil)}
}

// RedisSetRemove removes members from a set
func (a *App) RedisSetRemove(config connection.ConnectionConfig, key string, members []string) connection.QueryResult {
	config.Type = "redis"
	client, err := a.getRedisClient(config)
	if err != nil {
		return connection.QueryResult{Success: false, Message: err.Error()}
	}

	if err := client.SetRemove(key, members...); err != nil {
		logger.Error(err, "RedisSetRemove 删除失败：key=%s", key)
		return connection.QueryResult{Success: false, Message: err.Error()}
	}

	return connection.QueryResult{Success: true, Message: a.appText("redis.backend.message.delete_success", nil)}
}

// RedisZSetAdd adds members to a sorted set
func (a *App) RedisZSetAdd(config connection.ConnectionConfig, key string, members []redis.ZSetMember) connection.QueryResult {
	config.Type = "redis"
	client, err := a.getRedisClient(config)
	if err != nil {
		return connection.QueryResult{Success: false, Message: err.Error()}
	}

	if err := client.ZSetAdd(key, members...); err != nil {
		logger.Error(err, "RedisZSetAdd 添加失败：key=%s", key)
		return connection.QueryResult{Success: false, Message: err.Error()}
	}

	return connection.QueryResult{Success: true, Message: a.appText("redis.backend.message.add_success", nil)}
}

// RedisZSetRemove removes members from a sorted set
func (a *App) RedisZSetRemove(config connection.ConnectionConfig, key string, members []string) connection.QueryResult {
	config.Type = "redis"
	client, err := a.getRedisClient(config)
	if err != nil {
		return connection.QueryResult{Success: false, Message: err.Error()}
	}

	if err := client.ZSetRemove(key, members...); err != nil {
		logger.Error(err, "RedisZSetRemove 删除失败：key=%s", key)
		return connection.QueryResult{Success: false, Message: err.Error()}
	}

	return connection.QueryResult{Success: true, Message: a.appText("redis.backend.message.delete_success", nil)}
}

// RedisStreamAdd adds an entry to a stream
func (a *App) RedisStreamAdd(config connection.ConnectionConfig, key string, fields map[string]string, id string) connection.QueryResult {
	config.Type = "redis"
	client, err := a.getRedisClient(config)
	if err != nil {
		return connection.QueryResult{Success: false, Message: err.Error()}
	}

	newID, err := client.StreamAdd(key, fields, id)
	if err != nil {
		logger.Error(err, "RedisStreamAdd 添加失败：key=%s id=%s", key, id)
		return connection.QueryResult{Success: false, Message: err.Error()}
	}

	return connection.QueryResult{Success: true, Message: a.appText("redis.backend.message.add_success", nil), Data: map[string]string{"id": newID}}
}

// RedisStreamDelete deletes stream entries by IDs
func (a *App) RedisStreamDelete(config connection.ConnectionConfig, key string, ids []string) connection.QueryResult {
	config.Type = "redis"
	client, err := a.getRedisClient(config)
	if err != nil {
		return connection.QueryResult{Success: false, Message: err.Error()}
	}

	deleted, err := client.StreamDelete(key, ids...)
	if err != nil {
		logger.Error(err, "RedisStreamDelete 删除失败：key=%s ids=%v", key, ids)
		return connection.QueryResult{Success: false, Message: err.Error()}
	}

	return connection.QueryResult{Success: true, Message: a.appText("redis.backend.message.delete_success", nil), Data: map[string]int64{"deleted": deleted}}
}

// RedisFlushDB flushes the current database
func (a *App) RedisFlushDB(config connection.ConnectionConfig) connection.QueryResult {
	config.Type = "redis"
	client, err := a.getRedisClient(config)
	if err != nil {
		return connection.QueryResult{Success: false, Message: err.Error()}
	}

	if err := client.FlushDB(); err != nil {
		logger.Error(err, "RedisFlushDB 清空失败")
		return connection.QueryResult{Success: false, Message: err.Error()}
	}

	return connection.QueryResult{Success: true, Message: a.appText("redis.backend.message.flush_success", nil)}
}

func (a *App) RedisExportKeys(config connection.ConnectionConfig, options RedisExportKeysOptions) connection.QueryResult {
	config.Type = "redis"
	scope := normalizeRedisExportScope(options.Scope)
	if scope == "selected" && len(normalizeRedisTransferKeys(options.Keys)) == 0 {
		return connection.QueryResult{Success: false, Message: a.appText("redis.backend.error.export_no_keys", nil)}
	}

	defaultName := fmt.Sprintf("redis-db%d-keys.json", config.RedisDB)
	if scope == "selected" {
		defaultName = fmt.Sprintf("redis-db%d-selected-keys.json", config.RedisDB)
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
	filename = normalizeRedisTransferFilename(filename)

	client, err := a.getRedisClient(config)
	if err != nil {
		return connection.QueryResult{Success: false, Message: err.Error()}
	}

	payload, err := buildRedisExportPayload(client, config.RedisDB, options)
	if err != nil {
		if errors.Is(err, errRedisExportNoKeys) {
			return connection.QueryResult{Success: false, Message: a.appText("redis.backend.error.export_no_keys", nil)}
		}
		return connection.QueryResult{Success: false, Message: err.Error()}
	}

	content, err := json.MarshalIndent(payload, "", "  ")
	if err != nil {
		return connection.QueryResult{Success: false, Message: a.appText("file.backend.error.write_failed", map[string]any{"detail": err.Error()})}
	}
	if err := os.WriteFile(filename, content, 0o644); err != nil {
		return connection.QueryResult{Success: false, Message: a.appText("file.backend.error.write_failed", map[string]any{"detail": err.Error()})}
	}

	return connection.QueryResult{
		Success: true,
		Message: a.appText("redis.backend.message.export_success", nil),
		Data: map[string]any{
			"exported": len(payload.Keys),
			"file":     filename,
		},
	}
}

func (a *App) openRedisImportTransferFileDialog(dbIndex int) (string, error) {
	return runtime.OpenFileDialog(a.ctx, runtime.OpenDialogOptions{
		Title: a.appText("file.backend.dialog.import_data", map[string]any{
			"table": fmt.Sprintf("db%d", dbIndex),
		}),
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

func (a *App) RedisPreviewImportKeys(config connection.ConnectionConfig) connection.QueryResult {
	config.Type = "redis"
	selection, err := a.openRedisImportTransferFileDialog(config.RedisDB)
	if err != nil {
		return connection.QueryResult{Success: false, Message: err.Error()}
	}
	if strings.TrimSpace(selection) == "" {
		return connection.QueryResult{Success: false, Message: "已取消"}
	}

	payload, err := readRedisTransferFileFromPath(selection)
	if err != nil {
		if errors.Is(err, os.ErrNotExist) || errors.Is(err, os.ErrPermission) {
			return connection.QueryResult{Success: false, Message: a.appText("file.backend.error.open_file_failed", map[string]any{"detail": err.Error()})}
		}
		var syntaxErr *json.SyntaxError
		if errors.As(err, &syntaxErr) {
			return connection.QueryResult{Success: false, Message: a.appText("file.backend.error.import_json_parse_failed", map[string]any{"detail": err.Error()})}
		}
		return connection.QueryResult{Success: false, Message: a.appText("redis.backend.error.import_payload_invalid", map[string]any{"detail": err.Error()})}
	}

	return connection.QueryResult{
		Success: true,
		Data:    buildRedisImportPreview(selection, payload),
	}
}

func (a *App) RedisImportKeys(config connection.ConnectionConfig, options RedisImportKeysOptions) connection.QueryResult {
	config.Type = "redis"
	selection := strings.TrimSpace(options.File)
	var err error
	if selection == "" {
		selection, err = a.openRedisImportTransferFileDialog(config.RedisDB)
		if err != nil {
			return connection.QueryResult{Success: false, Message: err.Error()}
		}
	}
	if strings.TrimSpace(selection) == "" {
		return connection.QueryResult{Success: false, Message: "已取消"}
	}

	payload, err := readRedisTransferFileFromPath(selection)
	if err != nil {
		if errors.Is(err, os.ErrNotExist) || errors.Is(err, os.ErrPermission) {
			return connection.QueryResult{Success: false, Message: a.appText("file.backend.error.open_file_failed", map[string]any{"detail": err.Error()})}
		}
		var syntaxErr *json.SyntaxError
		if errors.As(err, &syntaxErr) {
			return connection.QueryResult{Success: false, Message: a.appText("file.backend.error.import_json_parse_failed", map[string]any{"detail": err.Error()})}
		}
		return connection.QueryResult{Success: false, Message: a.appText("redis.backend.error.import_payload_invalid", map[string]any{"detail": err.Error()})}
	}

	client, err := a.getRedisClient(config)
	if err != nil {
		return connection.QueryResult{Success: false, Message: err.Error()}
	}

	result, err := importRedisTransferPayload(client, payload, options)
	if err != nil {
		if errors.Is(err, errRedisImportNoKeysSelected) {
			return connection.QueryResult{Success: false, Message: a.appText("redis.backend.error.import_no_keys_selected", nil)}
		}
		return connection.QueryResult{Success: false, Message: err.Error()}
	}

	return connection.QueryResult{
		Success: true,
		Message: a.appText("redis.backend.message.import_success", nil),
		Data: map[string]any{
			"imported": result["imported"],
			"skipped":  result["skipped"],
			"total":    result["total"],
			"file":     selection,
		},
	}
}

// CloseAllRedisClients closes all cached Redis clients (called on shutdown)
func CloseAllRedisClients() {
	redisCacheMu.Lock()
	defer redisCacheMu.Unlock()

	for key, client := range redisCache {
		if client != nil {
			client.Close()
			logger.Infof("已关闭 Redis 连接：%s", key[:12])
		}
	}
	redisCache = make(map[string]redis.RedisClient)
	redisCacheConfigs = make(map[string]connection.ConnectionConfig)
}
