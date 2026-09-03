package app

import (
	"crypto/sha256"
	"errors"
	"fmt"
	"strconv"
	"strings"
	"unicode/utf8"

	"GoNavi-Wails/internal/connection"
	"GoNavi-Wails/internal/db"
	"GoNavi-Wails/internal/logger"
)

const maxCopyTableCreateAttempts = 1000

type copyTablePlan struct {
	createSQL      string
	insertSQL      string
	dropSQL        string
	postStatements []copyTablePostStatement
}

type copyTablePostStatement struct {
	sql                    string
	createdSequenceDropSQL string
}

type copyTableColumnMetadata struct {
	writableColumns []string
	serialColumns   []string
	identityColumns []string
	sequenceOptions map[string]postgresCopyTableSequenceOptions
}

type postgresCopyTableSequenceOptions struct {
	dataType  string
	start     int64
	increment int64
	min       int64
	max       int64
	cache     int64
	cycle     bool
}

var errCopyTableColumnsMissing = errors.New("copy table column metadata is empty")

// CopyTable creates a same-schema table copy and fills it with all source rows.
// The target name starts at <source>_copy1 and advances when that name exists.
func (a *App) CopyTable(config connection.ConnectionConfig, dbName string, sourceSchemaName string, sourceTableName string) (result connection.QueryResult) {
	auditSQL := fmt.Sprintf("COPY TABLE %s", strings.TrimSpace(sourceTableName))
	defer a.beginSQLAuditUserAction(config, dbName, "object_editor", &auditSQL, &result)()

	sourceTableName = strings.TrimSpace(sourceTableName)
	if sourceTableName == "" {
		return connection.QueryResult{Success: false, Message: a.appText("db.backend.error.table_name_required", nil)}
	}
	if err := ensureConnectionAllowsStructureEdit(config, "connection.backend.action.copy_table"); err != nil {
		return connection.QueryResult{Success: false, Message: err.Error()}
	}
	if err := ensureConnectionAllowsDataImport(config, "connection.backend.action.copy_table"); err != nil {
		return connection.QueryResult{Success: false, Message: err.Error()}
	}

	dbType := resolveDDLDBType(config)
	if strings.EqualFold(strings.TrimSpace(config.Type), "custom") {
		dbType = "custom"
	}
	if !supportsCopyTableDBType(dbType) {
		return connection.QueryResult{
			Success: false,
			Message: a.appText("db.backend.error.table_copy_unsupported", map[string]any{
				"source": sourceTableName,
				"dbType": dbType,
			}),
		}
	}

	schemaName, sourceName := normalizeCopyTableSource(dbType, dbName, sourceSchemaName, sourceTableName)
	if sourceName == "" {
		return connection.QueryResult{Success: false, Message: a.appText("db.backend.error.table_name_required", nil)}
	}

	runConfig := buildRunConfigForDDL(config, dbType, dbName)
	dbInst, err := a.getDatabase(runConfig)
	if err != nil {
		return connection.QueryResult{Success: false, Message: err.Error()}
	}

	if safetyErr := ensureCopyTableSourceIsIndependent(dbInst, dbType, schemaName, sourceName); safetyErr != nil {
		return connection.QueryResult{
			Success: false,
			Message: a.appText("db.backend.error.table_copy_unsafe_storage", map[string]any{
				"source": sourceTableName,
				"detail": safetyErr.Error(),
			}),
		}
	}

	columnMetadata, columnsErr := resolveCopyTableColumnMetadata(dbInst, dbType, schemaName, sourceName)
	if columnsErr != nil {
		targetName := buildCopyTableTargetName(dbType, sourceName, 1)
		errorMessage := columnsErr.Error()
		if errors.Is(columnsErr, errCopyTableColumnsMissing) {
			errorMessage = a.appText("db.backend.error.table_columns_missing_for_ddl", nil)
		}
		return connection.QueryResult{
			Success: false,
			Message: a.appText("db.backend.error.table_copy_create_failed", map[string]any{
				"source": sourceTableName,
				"target": targetName,
				"error":  errorMessage,
			}),
		}
	}
	var (
		targetName string
		plan       copyTablePlan
	)
	for attempt := 0; attempt < maxCopyTableCreateAttempts; attempt++ {
		targetName = buildCopyTableTargetName(dbType, sourceName, attempt+1)
		plan = buildCopyTablePlan(dbType, schemaName, sourceName, targetName, columnMetadata)
		auditStatements := []string{plan.createSQL, plan.insertSQL}
		for _, statement := range plan.postStatements {
			auditStatements = append(auditStatements, statement.sql)
		}
		auditSQL = strings.Join(auditStatements, ";\n")

		if _, createErr := dbInst.Exec(plan.createSQL); createErr != nil {
			if isCopyTableAlreadyExistsError(createErr) {
				continue
			}
			return connection.QueryResult{
				Success: false,
				Message: a.appText("db.backend.error.table_copy_create_failed", map[string]any{
					"source": sourceTableName,
					"target": targetName,
					"error":  createErr.Error(),
				}),
			}
		}

		if _, insertErr := dbInst.Exec(plan.insertSQL); insertErr != nil {
			if cleanupErr := cleanupFailedCopyTable(dbInst, plan.dropSQL, nil); cleanupErr != nil {
				logger.Warnf("CopyTable 数据复制失败且清理目标表失败：source=%s target=%s copyErr=%v cleanupErr=%v", sourceTableName, targetName, insertErr, cleanupErr)
				return connection.QueryResult{
					Success: false,
					Message: a.appText("db.backend.error.table_copy_cleanup_failed", map[string]any{
						"source": sourceTableName,
						"target": targetName,
						"error":  fmt.Sprintf("%v; %v", insertErr, cleanupErr),
					}),
				}
			}
			return connection.QueryResult{
				Success: false,
				Message: a.appText("db.backend.error.table_copy_data_failed", map[string]any{
					"source": sourceTableName,
					"target": targetName,
					"error":  insertErr.Error(),
				}),
			}
		}

		createdSequenceDropSQLs := make([]string, 0, len(columnMetadata.serialColumns))
		for _, statement := range plan.postStatements {
			if _, postErr := dbInst.Exec(statement.sql); postErr != nil {
				cleanupErr := cleanupFailedCopyTable(dbInst, plan.dropSQL, createdSequenceDropSQLs)
				if cleanupErr != nil {
					logger.Warnf("CopyTable 完成复制状态失败且清理目标表失败：source=%s target=%s copyErr=%v cleanupErr=%v", sourceTableName, targetName, postErr, cleanupErr)
					return connection.QueryResult{
						Success: false,
						Message: a.appText("db.backend.error.table_copy_cleanup_failed", map[string]any{
							"source": sourceTableName,
							"target": targetName,
							"error":  fmt.Sprintf("%v; %v", postErr, cleanupErr),
						}),
					}
				}
				return connection.QueryResult{
					Success: false,
					Message: a.appText("db.backend.error.table_copy_data_failed", map[string]any{
						"source": sourceTableName,
						"target": targetName,
						"error":  postErr.Error(),
					}),
				}
			}
			if statement.createdSequenceDropSQL != "" {
				createdSequenceDropSQLs = append(createdSequenceDropSQLs, statement.createdSequenceDropSQL)
			}
		}

		return connection.QueryResult{
			Success: true,
			Message: a.appText("db.backend.message.table_copied", map[string]any{
				"source": sourceTableName,
				"target": targetName,
			}),
			Data: targetName,
		}
	}

	return connection.QueryResult{
		Success: false,
		Message: a.appText("db.backend.error.table_copy_create_failed", map[string]any{
			"source": sourceTableName,
			"target": targetName,
			"error":  "too many concurrent target-name conflicts",
		}),
	}
}

func supportsCopyTableDBType(dbType string) bool {
	switch dbType {
	case "mysql", "mariadb", "oceanbase", "postgres":
		return true
	default:
		return false
	}
}

func normalizeCopyTableSource(dbType string, dbName string, sourceSchemaName string, sourceTableName string) (string, string) {
	databaseName := strings.TrimSpace(dbName)
	schemaName := strings.TrimSpace(sourceSchemaName)
	sourceName := strings.TrimSpace(sourceTableName)
	switch dbType {
	case "mysql", "mariadb", "oceanbase":
		return databaseName, sourceName
	case "postgres":
		if schemaName == "" {
			return normalizeSchemaAndTableByType(dbType, databaseName, sourceName)
		}
		if parsedSchema, parsedTable := db.SplitSQLQualifiedNameForDialect(sourceName, dbType); parsedSchema == schemaName && parsedTable != "" {
			return schemaName, parsedTable
		}
		if prefix := schemaName + "."; strings.HasPrefix(sourceName, prefix) {
			return schemaName, strings.TrimPrefix(sourceName, prefix)
		}
		return schemaName, sourceName
	default:
		return normalizeSchemaAndTableByType(dbType, databaseName, sourceName)
	}
}

func buildCopyTablePlan(dbType string, schemaName string, sourceName string, targetName string, metadata copyTableColumnMetadata) copyTablePlan {
	sourceTable := quoteTableIdentByType(dbType, schemaName, sourceName)
	targetTable := quoteTableIdentByType(dbType, schemaName, targetName)
	columnClause, selectClause := buildCopyTableColumnClauses(dbType, metadata.writableColumns)

	plan := copyTablePlan{
		insertSQL: fmt.Sprintf("INSERT INTO %s%s SELECT %s FROM %s", targetTable, columnClause, selectClause, sourceTable),
		dropSQL:   fmt.Sprintf("DROP TABLE %s", targetTable),
	}
	switch dbType {
	case "postgres":
		plan.createSQL = fmt.Sprintf("CREATE TABLE %s (LIKE %s INCLUDING ALL)", targetTable, sourceTable)
		plan.insertSQL = fmt.Sprintf("INSERT INTO %s%s OVERRIDING SYSTEM VALUE SELECT %s FROM %s", targetTable, columnClause, selectClause, sourceTable)
		plan.postStatements = buildPostgresCopyTablePostStatements(schemaName, targetName, metadata)
	default:
		plan.createSQL = fmt.Sprintf("CREATE TABLE %s LIKE %s", targetTable, sourceTable)
	}
	return plan
}

func buildCopyTableColumnClauses(dbType string, columns []string) (string, string) {
	if len(columns) == 0 {
		return "", "*"
	}
	quoted := make([]string, 0, len(columns))
	for _, column := range columns {
		if name := strings.TrimSpace(column); name != "" {
			quoted = append(quoted, quoteIdentByType(dbType, name))
		}
	}
	if len(quoted) == 0 {
		return "", "*"
	}
	joined := strings.Join(quoted, ", ")
	return " (" + joined + ")", joined
}

func resolveCopyTableColumnMetadata(dbInst db.Database, dbType string, schemaName string, sourceName string) (copyTableColumnMetadata, error) {
	var metadata copyTableColumnMetadata
	metadataTableName := sourceName
	if dbType == "mysql" || dbType == "mariadb" || dbType == "oceanbase" {
		metadataTableName = quoteIdentByType(dbType, sourceName)
	}
	columns, err := dbInst.GetColumns(schemaName, metadataTableName)
	if err != nil {
		return metadata, err
	}
	if len(columns) == 0 {
		return metadata, errCopyTableColumnsMissing
	}
	traits, traitsErr := resolvePostgresCopyTableColumnTraits(dbInst, dbType, schemaName, sourceName)
	if traitsErr != nil {
		return metadata, traitsErr
	}
	metadata.writableColumns = make([]string, 0, len(columns))
	for _, column := range columns {
		name := strings.TrimSpace(column.Name)
		if name == "" || isGeneratedCopyTableColumn(column.Extra) {
			continue
		}
		trait := traits[name]
		if trait.generated {
			continue
		}
		metadata.writableColumns = append(metadata.writableColumns, name)
		if dbType != "postgres" {
			continue
		}
		if trait.identity {
			metadata.identityColumns = append(metadata.identityColumns, name)
			continue
		}
		if column.Default != nil && strings.HasPrefix(strings.ToLower(strings.TrimSpace(*column.Default)), "nextval(") {
			metadata.serialColumns = append(metadata.serialColumns, name)
		}
	}
	if len(metadata.writableColumns) == 0 {
		return copyTableColumnMetadata{}, errCopyTableColumnsMissing
	}
	if dbType == "postgres" {
		metadata.sequenceOptions = make(map[string]postgresCopyTableSequenceOptions, len(metadata.serialColumns)+len(metadata.identityColumns))
		sequenceColumns := append(append([]string{}, metadata.serialColumns...), metadata.identityColumns...)
		for _, columnName := range sequenceColumns {
			options, sequenceErr := resolvePostgresCopyTableSequenceOptions(dbInst, schemaName, sourceName, columnName)
			if sequenceErr != nil {
				return copyTableColumnMetadata{}, sequenceErr
			}
			metadata.sequenceOptions[columnName] = options
		}
	}
	return metadata, nil
}

type postgresCopyTableColumnTrait struct {
	generated bool
	identity  bool
}

func resolvePostgresCopyTableColumnTraits(dbInst db.Database, dbType string, schemaName string, sourceName string) (map[string]postgresCopyTableColumnTrait, error) {
	if dbType != "postgres" {
		return nil, nil
	}

	traits := map[string]postgresCopyTableColumnTrait{}
	query := fmt.Sprintf(`
	SELECT a.attname AS column_name,
	       COALESCE(pg_catalog.to_jsonb(a)->>'attgenerated', '') AS generated_kind,
	       COALESCE(pg_catalog.to_jsonb(a)->>'attidentity', '') AS identity_kind
	FROM pg_catalog.pg_attribute a
	JOIN pg_catalog.pg_class c ON c.oid = a.attrelid
	JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
	WHERE n.nspname = %s
	  AND c.relname = %s
	  AND a.attnum > 0
	  AND NOT a.attisdropped`, postgresCopyTableSQLLiteral(schemaName), postgresCopyTableSQLLiteral(sourceName))
	rows, _, err := dbInst.Query(query)
	if err != nil {
		return nil, err
	}
	for _, row := range rows {
		name := copyTableColumnNameFromRow(row)
		if name == "" {
			continue
		}
		trait := postgresCopyTableColumnTrait{
			generated: copyTableRowString(row, "generated_kind") != "",
			identity:  copyTableRowString(row, "identity_kind") != "",
		}
		if trait.generated || trait.identity {
			traits[name] = trait
		}
	}
	return traits, nil
}

func resolvePostgresCopyTableSequenceOptions(dbInst db.Database, schemaName string, sourceName string, columnName string) (postgresCopyTableSequenceOptions, error) {
	var options postgresCopyTableSequenceOptions
	sourceTable := quoteTableIdentByType("postgres", schemaName, sourceName)
	query := fmt.Sprintf(`
SELECT pg_catalog.format_type(s.seqtypid, NULL) AS data_type,
       s.seqstart,
       s.seqincrement,
       s.seqmin,
       s.seqmax,
       s.seqcache,
       s.seqcycle
FROM pg_catalog.pg_sequence s
WHERE s.seqrelid = pg_catalog.pg_get_serial_sequence(%s, %s)::regclass`,
		postgresCopyTableSQLLiteral(sourceTable),
		postgresCopyTableSQLLiteral(columnName),
	)
	rows, _, err := dbInst.Query(query)
	if err != nil {
		return options, err
	}
	if len(rows) != 1 {
		return options, fmt.Errorf("sequence metadata not found for column %s", columnName)
	}
	options.dataType = strings.ToLower(copyTableRowString(rows[0], "data_type"))
	switch options.dataType {
	case "smallint", "integer", "bigint":
	default:
		return postgresCopyTableSequenceOptions{}, fmt.Errorf("unsupported sequence data type %q for column %s", options.dataType, columnName)
	}
	var parseErr error
	if options.start, parseErr = copyTableRowInt64(rows[0], "seqstart"); parseErr != nil {
		return postgresCopyTableSequenceOptions{}, parseErr
	}
	if options.increment, parseErr = copyTableRowInt64(rows[0], "seqincrement"); parseErr != nil || options.increment == 0 {
		if parseErr == nil {
			parseErr = errors.New("sequence increment cannot be zero")
		}
		return postgresCopyTableSequenceOptions{}, parseErr
	}
	if options.min, parseErr = copyTableRowInt64(rows[0], "seqmin"); parseErr != nil {
		return postgresCopyTableSequenceOptions{}, parseErr
	}
	if options.max, parseErr = copyTableRowInt64(rows[0], "seqmax"); parseErr != nil {
		return postgresCopyTableSequenceOptions{}, parseErr
	}
	if options.cache, parseErr = copyTableRowInt64(rows[0], "seqcache"); parseErr != nil || options.cache <= 0 {
		if parseErr == nil {
			parseErr = errors.New("sequence cache must be positive")
		}
		return postgresCopyTableSequenceOptions{}, parseErr
	}
	options.cycle = copyTableRowBool(rows[0], "seqcycle")
	return options, nil
}

func isGeneratedCopyTableColumn(extra string) bool {
	normalized := strings.ToLower(strings.Join(strings.Fields(extra), " "))
	return strings.Contains(normalized, "virtual generated") ||
		strings.Contains(normalized, "stored generated") ||
		normalized == "generated" ||
		normalized == "materialized" ||
		normalized == "alias"
}

func ensureCopyTableSourceIsIndependent(dbInst db.Database, dbType string, schemaName string, sourceName string) error {
	switch dbType {
	case "mysql", "mariadb", "oceanbase":
		query := fmt.Sprintf(
			"SELECT ENGINE AS engine FROM information_schema.tables WHERE HEX(TABLE_SCHEMA) = '%s' AND HEX(TABLE_NAME) = '%s' AND TABLE_TYPE = 'BASE TABLE' LIMIT 1",
			mysqlCopyTableMetadataHex(schemaName),
			mysqlCopyTableMetadataHex(sourceName),
		)
		rows, _, err := dbInst.Query(query)
		if err != nil {
			return fmt.Errorf("storage metadata: %w", err)
		}
		engine := ""
		if len(rows) > 0 {
			engine = strings.ToUpper(copyTableRowString(rows[0], "engine"))
		}
		if !isIndependentMySQLCopyTableEngine(engine) {
			if engine == "" {
				engine = "<unknown>"
			}
			return fmt.Errorf("ENGINE=%s", engine)
		}
		return nil
	case "postgres":
		query := fmt.Sprintf(`
SELECT c.relkind AS relation_kind,
       c.relpersistence AS persistence,
       c.relrowsecurity AS row_security
FROM pg_catalog.pg_class c
JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = %s
  AND c.relname = %s
LIMIT 1`, postgresCopyTableSQLLiteral(schemaName), postgresCopyTableSQLLiteral(sourceName))
		rows, _, err := dbInst.Query(query)
		if err != nil {
			return fmt.Errorf("storage metadata: %w", err)
		}
		if len(rows) == 0 {
			return errors.New("relation metadata not found")
		}
		relationKind := copyTableRowString(rows[0], "relation_kind")
		if relationKind != "r" {
			return fmt.Errorf("relation_kind=%s", relationKind)
		}
		persistence := copyTableRowString(rows[0], "persistence")
		if persistence != "" && persistence != "p" {
			return fmt.Errorf("persistence=%s", persistence)
		}
		if copyTableRowBool(rows[0], "row_security") {
			return errors.New("row_level_security=enabled")
		}
		return nil
	default:
		return nil
	}
}

func isIndependentMySQLCopyTableEngine(engine string) bool {
	switch strings.ToUpper(strings.TrimSpace(engine)) {
	case "INNODB", "MYISAM", "MEMORY", "ARCHIVE", "CSV", "NDB", "NDBCLUSTER", "ARIA", "ROCKSDB", "TOKUDB", "COLUMNSTORE":
		return true
	default:
		return false
	}
}

func copyTableRowString(row map[string]interface{}, expectedKey string) string {
	for key, value := range row {
		if strings.EqualFold(strings.TrimSpace(key), expectedKey) && value != nil {
			return strings.TrimSpace(fmt.Sprintf("%v", value))
		}
	}
	return ""
}

func copyTableRowBool(row map[string]interface{}, expectedKey string) bool {
	switch strings.ToLower(copyTableRowString(row, expectedKey)) {
	case "1", "t", "true", "yes", "on":
		return true
	default:
		return false
	}
}

func copyTableRowInt64(row map[string]interface{}, expectedKey string) (int64, error) {
	value := copyTableRowString(row, expectedKey)
	parsed, err := strconv.ParseInt(value, 10, 64)
	if err != nil {
		return 0, fmt.Errorf("invalid %s value %q: %w", expectedKey, value, err)
	}
	return parsed, nil
}

func buildPostgresCopyTablePostStatements(schemaName string, targetName string, metadata copyTableColumnMetadata) []copyTablePostStatement {
	targetTable := quoteTableIdentByType("postgres", schemaName, targetName)
	statements := make([]copyTablePostStatement, 0, len(metadata.serialColumns)*4+len(metadata.identityColumns))
	for _, columnName := range metadata.serialColumns {
		quotedColumn := quoteIdentByType("postgres", columnName)
		options := metadata.sequenceOptions[columnName]
		sequenceName := buildPostgresCopyTableSequenceName(targetName, columnName)
		qualifiedSequence := quoteTableIdentByType("postgres", schemaName, sequenceName)
		sequenceRegclass := fmt.Sprintf("%s::regclass", postgresCopyTableSQLLiteral(qualifiedSequence))
		cycleClause := "NO CYCLE"
		if options.cycle {
			cycleClause = "CYCLE"
		}
		statements = append(statements,
			copyTablePostStatement{
				sql: fmt.Sprintf(
					"CREATE SEQUENCE %s AS %s INCREMENT BY %d MINVALUE %d MAXVALUE %d START WITH %d CACHE %d %s",
					qualifiedSequence,
					options.dataType,
					options.increment,
					options.min,
					options.max,
					options.start,
					options.cache,
					cycleClause,
				),
				createdSequenceDropSQL: fmt.Sprintf("DROP SEQUENCE IF EXISTS %s", qualifiedSequence),
			},
			copyTablePostStatement{sql: fmt.Sprintf("ALTER SEQUENCE %s OWNED BY %s.%s", qualifiedSequence, targetTable, quotedColumn)},
			copyTablePostStatement{sql: fmt.Sprintf("ALTER TABLE %s ALTER COLUMN %s SET DEFAULT pg_catalog.nextval(%s)", targetTable, quotedColumn, sequenceRegclass)},
			copyTablePostStatement{sql: buildPostgresCopyTableSetvalSQL(sequenceRegclass, targetTable, quotedColumn, options)},
		)
	}
	for _, columnName := range metadata.identityColumns {
		quotedColumn := quoteIdentByType("postgres", columnName)
		options := metadata.sequenceOptions[columnName]
		sequenceRegclass := fmt.Sprintf(
			"COALESCE(pg_catalog.pg_get_serial_sequence(%s, %s), '')::regclass",
			postgresCopyTableSQLLiteral(targetTable),
			postgresCopyTableSQLLiteral(columnName),
		)
		statements = append(statements, copyTablePostStatement{
			sql: buildPostgresCopyTableSetvalSQL(sequenceRegclass, targetTable, quotedColumn, options),
		})
	}
	return statements
}

func buildPostgresCopyTableSetvalSQL(sequenceRegclass string, targetTable string, quotedColumn string, options postgresCopyTableSequenceOptions) string {
	aggregate := "pg_catalog.max"
	if options.increment < 0 {
		aggregate = "pg_catalog.min"
	}
	return fmt.Sprintf(
		"SELECT pg_catalog.setval(%s, COALESCE((SELECT %s(%s) FROM %s), %d), EXISTS (SELECT 1 FROM %s))",
		sequenceRegclass,
		aggregate,
		quotedColumn,
		targetTable,
		options.start,
		targetTable,
	)
}

func buildPostgresCopyTableSequenceName(targetName string, columnName string) string {
	hash := sha256.Sum256([]byte(targetName + "\x00" + columnName))
	suffix := fmt.Sprintf("_copyseq_%x", hash[:5])
	prefix := strings.Trim(strings.TrimSpace(targetName)+"_"+strings.TrimSpace(columnName), "_")
	return truncateUTF8Bytes(prefix, 63-len(suffix)) + suffix
}

func copyTableColumnNameFromRow(row map[string]interface{}) string {
	for key, value := range row {
		if strings.EqualFold(strings.TrimSpace(key), "column_name") && value != nil {
			return strings.TrimSpace(fmt.Sprintf("%v", value))
		}
	}
	return ""
}

func mysqlCopyTableMetadataHex(value string) string {
	return fmt.Sprintf("%X", []byte(value))
}

func postgresCopyTableSQLLiteral(value string) string {
	for suffix := 0; ; suffix++ {
		tag := fmt.Sprintf("$gonavi_copy_%d$", suffix)
		if !strings.Contains(value, tag) {
			return tag + value + tag
		}
	}
}

func cleanupFailedCopyTable(dbInst db.Database, dropTableSQL string, createdSequenceDropSQLs []string) error {
	cleanupErrors := make([]error, 0, len(createdSequenceDropSQLs)+1)
	if _, err := dbInst.Exec(dropTableSQL); err != nil {
		cleanupErrors = append(cleanupErrors, err)
	}
	for index := len(createdSequenceDropSQLs) - 1; index >= 0; index-- {
		if _, err := dbInst.Exec(createdSequenceDropSQLs[index]); err != nil {
			cleanupErrors = append(cleanupErrors, err)
		}
	}
	return errors.Join(cleanupErrors...)
}

func buildCopyTableTargetName(dbType string, sourceName string, suffix int) string {
	suffixText := "_copy" + strconv.Itoa(suffix)
	switch dbType {
	case "postgres":
		return truncateUTF8Bytes(sourceName, 63-len(suffixText)) + suffixText
	case "mysql", "mariadb", "oceanbase":
		return truncateUTF8Runes(sourceName, 64-utf8.RuneCountInString(suffixText)) + suffixText
	default:
		return sourceName + suffixText
	}
}

func truncateUTF8Bytes(value string, maxBytes int) string {
	if maxBytes <= 0 {
		return ""
	}
	if len(value) <= maxBytes {
		return value
	}
	end := maxBytes
	for end > 0 && !utf8.ValidString(value[:end]) {
		end--
	}
	return value[:end]
}

func truncateUTF8Runes(value string, maxRunes int) string {
	if maxRunes <= 0 {
		return ""
	}
	runes := []rune(value)
	if len(runes) <= maxRunes {
		return value
	}
	return string(runes[:maxRunes])
}

func isCopyTableAlreadyExistsError(err error) bool {
	if err == nil {
		return false
	}
	message := strings.ToLower(err.Error())
	return strings.Contains(message, "already exists") ||
		strings.Contains(message, "duplicate table") ||
		strings.Contains(message, "sqlstate 42p07") ||
		strings.Contains(message, "error 1050")
}
