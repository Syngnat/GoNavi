package db

import (
	"context"
	"errors"
	"fmt"
	"strconv"
	"strings"
	"unicode"

	"GoNavi-Wails/internal/connection"
)

const maxSessionIdentifierLength = 512

var (
	// ErrSessionActionRejected means the server ran the statement but reported
	// that it did nothing, e.g. pg_terminate_backend(pid) returned false because
	// the process already exited or is not a client backend.
	ErrSessionActionRejected = errors.New("database server rejected the session action")

	errSessionActionUnsupported = errors.New("session action is not supported")
	errSessionIdentifierMissing = errors.New("required session identifier is missing")
)

type sessionActionStatement struct {
	sql           string
	expectBoolean bool
}

func buildSessionActionStatement(
	spec sessionSpec,
	request connection.SessionActionRequest,
) (sessionActionStatement, error) {
	if err := validateSessionActionCapability(spec.capability, request.Action); err != nil {
		return sessionActionStatement{}, err
	}

	switch spec.engine {
	case "mysql", "mariadb", "goldendb", "oceanbase-mysql":
		return buildMySQLSessionAction(request)
	case "doris":
		return buildDorisSessionAction(request)
	case "starrocks":
		return buildStarRocksSessionAction(request)
	case "postgres", "kingbase", "highgo", "vastbase", "opengauss", "gaussdb":
		return buildPostgresSessionAction(request)
	case "oracle":
		return buildOracleSessionAction(request)
	case "oceanbase-oracle":
		return buildOracleSessionAction(request)
	case "sqlserver":
		return buildSQLServerSessionAction(request)
	case "dameng":
		return buildDamengSessionAction(request)
	case "clickhouse":
		return buildClickHouseSessionAction(request)
	case "trino":
		return buildTrinoSessionAction(request)
	case "tdengine":
		return buildTDengineSessionAction(request)
	case "iotdb":
		return buildIoTDBSessionAction(request)
	default:
		return sessionActionStatement{}, errSessionActionUnsupported
	}
}

func validateSessionActionCapability(
	capability connection.SessionCapability,
	action connection.SessionAction,
) error {
	if !capability.Supported {
		return errSessionActionUnsupported
	}
	switch action {
	case connection.SessionActionCancelQuery:
		if capability.CanCancelQuery {
			return nil
		}
	case connection.SessionActionTerminateSession:
		if capability.CanTerminateSession {
			return nil
		}
	default:
		return fmt.Errorf("invalid session action %q", action)
	}
	return errSessionActionUnsupported
}

func buildMySQLSessionAction(request connection.SessionActionRequest) (sessionActionStatement, error) {
	sessionID, err := validatedNumericSessionIdentifier(request.SessionID)
	if err != nil {
		return sessionActionStatement{}, err
	}
	command := "KILL CONNECTION "
	if request.Action == connection.SessionActionCancelQuery {
		command = "KILL QUERY "
	}
	return sessionActionStatement{sql: command + sessionID}, nil
}

func buildDorisSessionAction(request connection.SessionActionRequest) (sessionActionStatement, error) {
	if request.Action == connection.SessionActionTerminateSession {
		sessionID, err := validatedNumericSessionIdentifier(request.SessionID)
		if err != nil {
			return sessionActionStatement{}, err
		}
		return sessionActionStatement{sql: "KILL CONNECTION " + sessionID}, nil
	}
	queryID, err := validatedDorisQueryIdentifier(request.QueryID)
	if err != nil {
		return sessionActionStatement{}, err
	}
	return sessionActionStatement{
		sql: `KILL QUERY '` + escapeSessionStringLiteral(queryID) + `'`,
	}, nil
}

func buildStarRocksSessionAction(request connection.SessionActionRequest) (sessionActionStatement, error) {
	return buildDorisSessionAction(request)
}

func buildPostgresSessionAction(request connection.SessionActionRequest) (sessionActionStatement, error) {
	sessionID, err := validatedNumericSessionIdentifier(request.SessionID)
	if err != nil {
		return sessionActionStatement{}, err
	}
	functionName := "pg_terminate_backend"
	if request.Action == connection.SessionActionCancelQuery {
		functionName = "pg_cancel_backend"
	}
	return sessionActionStatement{
		sql:           fmt.Sprintf("SELECT %s(%s) AS action_succeeded", functionName, sessionID),
		expectBoolean: true,
	}, nil
}

func buildOracleSessionAction(request connection.SessionActionRequest) (sessionActionStatement, error) {
	if request.Action != connection.SessionActionTerminateSession {
		return sessionActionStatement{}, errSessionActionUnsupported
	}
	sessionID, err := validatedNumericSessionIdentifier(request.SessionID)
	if err != nil {
		return sessionActionStatement{}, err
	}
	serialNumber, err := validatedNumericSessionIdentifier(request.SerialNumber)
	if err != nil {
		return sessionActionStatement{}, fmt.Errorf("invalid Oracle serial number: %w", err)
	}
	instanceID, err := validatedNumericSessionIdentifier(request.InstanceID)
	if err != nil {
		return sessionActionStatement{}, fmt.Errorf("invalid Oracle instance ID: %w", err)
	}
	return sessionActionStatement{
		sql: fmt.Sprintf("ALTER SYSTEM KILL SESSION '%s,%s,@%s' IMMEDIATE", sessionID, serialNumber, instanceID),
	}, nil
}

func buildSQLServerSessionAction(request connection.SessionActionRequest) (sessionActionStatement, error) {
	if request.Action != connection.SessionActionTerminateSession {
		return sessionActionStatement{}, errSessionActionUnsupported
	}
	sessionID, err := validatedNumericSessionIdentifier(request.SessionID)
	if err != nil {
		return sessionActionStatement{}, err
	}
	return sessionActionStatement{sql: "KILL " + sessionID}, nil
}

func buildDamengSessionAction(request connection.SessionActionRequest) (sessionActionStatement, error) {
	if request.Action != connection.SessionActionTerminateSession {
		return sessionActionStatement{}, errSessionActionUnsupported
	}
	sessionID, err := validatedNumericSessionIdentifier(request.SessionID)
	if err != nil {
		return sessionActionStatement{}, err
	}
	return sessionActionStatement{sql: fmt.Sprintf("CALL SP_CLOSE_SESSION(%s)", sessionID)}, nil
}

func buildClickHouseSessionAction(request connection.SessionActionRequest) (sessionActionStatement, error) {
	if request.Action != connection.SessionActionCancelQuery {
		return sessionActionStatement{}, errSessionActionUnsupported
	}
	queryID, err := validatedStringSessionIdentifier(request.QueryID)
	if err != nil {
		return sessionActionStatement{}, err
	}
	return sessionActionStatement{
		sql: fmt.Sprintf("KILL QUERY WHERE query_id = '%s' SYNC", escapeSessionStringLiteral(queryID)),
	}, nil
}

func buildTrinoSessionAction(request connection.SessionActionRequest) (sessionActionStatement, error) {
	if request.Action != connection.SessionActionCancelQuery {
		return sessionActionStatement{}, errSessionActionUnsupported
	}
	queryID, err := validatedStringSessionIdentifier(request.QueryID)
	if err != nil {
		return sessionActionStatement{}, err
	}
	return sessionActionStatement{
		sql: fmt.Sprintf(
			"CALL system.runtime.kill_query(query_id => '%s', message => 'Cancelled from GoNavi session workbench')",
			escapeSessionStringLiteral(queryID),
		),
	}, nil
}

func buildTDengineSessionAction(request connection.SessionActionRequest) (sessionActionStatement, error) {
	if request.Action == connection.SessionActionTerminateSession {
		sessionID, err := validatedNumericSessionIdentifier(request.SessionID)
		if err != nil {
			return sessionActionStatement{}, err
		}
		return sessionActionStatement{sql: "KILL CONNECTION " + sessionID}, nil
	}
	queryID, err := validatedUnquotedSessionIdentifier(request.QueryID)
	if err != nil {
		return sessionActionStatement{}, err
	}
	return sessionActionStatement{sql: "KILL QUERY '" + escapeSessionStringLiteral(queryID) + "'"}, nil
}

func buildIoTDBSessionAction(request connection.SessionActionRequest) (sessionActionStatement, error) {
	if request.Action != connection.SessionActionCancelQuery {
		return sessionActionStatement{}, errSessionActionUnsupported
	}
	queryID, err := validatedUnquotedSessionIdentifier(request.QueryID)
	if err != nil {
		return sessionActionStatement{}, err
	}
	return sessionActionStatement{
		sql: "KILL QUERY " + queryID,
	}, nil
}

func validatedNumericSessionIdentifier(raw string) (string, error) {
	text := strings.TrimSpace(raw)
	if text == "" {
		return "", errSessionIdentifierMissing
	}
	value, err := strconv.ParseInt(text, 10, 64)
	if err != nil || value <= 0 {
		return "", fmt.Errorf("invalid numeric session identifier %q", text)
	}
	return strconv.FormatInt(value, 10), nil
}

func validatedStringSessionIdentifier(raw string) (string, error) {
	text := strings.TrimSpace(raw)
	if text == "" {
		return "", errSessionIdentifierMissing
	}
	if len(text) > maxSessionIdentifierLength {
		return "", fmt.Errorf("session identifier exceeds %d bytes", maxSessionIdentifierLength)
	}
	for _, r := range text {
		if unicode.IsControl(r) {
			return "", errors.New("session identifier contains control characters")
		}
	}
	return text, nil
}

func validatedDorisQueryIdentifier(raw string) (string, error) {
	text, err := validatedStringSessionIdentifier(raw)
	if err != nil {
		return "", err
	}
	for _, r := range text {
		isLetter := r >= 'a' && r <= 'z' || r >= 'A' && r <= 'Z'
		isDigit := r >= '0' && r <= '9'
		if !isLetter && !isDigit && !strings.ContainsRune("_-:.", r) {
			return "", errors.New("Doris query identifier contains unsupported characters")
		}
	}
	return text, nil
}

func validatedUnquotedSessionIdentifier(raw string) (string, error) {
	text, err := validatedStringSessionIdentifier(raw)
	if err != nil {
		return "", err
	}
	for _, r := range text {
		isLetter := r >= 'a' && r <= 'z' || r >= 'A' && r <= 'Z'
		isDigit := r >= '0' && r <= '9'
		if !isLetter && !isDigit && !strings.ContainsRune("_-.:/", r) {
			return "", errors.New("session identifier contains unsupported characters")
		}
	}
	return text, nil
}

func escapeSessionStringLiteral(value string) string {
	return strings.ReplaceAll(value, "'", "''")
}

func executeSessionActionStatement(
	ctx context.Context,
	database Database,
	statement sessionActionStatement,
) error {
	if statement.expectBoolean {
		rows, _, err := querySessionContext(ctx, database, statement.sql)
		if err != nil {
			return err
		}
		if !firstSessionBoolean(rows) {
			return ErrSessionActionRejected
		}
		return nil
	}
	_, err := execSessionContext(ctx, database, statement.sql)
	return err
}

func firstSessionBoolean(rows []map[string]interface{}) bool {
	if len(rows) == 0 {
		return false
	}
	for _, value := range rows[0] {
		switch typed := value.(type) {
		case bool:
			return typed
		case string:
			parsed, err := strconv.ParseBool(strings.TrimSpace(typed))
			return err == nil && parsed
		case []byte:
			parsed, err := strconv.ParseBool(strings.TrimSpace(string(typed)))
			return err == nil && parsed
		case int, int8, int16, int32, int64:
			return fmt.Sprint(value) != "0"
		case uint, uint8, uint16, uint32, uint64:
			return fmt.Sprint(value) != "0"
		}
	}
	return false
}
