package app

import (
	"fmt"
	"strings"

	"GoNavi-Wails/internal/ai"
	aiservice "GoNavi-Wails/internal/ai/service"
	"GoNavi-Wails/internal/connection"
	"GoNavi-Wails/internal/logger"
)

// HeadlessSQLSafetyStatement identifies one statement considered by the
// command-line safety policy. It intentionally excludes SQL text so callers
// can report a denial without exposing statement values.
type HeadlessSQLSafetyStatement struct {
	Index     int
	Keyword   string
	Operation ai.SQLOperationType
}

// HeadlessSQLSafetyDecision is the shared AI-safety decision used by headless
// callers. AllowMutating is an acknowledgement only; it cannot override a
// disallowed operation.
type HeadlessSQLSafetyDecision struct {
	SafetyLevel           ai.SQLPermissionLevel
	Inspection            SQLInspection
	RequiresAllowMutating bool
	Disallowed            []HeadlessSQLSafetyStatement
	ConfirmRequired       []HeadlessSQLSafetyStatement
}

// HeadlessSQLPolicyError is returned before a headless command can dispatch a
// statement that is blocked by the AI safety policy or connection protection.
type HeadlessSQLPolicyError struct {
	Message string
}

func (err *HeadlessSQLPolicyError) Error() string {
	if err == nil || strings.TrimSpace(err.Message) == "" {
		return "headless SQL policy denied the request"
	}
	return err.Message
}

// GetSQLSafetyLevel reads the current shared AI safety setting for this data
// root. A missing or unreadable configuration fails closed to read-only.
func (runtime *HeadlessRuntime) GetSQLSafetyLevel() ai.SQLPermissionLevel {
	if runtime == nil || runtime.app == nil {
		return ai.PermissionReadOnly
	}
	inspection, err := aiservice.NewProviderConfigStore(runtime.app.configDir, nil).Inspect()
	if err != nil {
		logger.Warnf("headless SQL safety configuration unavailable; using readonly policy: %v", err)
		return ai.PermissionReadOnly
	}
	return normalizeHeadlessSQLSafetyLevel(inspection.Snapshot.SafetyLevel)
}

// EvaluateSQLSafety classifies every statement with the same safety levels
// used by AI and MCP execution. It is safe for CLI callers to display the
// returned metadata because it does not include SQL values.
func (runtime *HeadlessRuntime) EvaluateSQLSafety(config connection.ConnectionConfig, sql string) HeadlessSQLSafetyDecision {
	return evaluateHeadlessSQLSafety(runtime.GetSQLSafetyLevel(), resolveDDLDBType(config), sql)
}

func evaluateHeadlessSQLSafety(level ai.SQLPermissionLevel, dbType string, sql string) HeadlessSQLSafetyDecision {
	level = normalizeHeadlessSQLSafetyLevel(level)
	decision := HeadlessSQLSafetyDecision{
		SafetyLevel: level,
		Inspection: SQLInspection{
			ReadOnly:   true,
			Statements: []SQLStatementInspection{},
		},
		Disallowed:      []HeadlessSQLSafetyStatement{},
		ConfirmRequired: []HeadlessSQLSafetyStatement{},
	}

	for _, statement := range splitSQLStatementsForDialect(dbType, sql) {
		statement = strings.TrimSpace(statement)
		if statement == "" {
			continue
		}
		inspection := SQLStatementInspection{
			Index:    len(decision.Inspection.Statements) + 1,
			Keyword:  leadingSQLKeyword(statement),
			ReadOnly: isReadOnlySQLQuery(dbType, statement),
		}
		decision.Inspection.Statements = append(decision.Inspection.Statements, inspection)
		if !inspection.ReadOnly {
			decision.Inspection.ReadOnly = false
		}

		safetyStatement := HeadlessSQLSafetyStatement{
			Index:     inspection.Index,
			Keyword:   inspection.Keyword,
			Operation: classifyHeadlessSQLOperation(dbType, statement, inspection),
		}
		if !isHeadlessSQLOperationAllowed(level, safetyStatement.Operation) {
			decision.Disallowed = append(decision.Disallowed, safetyStatement)
			continue
		}
		if safetyStatement.Operation != ai.SQLOpQuery {
			decision.RequiresAllowMutating = true
			decision.ConfirmRequired = append(decision.ConfirmRequired, safetyStatement)
		}
	}
	decision.Inspection.StatementCount = len(decision.Inspection.Statements)
	return decision
}

func classifyHeadlessSQLOperation(dbType, statement string, inspection SQLStatementInspection) ai.SQLOperationType {
	if inspection.ReadOnly {
		return ai.SQLOpQuery
	}
	if isBatchableWriteSQLStatement(dbType, statement) {
		return ai.SQLOpDML
	}
	keyword, _ := sqlDataOperationInfo(statement)
	switch keyword {
	case "create", "alter", "drop", "truncate", "rename":
		return ai.SQLOpDDL
	default:
		return ai.SQLOpOther
	}
}

func normalizeHeadlessSQLSafetyLevel(level ai.SQLPermissionLevel) ai.SQLPermissionLevel {
	switch level {
	case ai.PermissionReadOnly, ai.PermissionReadWrite, ai.PermissionFull:
		return level
	default:
		return ai.PermissionReadOnly
	}
}

func isHeadlessSQLOperationAllowed(level ai.SQLPermissionLevel, operation ai.SQLOperationType) bool {
	switch normalizeHeadlessSQLSafetyLevel(level) {
	case ai.PermissionReadOnly:
		return operation == ai.SQLOpQuery
	case ai.PermissionReadWrite:
		return operation == ai.SQLOpQuery || operation == ai.SQLOpDML
	case ai.PermissionFull:
		return true
	default:
		return operation == ai.SQLOpQuery
	}
}

func (runtime *HeadlessRuntime) authorizeHeadlessSQL(config connection.ConnectionConfig, sql string, allowMutating bool, requireDataImportProtection bool) error {
	return runtime.authorizeHeadlessSQLAtSafetyLevel(
		config,
		sql,
		allowMutating,
		requireDataImportProtection,
		runtime.GetSQLSafetyLevel(),
	)
}

func (runtime *HeadlessRuntime) authorizeHeadlessSQLAtSafetyLevel(config connection.ConnectionConfig, sql string, allowMutating bool, requireDataImportProtection bool, level ai.SQLPermissionLevel) error {
	if runtime == nil || runtime.app == nil {
		return &HeadlessSQLPolicyError{Message: "headless runtime is unavailable"}
	}
	decision := evaluateHeadlessSQLSafety(level, resolveDDLDBType(config), sql)
	if decision.Inspection.StatementCount == 0 {
		return &HeadlessSQLPolicyError{Message: "SQL is required"}
	}
	if len(decision.Disallowed) > 0 {
		return &HeadlessSQLPolicyError{Message: fmt.Sprintf(
			"SQL is blocked by AI safety level %q: %s",
			decision.SafetyLevel,
			formatHeadlessSQLSafetyStatements(decision.Disallowed),
		)}
	}
	if decision.RequiresAllowMutating && !allowMutating {
		return &HeadlessSQLPolicyError{Message: "mutating SQL requires --allow-write"}
	}

	if !decision.Inspection.ReadOnly {
		if err := runtime.app.authorizeHeadlessConnectionProtections(config, decision); err != nil {
			return err
		}
	}
	if requireDataImportProtection {
		if err := ensureConnectionAllowsActionWithText(
			config,
			connectionProtectionDataImport,
			"connection.backend.action.import_data",
			runtime.app.appText,
		); err != nil {
			return &HeadlessSQLPolicyError{Message: err.Error()}
		}
	}
	return nil
}

func (a *App) authorizeHeadlessConnectionProtections(config connection.ConnectionConfig, decision HeadlessSQLSafetyDecision) error {
	if a == nil {
		return &HeadlessSQLPolicyError{Message: "headless runtime is unavailable"}
	}
	if err := ensureConnectionAllowsActionWithText(
		config,
		connectionProtectionScriptExecution,
		"connection.backend.action.import_data",
		a.appText,
	); err != nil {
		return &HeadlessSQLPolicyError{Message: err.Error()}
	}
	for _, statement := range decision.ConfirmRequired {
		switch statement.Operation {
		case ai.SQLOpDML:
			if err := ensureConnectionAllowsActionWithText(config, connectionProtectionDataEdit, "connection.backend.action.apply_result_changes", a.appText); err != nil {
				return &HeadlessSQLPolicyError{Message: err.Error()}
			}
		case ai.SQLOpDDL:
			if err := ensureConnectionAllowsActionWithText(config, connectionProtectionStructureEdit, "connection.backend.action.import_data", a.appText); err != nil {
				return &HeadlessSQLPolicyError{Message: err.Error()}
			}
		case ai.SQLOpOther:
			// An unclassified statement can affect either data or structure.
			for _, protection := range []connectionProtectionKey{connectionProtectionDataEdit, connectionProtectionStructureEdit} {
				if err := ensureConnectionAllowsActionWithText(config, protection, "connection.backend.action.import_data", a.appText); err != nil {
					return &HeadlessSQLPolicyError{Message: err.Error()}
				}
			}
		}
	}
	return nil
}

// AuthorizeMCPConnectionSQL applies the same saved-connection write
// protections as the standalone CLI. MCP performs its own shared AI-safety and
// allowMutating checks before calling this method.
func (a *App) AuthorizeMCPConnectionSQL(config connection.ConnectionConfig, sql string) error {
	decision := evaluateHeadlessSQLSafety(ai.PermissionFull, resolveDDLDBType(config), sql)
	if decision.Inspection.StatementCount == 0 || decision.Inspection.ReadOnly {
		return nil
	}
	return a.authorizeHeadlessConnectionProtections(config, decision)
}

func formatHeadlessSQLSafetyStatements(statements []HeadlessSQLSafetyStatement) string {
	items := make([]string, 0, len(statements))
	for _, statement := range statements {
		keyword := strings.TrimSpace(statement.Keyword)
		if keyword == "" {
			keyword = "unknown"
		}
		items = append(items, fmt.Sprintf("#%d %s", statement.Index, keyword))
	}
	return strings.Join(items, ", ")
}
