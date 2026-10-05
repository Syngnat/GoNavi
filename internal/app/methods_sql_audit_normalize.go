package app

import (
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"net/url"
	"os"
	"strings"
	"time"

	"GoNavi-Wails/internal/connection"
)

func buildSQLAuditConnectionFingerprint(config connection.ConnectionConfig, logicalDB string) string {
	database := resolveSQLAuditDatabase(config, logicalDB)
	if connectionID := strings.TrimSpace(config.ID); connectionID != "" {
		// A saved connection keeps the same audit identity when its endpoint,
		// transport or credentials are edited. The logical database remains part
		// of the identity so cross-database filtering does not collapse histories.
		parts := []string{
			sqlAuditFingerprintVersion,
			"saved",
			strings.ToLower(strings.TrimSpace(config.Type)),
			connectionID,
			database,
		}
		hash := sha256.Sum256([]byte(strings.Join(parts, "\x00")))
		return sqlAuditFingerprintVersion + ":" + hex.EncodeToString(hash[:])
	}
	parts := []string{
		sqlAuditFingerprintVersion,
		"temporary",
		strings.ToLower(strings.TrimSpace(config.Type)),
		strings.ToLower(strings.TrimSpace(config.Driver)),
		strings.ToLower(strings.TrimSpace(config.Host)),
		fmt.Sprintf("%d", config.Port),
		strings.Join(normalizeFingerprintHosts(config.Hosts), ","),
		database,
		strings.ToLower(strings.TrimSpace(config.Topology)),
		strings.TrimSpace(config.ReplicaSet),
		strings.TrimSpace(config.RedisSentinelMaster),
		sanitizeSQLAuditEndpointIdentity(config),
	}
	// Deliberately exclude username, password, proxy, SSH and arbitrary custom
	// parameters. URI/DSN endpoints contribute only their authority or an
	// allowlisted key/value location; query parameters never enter the digest.
	hash := sha256.Sum256([]byte(strings.Join(parts, "\x00")))
	return sqlAuditFingerprintVersion + ":" + hex.EncodeToString(hash[:])
}

func sanitizeSQLAuditEndpointIdentity(config connection.ConnectionConfig) string {
	for _, candidate := range []string{config.URI, config.DSN} {
		candidate = strings.TrimSpace(candidate)
		if candidate == "" {
			continue
		}
		if strings.Contains(candidate, "://") {
			parsed, err := url.Parse(candidate)
			if err == nil && parsed.Scheme != "" {
				parsed.User = nil
				parsed.Path = ""
				parsed.RawPath = ""
				parsed.RawQuery = ""
				parsed.Fragment = ""
				if parsed.Host != "" {
					return strings.ToLower(parsed.String())
				}
			}
		}
		if at := strings.LastIndex(candidate, "@"); at >= 0 && at+1 < len(candidate) {
			if endpoint := sanitizeSQLAuditEndpointQuery(candidate[at+1:]); endpoint != "" {
				return strings.ToLower(endpoint)
			}
		}
		if endpoint := sanitizeSQLAuditKeyValueEndpoint(candidate); endpoint != "" {
			return strings.ToLower(endpoint)
		}
	}
	return ""
}

func sanitizeSQLAuditEndpointQuery(value string) string {
	base, _, _ := strings.Cut(value, "?")
	return strings.TrimSpace(base)
}

func sanitizeSQLAuditKeyValueEndpoint(value string) string {
	replacer := strings.NewReplacer(";", " ", "\r", " ", "\n", " ", "\t", " ")
	fields := strings.Fields(replacer.Replace(value))
	endpoint := make([]string, 0, len(fields))
	for _, field := range fields {
		key, fieldValue, found := strings.Cut(field, "=")
		if !found {
			continue
		}
		normalizedKey := strings.ToLower(strings.TrimSpace(key))
		switch normalizedKey {
		case "host", "hostname", "server", "address", "addr", "port", "database", "dbname", "db", "network", "protocol", "instance", "sid", "service_name":
			fieldValue = strings.Trim(strings.TrimSpace(fieldValue), "'\"")
			if fieldValue != "" {
				endpoint = append(endpoint, normalizedKey+"="+fieldValue)
			}
		}
	}
	return strings.Join(endpoint, ";")
}

func resolveSQLAuditDatabase(config connection.ConnectionConfig, logicalDB string) string {
	if database := strings.TrimSpace(logicalDB); database != "" {
		return database
	}
	return strings.TrimSpace(config.Database)
}

func sqlAuditStatusFromResult(result connection.QueryResult) string {
	if result.Success {
		return "success"
	}
	if data, ok := result.Data.(map[string]interface{}); ok {
		if cancelled, ok := data["cancelled"].(bool); ok && cancelled {
			return "cancelled"
		}
	}
	message := strings.ToLower(strings.TrimSpace(result.Message))
	if strings.Contains(message, "context canceled") ||
		strings.Contains(message, "context cancelled") ||
		strings.Contains(message, "query cancelled") ||
		strings.Contains(message, "query canceled") {
		return "cancelled"
	}
	return "error"
}

func sqlAuditStatusFromError(err error) string {
	if err == nil {
		return "success"
	}
	if errors.Is(err, os.ErrDeadlineExceeded) {
		return "cancelled"
	}
	message := strings.ToLower(err.Error())
	if strings.Contains(message, "context canceled") || strings.Contains(message, "context cancelled") {
		return "cancelled"
	}
	return "error"
}

func sqlAuditErrorFromResult(result connection.QueryResult) error {
	if result.Success || strings.TrimSpace(result.Message) == "" {
		return nil
	}
	return errors.New(strings.TrimSpace(result.Message))
}

func normalizeSQLAuditStatus(status string) string {
	switch strings.ToLower(strings.TrimSpace(status)) {
	case "success", "cancelled":
		return strings.ToLower(strings.TrimSpace(status))
	default:
		return "error"
	}
}

func normalizeSQLAuditSource(source string) string {
	source = strings.ToLower(strings.TrimSpace(source))
	if source == "" {
		return "query_editor"
	}
	return source
}

func normalizeSQLAuditCommitMode(mode string) string {
	switch strings.ToLower(strings.TrimSpace(mode)) {
	case "auto", "manual", "pending":
		return strings.ToLower(strings.TrimSpace(mode))
	default:
		return ""
	}
}

func normalizeSQLAuditBoundaryMode(mode string) string {
	switch strings.ToLower(strings.TrimSpace(mode)) {
	case "driver_api", "text_sql", "implicit":
		return strings.ToLower(strings.TrimSpace(mode))
	default:
		return "unknown"
	}
}

func durationMilliseconds(duration time.Duration) int64 {
	if duration <= 0 {
		return 0
	}
	milliseconds := duration.Milliseconds()
	if milliseconds == 0 {
		return 1
	}
	return milliseconds
}

func countSQLAuditStatements(dbType string, sql string) int {
	count := 0
	for _, statement := range splitSQLStatementsForDialect(dbType, sql) {
		if strings.TrimSpace(statement) != "" {
			count++
		}
	}
	return count
}

func sqlAuditRowsAffected(result connection.QueryResult) int64 {
	switch data := result.Data.(type) {
	case map[string]int64:
		return data["affectedRows"]
	case map[string]interface{}:
		for key, value := range data {
			if strings.EqualFold(strings.TrimSpace(key), "affectedRows") {
				return sqlAuditInt64(value)
			}
		}
	case []connection.ResultSetData:
		var total int64
		for _, resultSet := range data {
			affected, _ := summarizeManagedSQLResultSet(resultSet)
			total += affected
		}
		return total
	}
	return 0
}

func sqlAuditInt64(value interface{}) int64 {
	switch typed := value.(type) {
	case int:
		return int64(typed)
	case int32:
		return int64(typed)
	case int64:
		return typed
	case uint:
		return int64(typed)
	case uint32:
		return int64(typed)
	case uint64:
		if typed <= uint64(^uint64(0)>>1) {
			return int64(typed)
		}
	case float64:
		return int64(typed)
	}
	return 0
}
