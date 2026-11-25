package app

import (
	"context"
	"fmt"
	"regexp"
	"strings"

	"GoNavi-Wails/internal/connection"
	"GoNavi-Wails/internal/db"
)

const maxCopyViewAttempts = 1000

var createViewTargetPattern = regexp.MustCompile(
	`(?is)^(\s*CREATE\s+(?:OR\s+REPLACE\s+)?` +
		`(?:ALGORITHM\s*=\s*\w+\s+)?` +
		`(?:DEFINER\s*=\s*(?:` + "`[^`]*`" + `|\S+)\s*@\s*(?:` + "`[^`]*`" + `|\S+)\s+)?` +
		`(?:SQL\s+SECURITY\s+(?:DEFINER|INVOKER)\s+)?` +
		`(?:(?:MATERIALIZED|FORCE|EDITIONING)\s+)*VIEW\s+)` +
		`(?:(?:` + "`[^`]*`" + `|"[^"]*"|\[[^\]]*\]|[A-Za-z0-9_$#]+)\s*\.\s*)*` +
		`(?:` + "`[^`]*`" + `|"[^"]*"|\[[^\]]*\]|[A-Za-z0-9_$#]+)`,
)

// CopyView creates a view copy inside the same connection. The target database
// and schema may differ from the source; the target name starts at
// <source>_copy1 and advances when that view already exists.
func (a *App) CopyView(
	config connection.ConnectionConfig,
	sourceDBName string,
	sourceSchemaName string,
	sourceViewName string,
	targetDBName string,
	targetSchemaName string,
) (result connection.QueryResult) {
	auditSQL := fmt.Sprintf("COPY VIEW %s", strings.TrimSpace(sourceViewName))
	sourceDBName = strings.TrimSpace(sourceDBName)
	targetDBName = strings.TrimSpace(targetDBName)
	if targetDBName == "" {
		targetDBName = sourceDBName
	}
	auditDBName := targetDBName
	defer func() {
		a.beginSQLAuditUserAction(config, auditDBName, "object_editor", &auditSQL, &result)()
	}()

	sourceViewName = strings.TrimSpace(sourceViewName)
	if sourceViewName == "" {
		return connection.QueryResult{Success: false, Message: a.appText("db.backend.error.view_name_required", nil)}
	}
	if err := ensureConnectionAllowsStructureEdit(config, "connection.backend.action.copy_view"); err != nil {
		return connection.QueryResult{Success: false, Message: err.Error()}
	}

	dbType := resolveDDLDBType(config)
	sourceSchema, sourceName := normalizeCopyTableSource(
		dbType, sourceDBName, sourceSchemaName, sourceViewName,
	)
	if sourceName == "" {
		return connection.QueryResult{Success: false, Message: a.appText("db.backend.error.view_name_required", nil)}
	}
	targetScope, targetSupported := resolveCopyViewTargetScope(
		dbType,
		sourceDBName,
		targetDBName,
		targetSchemaName,
		sourceSchema,
	)
	if !targetSupported {
		return connection.QueryResult{
			Success: false,
			Message: a.appText("db.backend.error.view_copy_cross_database_unsupported", map[string]any{
				"source": sourceViewName,
				"target": targetDBName,
			}),
		}
	}

	sourceRunConfig := buildRunConfigForDDL(config, dbType, sourceDBName)
	sourceDB, err := a.getDatabase(sourceRunConfig)
	if err != nil {
		return connection.QueryResult{Success: false, Message: err.Error()}
	}

	viewDDL, ok := tryGetViewCreateStatement(
		context.Background(),
		sourceDB,
		config,
		sourceDBName,
		sourceSchema,
		sourceName,
	)
	if !ok || strings.TrimSpace(viewDDL) == "" {
		return connection.QueryResult{
			Success: false,
			Message: a.appText("db.backend.error.view_copy_source_failed", map[string]any{
				"source": sourceViewName,
				"error":  "view definition is unavailable",
			}),
		}
	}

	targetRunConfig := buildRunConfigForDDL(config, dbType, targetDBName)
	targetDB, err := a.getDatabase(targetRunConfig)
	if err != nil {
		return connection.QueryResult{Success: false, Message: err.Error()}
	}

	viewLookup, lookupErr := listViewNameLookupWithStatus(targetDB, config, targetDBName)
	if lookupErr != nil {
		return connection.QueryResult{
			Success: false,
			Message: a.appText("db.backend.error.view_copy_source_failed", map[string]any{
				"source": sourceViewName,
				"error":  lookupErr.Error(),
			}),
		}
	}

	var targetName string
	for attempt := 0; attempt < maxCopyViewAttempts; attempt++ {
		targetName = buildCopyTableTargetName(dbType, sourceName, attempt+1)
		if viewLookupHasTarget(viewLookup, dbType, targetScope, targetName) {
			continue
		}
		targetRef := quoteTableIdentByType(dbType, targetScope, targetName)
		copySQL, rewriteOK := rewriteCreateViewTarget(viewDDL, targetRef)
		if !rewriteOK {
			return connection.QueryResult{
				Success: false,
				Message: a.appText("db.backend.error.view_copy_source_failed", map[string]any{
					"source": sourceViewName,
					"error":  "unsupported CREATE VIEW statement",
				}),
			}
		}
		auditSQL = copySQL
		if _, execErr := targetDB.Exec(copySQL); execErr != nil {
			return connection.QueryResult{
				Success: false,
				Message: a.appText("db.backend.error.view_copy_create_failed", map[string]any{
					"source": sourceViewName,
					"target": targetName,
					"error":  execErr.Error(),
				}),
			}
		}
		a.invalidateMetadata(config, targetDBName)
		return connection.QueryResult{
			Success: true,
			Message: a.appText("db.backend.message.view_copied", map[string]any{
				"source": sourceViewName,
				"target": targetName,
			}),
			Data: targetName,
		}
	}

	return connection.QueryResult{
		Success: false,
		Message: a.appText("db.backend.error.view_copy_create_failed", map[string]any{
			"source": sourceViewName,
			"target": targetName,
			"error":  "too many concurrent target-name conflicts",
		}),
	}
}

func resolveCopyViewTargetScope(
	dbType string,
	sourceDBName string,
	targetDBName string,
	targetSchemaName string,
	sourceSchemaName string,
) (string, bool) {
	targetDB := strings.TrimSpace(targetDBName)
	targetSchema := strings.TrimSpace(targetSchemaName)
	sourceSchema := strings.TrimSpace(sourceSchemaName)
	switch dbType {
	case "mysql", "mariadb", "oceanbase", "diros", "starrocks", "sphinx", "clickhouse":
		return targetDB, targetDB != ""
	case "postgres", "kingbase", "highgo", "vastbase", "opengauss", "gaussdb", "gbase8c":
		if targetSchema != "" {
			return targetSchema, true
		}
		if sourceSchema != "" {
			return sourceSchema, true
		}
		return "public", true
	case "sqlserver":
		if targetSchema != "" {
			return targetSchema, true
		}
		if sourceSchema != "" {
			return sourceSchema, true
		}
		return "dbo", true
	case "oracle", "dameng":
		if targetSchema != "" {
			return targetSchema, true
		}
		if targetDB != "" {
			return targetDB, true
		}
		return sourceSchema, sourceSchema != ""
	case "sqlite", "duckdb":
		return "", strings.EqualFold(strings.TrimSpace(sourceDBName), targetDB)
	default:
		if targetSchema != "" {
			return targetSchema, true
		}
		if targetDB != "" {
			return targetDB, true
		}
		return sourceSchema, sourceSchema != ""
	}
}

func rewriteCreateViewTarget(viewDDL string, targetRef string) (string, bool) {
	indexes := createViewTargetPattern.FindStringSubmatchIndex(viewDDL)
	if len(indexes) < 4 || indexes[2] < 0 || indexes[3] < 0 {
		return "", false
	}
	return viewDDL[:indexes[3]] + targetRef + viewDDL[indexes[1]:], true
}

func viewLookupHasTarget(
	viewLookup map[string]string,
	dbType string,
	schemaName string,
	targetName string,
) bool {
	for _, fullName := range viewLookup {
		gotSchema, gotName := db.SplitSQLQualifiedNameForDialect(fullName, dbType)
		if gotName == "" {
			gotName = fullName
		}
		if !strings.EqualFold(stripViewIdentifierQuotes(gotName), targetName) {
			continue
		}
		if schemaName == "" {
			return true
		}
		if gotSchema == "" || strings.EqualFold(stripViewIdentifierQuotes(gotSchema), schemaName) {
			return true
		}
	}
	return false
}

func stripViewIdentifierQuotes(value string) string {
	trimmed := strings.TrimSpace(value)
	if len(trimmed) < 2 {
		return trimmed
	}
	switch {
	case trimmed[0] == '`' && trimmed[len(trimmed)-1] == '`':
		return strings.ReplaceAll(trimmed[1:len(trimmed)-1], "``", "`")
	case trimmed[0] == '"' && trimmed[len(trimmed)-1] == '"':
		return strings.ReplaceAll(trimmed[1:len(trimmed)-1], `""`, `"`)
	case trimmed[0] == '[' && trimmed[len(trimmed)-1] == ']':
		return strings.ReplaceAll(trimmed[1:len(trimmed)-1], "]]", "]")
	default:
		return trimmed
	}
}
