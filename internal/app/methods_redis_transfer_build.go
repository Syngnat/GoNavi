package app

import (
	"context"
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
	return collectRedisKeysByPatternContext(context.Background(), client, pattern)
}

func collectRedisKeysByPatternContext(ctx context.Context, client redis.RedisClient, pattern string) ([]string, error) {
	normalizedPattern := strings.TrimSpace(pattern)
	if normalizedPattern == "" {
		normalizedPattern = "*"
	}

	seen := make(map[string]struct{})
	keys := make([]string, 0)
	var cursor uint64
	for {
		if err := ctx.Err(); err != nil {
			return nil, err
		}
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
	return loadAllRedisStreamEntriesContext(context.Background(), client, key, pageSize)
}

func loadAllRedisStreamEntriesContext(ctx context.Context, client redis.RedisClient, key string, pageSize int64) ([]redis.StreamEntry, error) {
	if pageSize <= 0 {
		pageSize = redisExportStreamPageSize
	}

	streamEntries := make([]redis.StreamEntry, 0)
	start := "-"
	lastID := ""

	for {
		if err := ctx.Err(); err != nil {
			return nil, err
		}
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
	return buildRedisTransferEntryContext(context.Background(), client, key)
}

func buildRedisTransferEntryContext(ctx context.Context, client redis.RedisClient, key string) (redisTransferEntry, error) {
	key = strings.TrimSpace(key)
	if key == "" {
		return redisTransferEntry{}, fmt.Errorf("redis key is empty")
	}
	if err := ctx.Err(); err != nil {
		return redisTransferEntry{}, err
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
		value, err := loadAllRedisStreamEntriesContext(ctx, client, key, redisExportStreamPageSize)
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
	return buildRedisExportPayloadContext(context.Background(), client, dbIndex, options, nil)
}

func buildRedisExportPayloadContext(
	ctx context.Context,
	client redis.RedisClient,
	dbIndex int,
	options RedisExportKeysOptions,
	progress func(current, total int64),
) (redisTransferFile, error) {
	scope := normalizeRedisExportScope(options.Scope)
	pattern := strings.TrimSpace(options.Pattern)

	var (
		keys []string
		err  error
	)
	if scope == "selected" {
		keys = normalizeRedisTransferKeys(options.Keys)
	} else {
		keys, err = collectRedisKeysByPatternContext(ctx, client, pattern)
		if err != nil {
			return redisTransferFile{}, err
		}
	}
	if len(keys) == 0 {
		return redisTransferFile{}, errRedisExportNoKeys
	}

	entries := make([]redisTransferEntry, 0, len(keys))
	total := int64(len(keys))
	if progress != nil {
		progress(0, total)
	}
	for index, key := range keys {
		if err := ctx.Err(); err != nil {
			return redisTransferFile{}, err
		}
		entry, err := buildRedisTransferEntryContext(ctx, client, key)
		if err != nil {
			return redisTransferFile{}, fmt.Errorf("%s: %w", key, err)
		}
		entries = append(entries, entry)
		if progress != nil {
			progress(int64(index+1), total)
		}
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
