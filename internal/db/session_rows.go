package db

import (
	"fmt"
	"strconv"
	"strings"
	"time"
	"unicode"

	"GoNavi-Wails/internal/connection"
)

func normalizeSessionRows(
	spec sessionSpec,
	rows []map[string]interface{},
	fallbackDatabase string,
) []connection.DatabaseSession {
	sessions := make([]connection.DatabaseSession, 0, len(rows))
	for index, row := range rows {
		values := normalizedSessionRow(row)
		session := connection.DatabaseSession{
			DatabaseOrTenant: sessionString(values,
				"databaseortenant", "databasetenant", "database", "datname", "db", "tenant", "catalog", "schema", "servicename"),
			SessionID: sessionString(values,
				"sessionid", "sessid", "processid", "connectionid", "connid", "pid", "id"),
			QueryID: sessionString(values,
				"queryid", "sqlid", "queryidentifier"),
			InstanceID: sessionString(values,
				"instanceid", "instid", "serverid", "datanodeid"),
			SerialNumber: sessionString(values,
				"serialnumber", "serial", "serialno"),
			Statement: sessionString(values,
				"statement", "sqltext", "currentquery", "query", "info", "sql"),
			State: sessionString(values,
				"state", "status", "command", "substatus"),
			User: sessionString(values,
				"username", "loginname", "usename", "user"),
		}
		if session.DatabaseOrTenant == "" && !spec.rowDatabaseAuthoritative {
			session.DatabaseOrTenant = strings.TrimSpace(fallbackDatabase)
		}
		session.DurationMs = sessionDuration(values, spec.durationUnit)
		session.Key = buildDatabaseSessionKey(spec.engine, session, index)
		sessions = append(sessions, session)
	}
	return sessions
}

func normalizedSessionRow(row map[string]interface{}) map[string]interface{} {
	result := make(map[string]interface{}, len(row))
	for key, value := range row {
		normalized := normalizeSessionColumnName(key)
		if normalized == "" {
			continue
		}
		if _, exists := result[normalized]; !exists {
			result[normalized] = value
		}
	}
	return result
}

func normalizeSessionColumnName(value string) string {
	var builder strings.Builder
	for _, r := range strings.ToLower(strings.TrimSpace(value)) {
		if unicode.IsLetter(r) || unicode.IsDigit(r) {
			builder.WriteRune(r)
		}
	}
	return builder.String()
}

func sessionString(values map[string]interface{}, aliases ...string) string {
	for _, alias := range aliases {
		value, ok := values[alias]
		if !ok || value == nil {
			continue
		}
		text := sessionValueString(value)
		if text != "" {
			return text
		}
	}
	return ""
}

func sessionValueString(value interface{}) string {
	switch typed := value.(type) {
	case nil:
		return ""
	case string:
		return strings.TrimSpace(typed)
	case []byte:
		return strings.TrimSpace(string(typed))
	case time.Time:
		return typed.Format(time.RFC3339Nano)
	default:
		return strings.TrimSpace(fmt.Sprint(value))
	}
}

func sessionDuration(values map[string]interface{}, unit sessionDurationUnit) int64 {
	if duration, ok := sessionInt64(values, "durationms", "elapsedms", "totalelapsedtime", "elapsedtime"); ok {
		return maxSessionDuration(duration)
	}
	if duration, ok := sessionFloat64(values, "time", "elapsed", "duration", "execseconds"); ok {
		return maxSessionDuration(int64(duration * float64(unit)))
	}
	if duration, ok := sessionFloat64(values, "execusec", "elapsedusec"); ok {
		return maxSessionDuration(int64(duration / 1000))
	}
	return 0
}

func sessionFloat64(values map[string]interface{}, aliases ...string) (float64, bool) {
	for _, alias := range aliases {
		value, ok := values[alias]
		if !ok || value == nil {
			continue
		}
		text := strings.TrimSpace(sessionValueString(value))
		if parsed, err := strconv.ParseFloat(text, 64); err == nil {
			return parsed, true
		}
	}
	return 0, false
}

func sessionInt64(values map[string]interface{}, aliases ...string) (int64, bool) {
	for _, alias := range aliases {
		value, ok := values[alias]
		if !ok || value == nil {
			continue
		}
		switch typed := value.(type) {
		case int:
			return int64(typed), true
		case int8:
			return int64(typed), true
		case int16:
			return int64(typed), true
		case int32:
			return int64(typed), true
		case int64:
			return typed, true
		case uint:
			return int64(typed), true
		case uint8:
			return int64(typed), true
		case uint16:
			return int64(typed), true
		case uint32:
			return int64(typed), true
		case uint64:
			if typed <= uint64(^uint64(0)>>1) {
				return int64(typed), true
			}
		case float32:
			return int64(typed), true
		case float64:
			return int64(typed), true
		default:
			text := strings.TrimSpace(sessionValueString(value))
			if parsed, err := strconv.ParseFloat(text, 64); err == nil {
				return int64(parsed), true
			}
		}
	}
	return 0, false
}

func maxSessionDuration(value int64) int64 {
	if value < 0 {
		return 0
	}
	return value
}

func buildDatabaseSessionKey(engine string, session connection.DatabaseSession, index int) string {
	parts := []string{
		strings.TrimSpace(engine),
		strings.TrimSpace(session.InstanceID),
		strings.TrimSpace(session.SessionID),
		strings.TrimSpace(session.SerialNumber),
		strings.TrimSpace(session.QueryID),
	}
	key := strings.Join(parts, ":")
	if strings.Trim(strings.Join(parts[1:], ":"), ":") != "" {
		return key
	}
	return fmt.Sprintf("%s:row:%d", strings.TrimSpace(engine), index)
}
