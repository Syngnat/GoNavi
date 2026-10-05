package app

import (
	"fmt"
	"path/filepath"
	"sort"
	"strings"
	"time"

	"GoNavi-Wails/internal/redis"
)

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
