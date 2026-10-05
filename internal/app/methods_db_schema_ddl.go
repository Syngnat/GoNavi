package app

import (
	"fmt"
	"strings"

	"GoNavi-Wails/internal/connection"
)

func isPostgresSchemaDDLDBType(dbType string) bool {
	switch resolveDDLDBType(connection.ConnectionConfig{Type: dbType}) {
	case "postgres", "kingbase", "highgo", "vastbase", "opengauss", "gaussdb":
		return true
	default:
		return false
	}
}

func resolvePGLikeDatabaseDDLCandidates(dbType string, user string) []string {
	switch resolveDDLDBType(connection.ConnectionConfig{Type: dbType}) {
	case "kingbase":
		return []string{"test", "template1", strings.TrimSpace(user)}
	case "vastbase":
		return []string{"vastbase", "postgres", "template1", strings.TrimSpace(user)}
	default:
		return []string{"postgres", "template1", strings.TrimSpace(user)}
	}
}

func resolvePGLikeDatabaseDDLRunConfig(config connection.ConnectionConfig, dbType string, targetDatabase string) connection.ConnectionConfig {
	runConfig := config
	target := strings.TrimSpace(targetDatabase)
	current := strings.TrimSpace(runConfig.Database)
	if current != "" && !strings.EqualFold(current, target) {
		return runConfig
	}

	candidates := resolvePGLikeDatabaseDDLCandidates(dbType, runConfig.User)
	seen := make(map[string]struct{}, len(candidates))
	for _, candidate := range candidates {
		name := strings.TrimSpace(candidate)
		if name == "" || strings.EqualFold(name, target) {
			continue
		}
		normalized := strings.ToLower(name)
		if _, ok := seen[normalized]; ok {
			continue
		}
		seen[normalized] = struct{}{}
		runConfig.Database = name
		return runConfig
	}

	runConfig.Database = ""
	return runConfig
}

func buildCreateSchemaSQL(dbType string, schemaName string) (string, error) {
	return buildCreateSchemaSQLWithText(dbType, schemaName, defaultDBBackendText)
}

func buildCreateSchemaSQLWithText(dbType string, schemaName string, text func(string, map[string]any) string) (string, error) {
	if text == nil {
		text = defaultDBBackendText
	}
	schemaName = strings.TrimSpace(schemaName)
	if schemaName == "" {
		return "", fmt.Errorf("%s", text("db.backend.error.schema_name_required", nil))
	}

	if !isPostgresSchemaDDLDBType(dbType) {
		return "", fmt.Errorf("%s", text("db.backend.error.schema_create_unsupported", map[string]any{"dbType": dbType}))
	}

	return fmt.Sprintf("CREATE SCHEMA %s", quoteIdentByType(dbType, schemaName)), nil
}

func buildRenameSchemaSQL(dbType string, oldSchemaName string, newSchemaName string) (string, error) {
	return buildRenameSchemaSQLWithText(dbType, oldSchemaName, newSchemaName, defaultDBBackendText)
}

func buildRenameSchemaSQLWithText(dbType string, oldSchemaName string, newSchemaName string, text func(string, map[string]any) string) (string, error) {
	if text == nil {
		text = defaultDBBackendText
	}
	oldSchemaName = strings.TrimSpace(oldSchemaName)
	newSchemaName = strings.TrimSpace(newSchemaName)
	if oldSchemaName == "" || newSchemaName == "" {
		return "", fmt.Errorf("%s", text("db.backend.error.schema_name_required", nil))
	}
	if oldSchemaName == newSchemaName {
		return "", fmt.Errorf("%s", text("db.backend.error.schema_same_name", nil))
	}
	if !isPostgresSchemaDDLDBType(dbType) {
		return "", fmt.Errorf("%s", text("db.backend.error.schema_rename_unsupported", map[string]any{"dbType": dbType}))
	}
	return fmt.Sprintf(
		"ALTER SCHEMA %s RENAME TO %s",
		quoteIdentByType(dbType, oldSchemaName),
		quoteIdentByType(dbType, newSchemaName),
	), nil
}

func buildDropSchemaSQL(dbType string, schemaName string) (string, error) {
	return buildDropSchemaSQLWithText(dbType, schemaName, defaultDBBackendText)
}

func buildDropSchemaSQLWithText(dbType string, schemaName string, text func(string, map[string]any) string) (string, error) {
	if text == nil {
		text = defaultDBBackendText
	}
	schemaName = strings.TrimSpace(schemaName)
	if schemaName == "" {
		return "", fmt.Errorf("%s", text("db.backend.error.schema_name_required", nil))
	}
	if !isPostgresSchemaDDLDBType(dbType) {
		return "", fmt.Errorf("%s", text("db.backend.error.schema_drop_unsupported", map[string]any{"dbType": dbType}))
	}
	return fmt.Sprintf("DROP SCHEMA %s CASCADE", quoteIdentByType(dbType, schemaName)), nil
}

func resolveSchemaDDLTargetDatabase(config connection.ConnectionConfig, dbName string) (string, error) {
	return resolveSchemaDDLTargetDatabaseWithText(config, dbName, defaultDBBackendText)
}

func resolveSchemaDDLTargetDatabaseWithText(config connection.ConnectionConfig, dbName string, text func(string, map[string]any) string) (string, error) {
	if text == nil {
		text = defaultDBBackendText
	}
	targetDbName := strings.TrimSpace(dbName)
	if targetDbName == "" {
		targetDbName = strings.TrimSpace(config.Database)
	}
	if targetDbName == "" {
		return "", fmt.Errorf("%s", text("db.backend.error.target_database_required", nil))
	}
	return targetDbName, nil
}

func (a *App) CreateSchema(config connection.ConnectionConfig, dbName string, schemaName string) (result connection.QueryResult) {
	auditSQL := fmt.Sprintf("CREATE SCHEMA %s", strings.TrimSpace(schemaName))
	defer a.beginSQLAuditUserAction(config, dbName, "object_editor", &auditSQL, &result)()
	if err := ensureConnectionAllowsStructureEdit(config, "connection.backend.action.create_schema"); err != nil {
		return connection.QueryResult{Success: false, Message: err.Error()}
	}
	dbType := resolveDDLDBType(config)
	targetDbName, err := resolveSchemaDDLTargetDatabaseWithText(config, dbName, a.appText)
	if err != nil {
		return connection.QueryResult{Success: false, Message: err.Error()}
	}

	query, err := buildCreateSchemaSQLWithText(dbType, schemaName, a.appText)
	if err != nil {
		return connection.QueryResult{Success: false, Message: err.Error()}
	}

	runConfig := buildRunConfigForDDL(config, dbType, targetDbName)
	dbInst, err := a.getDatabase(runConfig)
	if err != nil {
		return connection.QueryResult{Success: false, Message: err.Error()}
	}

	if _, err := dbInst.Exec(query); err != nil {
		return connection.QueryResult{Success: false, Message: err.Error()}
	}

	return connection.QueryResult{Success: true, Message: a.appText("db.backend.message.schema_created", nil)}
}

func (a *App) RenameSchema(config connection.ConnectionConfig, dbName string, oldSchemaName string, newSchemaName string) (result connection.QueryResult) {
	auditSQL := fmt.Sprintf("ALTER SCHEMA %s RENAME TO %s", strings.TrimSpace(oldSchemaName), strings.TrimSpace(newSchemaName))
	defer a.beginSQLAuditUserAction(config, dbName, "object_editor", &auditSQL, &result)()
	if err := ensureConnectionAllowsStructureEdit(config, "connection.backend.action.rename_schema"); err != nil {
		return connection.QueryResult{Success: false, Message: err.Error()}
	}
	dbType := resolveDDLDBType(config)
	targetDbName, err := resolveSchemaDDLTargetDatabaseWithText(config, dbName, a.appText)
	if err != nil {
		return connection.QueryResult{Success: false, Message: err.Error()}
	}

	query, err := buildRenameSchemaSQLWithText(dbType, oldSchemaName, newSchemaName, a.appText)
	if err != nil {
		return connection.QueryResult{Success: false, Message: err.Error()}
	}

	runConfig := buildRunConfigForDDL(config, dbType, targetDbName)
	dbInst, err := a.getDatabase(runConfig)
	if err != nil {
		return connection.QueryResult{Success: false, Message: err.Error()}
	}
	if _, err := dbInst.Exec(query); err != nil {
		return connection.QueryResult{Success: false, Message: err.Error()}
	}
	return connection.QueryResult{Success: true, Message: a.appText("db.backend.message.schema_renamed", nil)}
}

func (a *App) DropSchema(config connection.ConnectionConfig, dbName string, schemaName string) (result connection.QueryResult) {
	auditSQL := fmt.Sprintf("DROP SCHEMA %s", strings.TrimSpace(schemaName))
	defer a.beginSQLAuditUserAction(config, dbName, "object_editor", &auditSQL, &result)()
	if err := ensureConnectionAllowsStructureEdit(config, "connection.backend.action.drop_schema"); err != nil {
		return connection.QueryResult{Success: false, Message: err.Error()}
	}
	dbType := resolveDDLDBType(config)
	targetDbName, err := resolveSchemaDDLTargetDatabaseWithText(config, dbName, a.appText)
	if err != nil {
		return connection.QueryResult{Success: false, Message: err.Error()}
	}

	query, err := buildDropSchemaSQLWithText(dbType, schemaName, a.appText)
	if err != nil {
		return connection.QueryResult{Success: false, Message: err.Error()}
	}

	runConfig := buildRunConfigForDDL(config, dbType, targetDbName)
	dbInst, err := a.getDatabase(runConfig)
	if err != nil {
		return connection.QueryResult{Success: false, Message: err.Error()}
	}
	if _, err := dbInst.Exec(query); err != nil {
		return connection.QueryResult{Success: false, Message: err.Error()}
	}
	return connection.QueryResult{Success: true, Message: a.appText("db.backend.message.schema_dropped", nil)}
}
