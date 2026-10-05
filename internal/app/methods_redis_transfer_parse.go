package app

import (
	"encoding/json"
	"fmt"
	"os"
	"sort"
	"strconv"
	"strings"

	"GoNavi-Wails/internal/redis"
)

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
