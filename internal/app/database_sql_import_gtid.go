package app

import (
	"errors"
	"fmt"
	"strconv"
	"strings"

	"GoNavi-Wails/internal/connection"
	"GoNavi-Wails/internal/db"
)

type mysqlGTIDImportMode string

const (
	mysqlGTIDImportModeReject mysqlGTIDImportMode = "reject"
	mysqlGTIDImportModeSkip   mysqlGTIDImportMode = "skip"
	mysqlGTIDImportModeReset  mysqlGTIDImportMode = "reset"
)

var errMySQLGTIDStatementFound = errors.New("MySQL GTID_PURGED statement found")

type mysqlGTIDTargetState struct {
	GTIDExecuted  string
	ServerVersion string
}

func normalizeMySQLGTIDImportMode(raw string) (mysqlGTIDImportMode, error) {
	mode := mysqlGTIDImportMode(strings.ToLower(strings.TrimSpace(raw)))
	if mode == "" {
		mode = mysqlGTIDImportModeReject
	}
	switch mode {
	case mysqlGTIDImportModeReject, mysqlGTIDImportModeSkip, mysqlGTIDImportModeReset:
		return mode, nil
	default:
		return "", fmt.Errorf("unsupported MySQL GTID import mode %q", raw)
	}
}

func isMySQLGTIDImportConfig(config connection.ConnectionConfig) bool {
	return strings.EqualFold(strings.TrimSpace(config.Type), "mysql")
}

func skipMySQLGTIDLeadingTrivia(text string) int {
	position := 0
	for position < len(text) {
		switch {
		case strings.ContainsRune(" \t\r\n\f", rune(text[position])):
			position++
		case strings.HasPrefix(text[position:], "--") || strings.HasPrefix(text[position:], "#"):
			lineEnd := strings.IndexByte(text[position:], '\n')
			if lineEnd < 0 {
				return len(text)
			}
			position += lineEnd + 1
		case strings.HasPrefix(text[position:], "/*!"):
			return position
		case strings.HasPrefix(text[position:], "/*"):
			commentEnd := strings.Index(text[position+2:], "*/")
			if commentEnd < 0 {
				return len(text)
			}
			position += commentEnd + 4
		default:
			return position
		}
	}
	return position
}

func unwrapMySQLExecutableStatement(statement string) string {
	text := strings.TrimSpace(statement)
	for text != "" {
		start := skipMySQLGTIDLeadingTrivia(text)
		if start >= len(text) {
			return ""
		}
		text = strings.TrimSpace(text[start:])
		if !strings.HasPrefix(text, "/*!") {
			return text
		}
		end := strings.LastIndex(text, "*/")
		if end < 3 || strings.TrimSpace(text[end+2:]) != "" {
			return ""
		}
		inner := text[3:end]
		versionEnd := 0
		for versionEnd < len(inner) && inner[versionEnd] >= '0' && inner[versionEnd] <= '9' {
			versionEnd++
		}
		text = strings.TrimSpace(inner[versionEnd:])
	}
	return ""
}

func isMySQLGTIDPurgedStatement(statement string) bool {
	text := unwrapMySQLExecutableStatement(statement)
	keyword, position := nextSQLKeyword(text, 0)
	if keyword != "set" {
		return false
	}

	position = skipSQLTrivia(text, position)
	if !strings.HasPrefix(text[position:], "@@") {
		scope, scopeEnd := nextSQLKeyword(text, position)
		if scope != "global" {
			return false
		}
		position = scopeEnd
	} else {
		position += 2
		scope, scopeEnd := nextSQLKeyword(text, position)
		if scope != "global" {
			return false
		}
		position = scopeEnd
	}

	position = skipSQLTrivia(text, position)
	if position < len(text) && text[position] == '.' {
		position++
	}
	variable, variableEnd := nextSQLKeyword(text, position)
	if variable != "gtid_purged" {
		return false
	}
	position = skipSQLTrivia(text, variableEnd)
	return strings.HasPrefix(text[position:], "=") || strings.HasPrefix(text[position:], ":=")
}

func inspectMySQLGTIDSQLFile(filePath string) (bool, error) {
	source, err := OpenSQLImportSource(filePath, SQLImportSourceOptions{})
	if err != nil {
		return false, err
	}
	_, scanErr := StreamSQLFileWithOptions(source, SQLStreamOptions{
		DBType:            "mysql",
		MaxStatementBytes: DefaultSQLImportMaxStatementBytes,
	}, func(_ int, statement string) error {
		if isMySQLGTIDPurgedStatement(statement) {
			return errMySQLGTIDStatementFound
		}
		return nil
	})
	closeErr := source.Close()
	if errors.Is(scanErr, errMySQLGTIDStatementFound) {
		scanErr = nil
		if closeErr != nil {
			return false, closeErr
		}
		return true, nil
	}
	if scanErr != nil {
		return false, scanErr
	}
	if closeErr != nil {
		return false, closeErr
	}
	return false, nil
}

func queryMySQLGTIDTargetState(database db.Database) (mysqlGTIDTargetState, error) {
	rows, _, err := database.Query("SELECT @@GLOBAL.GTID_EXECUTED AS gtid_executed, VERSION() AS server_version")
	if err != nil {
		return mysqlGTIDTargetState{}, err
	}
	if len(rows) == 0 {
		return mysqlGTIDTargetState{}, errors.New("MySQL GTID status query returned no rows")
	}
	return mysqlGTIDTargetState{
		GTIDExecuted:  mysqlGTIDResultText(rows[0], "gtid_executed"),
		ServerVersion: mysqlGTIDResultText(rows[0], "server_version"),
	}, nil
}

func mysqlGTIDResultText(row map[string]interface{}, expectedKey string) string {
	for key, value := range row {
		if strings.EqualFold(strings.TrimSpace(key), expectedKey) && value != nil {
			return strings.TrimSpace(fmt.Sprint(value))
		}
	}
	return ""
}

func mysqlGTIDResetStatement(serverVersion string) (string, error) {
	version := strings.TrimSpace(serverVersion)
	parts := strings.SplitN(version, ".", 3)
	if len(parts) < 2 {
		return "", fmt.Errorf("unrecognized MySQL server version %q", serverVersion)
	}
	major, majorErr := strconv.Atoi(parts[0])
	minor, minorErr := strconv.Atoi(parts[1])
	if majorErr != nil || minorErr != nil {
		return "", fmt.Errorf("unrecognized MySQL server version %q", serverVersion)
	}
	if major > 8 || (major == 8 && minor >= 4) {
		return "RESET BINARY LOGS AND GTIDS", nil
	}
	return "RESET MASTER", nil
}

func buildMySQLGTIDPreflightPayload(containsGTID bool, state mysqlGTIDTargetState) map[string]interface{} {
	targetNonEmpty := strings.TrimSpace(state.GTIDExecuted) != ""
	return map[string]interface{}{
		"containsMySQLGTIDPurged":    containsGTID,
		"targetGTIDExecutedNonEmpty": targetNonEmpty,
		"serverVersion":              state.ServerVersion,
		"requiresGTIDDecision":       containsGTID && targetNonEmpty,
	}
}

func (a *App) validateDatabaseSQLImportAccess(config connection.ConnectionConfig) error {
	for _, protection := range []connectionProtectionKey{
		connectionProtectionDataImport,
		connectionProtectionStructureEdit,
		connectionProtectionScriptExecution,
	} {
		if err := ensureConnectionAllowsActionWithText(
			config,
			protection,
			"connection.backend.action.import_data",
			a.appText,
		); err != nil {
			return err
		}
	}
	if !isDataImportSQLDialectSupported(config) {
		return errors.New(a.appText("data_import.capability.reason.database_type_unsupported", nil))
	}
	return nil
}

func (a *App) PreflightDatabaseSQLImport(config connection.ConnectionConfig, dbName string, filePath string) (result connection.QueryResult) {
	if err := a.validateDatabaseSQLImportAccess(config); err != nil {
		return connection.QueryResult{Success: false, Message: err.Error()}
	}
	if strings.TrimSpace(filePath) == "" {
		return connection.QueryResult{Success: false, Message: a.appText("file.backend.error.file_path_empty", nil)}
	}
	resolvedPath, err := a.resolveWebUploadReference(filePath, webUploadPurposeSQLExecution)
	if err != nil {
		return connection.QueryResult{Success: false, Message: err.Error()}
	}
	filePath = resolvedPath
	if a.webRuntime {
		defer func() { result = sanitizeWebManagedResult(result, filePath) }()
	}
	if !isMySQLGTIDImportConfig(config) {
		return connection.QueryResult{Success: true, Data: buildMySQLGTIDPreflightPayload(false, mysqlGTIDTargetState{})}
	}

	containsGTID, err := inspectMySQLGTIDSQLFile(filePath)
	if err != nil {
		return connection.QueryResult{Success: false, Message: a.appText("file.backend.error.open_file_failed", map[string]any{"detail": err.Error()})}
	}
	if !containsGTID {
		return connection.QueryResult{Success: true, Data: buildMySQLGTIDPreflightPayload(false, mysqlGTIDTargetState{})}
	}

	database, err := a.getDatabase(normalizeRunConfig(config, dbName))
	if err != nil {
		return connection.QueryResult{Success: false, Message: a.appText("file.backend.error.mysql_gtid_preflight_failed", map[string]any{"detail": sanitizeSQLFileExecutionErr(err)})}
	}
	state, err := queryMySQLGTIDTargetState(database)
	if err != nil {
		return connection.QueryResult{Success: false, Message: a.appText("file.backend.error.mysql_gtid_preflight_failed", map[string]any{"detail": sanitizeSQLFileExecutionErr(err)})}
	}
	return connection.QueryResult{Success: true, Data: buildMySQLGTIDPreflightPayload(true, state)}
}
