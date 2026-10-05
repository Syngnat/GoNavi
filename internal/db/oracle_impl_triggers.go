package db

import (
	"fmt"
	"strings"

	"GoNavi-Wails/internal/connection"
)

func (o *OracleDB) GetTriggers(dbName, tableName string) ([]connection.TriggerDefinition, error) {
	for _, candidate := range oracleMetadataNamePairs(dbName, tableName) {
		data, _, err := o.queryUnbounded(buildOracleTriggersQuery(candidate.schema, candidate.table))
		if err != nil {
			return nil, err
		}
		if len(data) == 0 {
			continue
		}
		return o.parseOracleTriggers(data), nil
	}
	return []connection.TriggerDefinition{}, nil
}

func buildOracleTriggersQuery(schema string, table string) string {
	metadataTableName := escapeOracleMetadataLiteralExact(table)
	metadataSchemaName := escapeOracleMetadataLiteralExact(schema)
	if strings.TrimSpace(schema) == "" {
		return fmt.Sprintf(`SELECT USER AS "OWNER", USER AS "TABLE_OWNER", table_name AS "TABLE_NAME", trigger_name AS "TRIGGER_NAME", trigger_type AS "TRIGGER_TYPE", triggering_event AS "TRIGGERING_EVENT", when_clause AS "WHEN_CLAUSE", trigger_body AS "TRIGGER_BODY"
		FROM user_triggers
		WHERE table_name = '%s'
		ORDER BY trigger_name`, metadataTableName)
	}
	return fmt.Sprintf(`SELECT owner AS "OWNER", table_owner AS "TABLE_OWNER", table_name AS "TABLE_NAME", trigger_name AS "TRIGGER_NAME", trigger_type AS "TRIGGER_TYPE", triggering_event AS "TRIGGERING_EVENT", when_clause AS "WHEN_CLAUSE", trigger_body AS "TRIGGER_BODY"
		FROM all_triggers
		WHERE table_owner = '%s' AND table_name = '%s'
		ORDER BY owner, trigger_name`,
		metadataSchemaName, metadataTableName)
}

func (o *OracleDB) parseOracleTriggers(data []map[string]interface{}) []connection.TriggerDefinition {
	var triggers []connection.TriggerDefinition
	for _, row := range data {
		owner := oracleRowString(row, "OWNER")
		triggerName := oracleRowString(row, "TRIGGER_NAME")
		statement := strings.TrimSpace(o.fetchOracleTriggerDDL(owner, triggerName))
		if statement == "" {
			statement = buildOracleTriggerDDLFromMetadata(row)
		}

		trig := connection.TriggerDefinition{
			Name:      triggerName,
			Timing:    oracleRowString(row, "TRIGGER_TYPE"),
			Event:     oracleRowString(row, "TRIGGERING_EVENT"),
			Statement: statement,
		}
		triggers = append(triggers, trig)
	}
	return triggers
}

func (o *OracleDB) fetchOracleTriggerDDL(owner string, triggerName string) string {
	if strings.TrimSpace(triggerName) == "" {
		return ""
	}
	for _, candidate := range oracleMetadataNamePairs(owner, triggerName) {
		metadataTriggerName := escapeOracleMetadataLiteralExact(candidate.table)
		metadataOwnerName := escapeOracleMetadataLiteralExact(candidate.schema)
		query := fmt.Sprintf("SELECT DBMS_METADATA.GET_DDL('TRIGGER', '%s', '%s') as ddl FROM DUAL",
			metadataTriggerName, metadataOwnerName)
		if candidate.schema == "" {
			query = fmt.Sprintf("SELECT DBMS_METADATA.GET_DDL('TRIGGER', '%s') as ddl FROM DUAL", metadataTriggerName)
		}

		data, _, err := o.queryUnbounded(query)
		if err != nil || len(data) == 0 {
			continue
		}
		ddl := oracleRowString(data[0], "DDL", "ddl", "TRIGGER_DEFINITION", "trigger_definition")
		if ddl != "" {
			return ensureOracleDDLStatementTerminator(stripOracleTriggerEnableStatement(ddl))
		}
	}
	return ""
}

func stripOracleTriggerEnableStatement(ddl string) string {
	trimmed := strings.TrimRight(ddl, " \t\r\n")
	match := oracleTriggerEnableStatementPattern.FindStringIndex(trimmed)
	if match == nil || match[1] != len(trimmed) {
		return trimmed
	}
	return strings.TrimRight(trimmed[:match[0]], " \t\r\n")
}

func buildOracleTriggerDDLFromMetadata(row map[string]interface{}) string {
	body := strings.TrimSpace(oracleRowString(row, "TRIGGER_BODY"))
	if body == "" || strings.EqualFold(body, "SOURCE HIDDEN") {
		return ""
	}

	if startsWithOracleTriggerCreate(body) {
		return ensureOracleDDLStatementTerminator(body)
	}

	triggerName := oracleRowString(row, "TRIGGER_NAME")
	if triggerName == "" {
		return ""
	}

	if strings.HasPrefix(strings.ToUpper(body), "TRIGGER ") {
		return ensureOracleDDLStatementTerminator("CREATE OR REPLACE " + body)
	}

	triggerOwner := oracleRowString(row, "OWNER")
	tableOwner := oracleRowString(row, "TABLE_OWNER")
	tableName := oracleRowString(row, "TABLE_NAME")
	triggerRef := quoteOracleTableRef(triggerOwner, triggerName)

	if startsWithOracleTriggerTiming(body) {
		return ensureOracleDDLStatementTerminator(fmt.Sprintf("CREATE OR REPLACE TRIGGER %s\n%s", triggerRef, body))
	}

	triggerClause := buildOracleTriggerClause(
		oracleRowString(row, "TRIGGER_TYPE"),
		oracleRowString(row, "TRIGGERING_EVENT"),
		oracleTriggerTableRef(tableOwner, tableName),
	)
	if triggerClause == "" {
		return ""
	}

	lines := []string{
		fmt.Sprintf("CREATE OR REPLACE TRIGGER %s", triggerRef),
		triggerClause,
	}
	if shouldAppendOracleForEachRow(oracleRowString(row, "TRIGGER_TYPE")) {
		lines = append(lines, "FOR EACH ROW")
	}
	if whenClause := normalizeOracleTriggerWhenClause(oracleRowString(row, "WHEN_CLAUSE")); whenClause != "" {
		lines = append(lines, whenClause)
	}
	lines = append(lines, body)
	return ensureOracleDDLStatementTerminator(strings.Join(lines, "\n"))
}

func startsWithOracleTriggerCreate(sql string) bool {
	return oracleTriggerCreatePattern.MatchString(sql)
}

func startsWithOracleTriggerTiming(sql string) bool {
	return oracleTriggerTimingPattern.MatchString(sql)
}

func oracleTriggerTableRef(tableOwner string, tableName string) string {
	if strings.TrimSpace(tableName) == "" {
		return ""
	}
	return quoteOracleTableRef(tableOwner, tableName)
}

func buildOracleTriggerClause(triggerType string, event string, tableRef string) string {
	normalizedType := strings.ToUpper(strings.TrimSpace(triggerType))
	normalizedEvent := strings.TrimSpace(event)
	if tableRef == "" || normalizedEvent == "" {
		return ""
	}

	switch {
	case strings.HasPrefix(normalizedType, "BEFORE"):
		return fmt.Sprintf("BEFORE %s ON %s", normalizedEvent, tableRef)
	case strings.HasPrefix(normalizedType, "AFTER"):
		return fmt.Sprintf("AFTER %s ON %s", normalizedEvent, tableRef)
	case strings.HasPrefix(normalizedType, "INSTEAD OF"):
		return fmt.Sprintf("INSTEAD OF %s ON %s", normalizedEvent, tableRef)
	case strings.Contains(normalizedType, "COMPOUND"):
		return fmt.Sprintf("FOR %s ON %s", normalizedEvent, tableRef)
	default:
		return fmt.Sprintf("%s %s ON %s", strings.TrimSpace(triggerType), normalizedEvent, tableRef)
	}
}

func shouldAppendOracleForEachRow(triggerType string) bool {
	normalizedType := strings.ToUpper(strings.TrimSpace(triggerType))
	return strings.Contains(normalizedType, "EACH ROW") && !strings.HasPrefix(normalizedType, "INSTEAD OF")
}

func normalizeOracleTriggerWhenClause(whenClause string) string {
	trimmed := strings.TrimSpace(whenClause)
	if trimmed == "" {
		return ""
	}
	if strings.HasPrefix(trimmed, "(") && strings.HasSuffix(trimmed, ")") {
		return "WHEN " + trimmed
	}
	return "WHEN (" + trimmed + ")"
}

func splitOracleQualifiedTableName(raw string) (string, string) {
	table := strings.TrimSpace(raw)
	schema := ""
	if parts := strings.SplitN(table, ".", 2); len(parts) == 2 {
		schema = strings.Trim(strings.TrimSpace(parts[0]), "\"")
		table = strings.TrimSpace(parts[1])
	}
	table = strings.Trim(strings.TrimSpace(table), "\"")
	return schema, table
}
