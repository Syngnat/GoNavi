package app

import (
	"errors"
	"fmt"
	"strings"
	"sync"
	"unicode"

	"GoNavi-Wails/internal/connection"
	"GoNavi-Wails/internal/logger"
	"GoNavi-Wails/internal/redis"
	"GoNavi-Wails/internal/sqlaudit"
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
		logger.Error(nil, "%s", redisExecuteCommandFailureLogMessage(err, command))
		return connection.QueryResult{Success: false, Message: err.Error()}
	}

	return connection.QueryResult{Success: true, Data: result}
}

func redisExecuteCommandFailureLogMessage(err error, command string) string {
	return fmt.Sprintf("RedisExecuteCommand 执行失败：command=%s；错误链：%s",
		redactRedisCommandForLog(command),
		sqlaudit.RedactError(logger.ErrorChain(err)))
}

func redactRedisCommandForLog(command string) string {
	redacted := strings.TrimSpace(sqlaudit.RedactQuery("redis", command))
	if redacted != "" {
		return redacted
	}
	if verb := redisCommandVerbForLog(command); verb != "" {
		return verb
	}
	return "[redacted]"
}

func redisCommandVerbForLog(command string) string {
	trimmed := strings.TrimSpace(command)
	if trimmed == "" {
		return ""
	}
	first := trimmed
	if index := strings.IndexFunc(trimmed, unicode.IsSpace); index >= 0 {
		first = trimmed[:index]
	}
	if first == "" || first[0] == '\'' || first[0] == '"' {
		return ""
	}
	for _, r := range first {
		if unicode.IsLetter(r) || unicode.IsDigit(r) || r == '.' || r == '_' || r == '-' {
			continue
		}
		return ""
	}
	return strings.ToUpper(first)
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
